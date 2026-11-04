const $ = (s) => document.querySelector(s);
const serverMessage = message => ({
  'Origine non autorizzata': 'Unauthorized origin',
  'Richiesta non valida': 'Invalid request',
  'Impossibile leggere il file .env.': 'Unable to read the .env file.',
  'Aggiungi XAI_API_KEY nel file .env del progetto.': 'Add XAI_API_KEY to the project .env file.',
  'Impossibile ottenere il token xAI. Verifica chiave e account.': 'Unable to obtain an xAI token. Check your key and account.',
  'Connessione a xAI non disponibile.': 'Unable to connect to xAI.'
}[message] || message);
const pattern = $('#pattern');
const shapes = ['<circle cx="5" cy="5" r="4"/>','<path d="M5 0 10 5 5 10 0 5Z"/>','<path d="M5 0 10 9H0Z"/>','<path d="m5 0 4.3 2.5v5L5 10 .7 7.5v-5Z"/>','<path d="m5 0 1.8 3.2L10 5 6.8 6.8 5 10 3.2 6.8 0 5l3.2-1.8Z"/>'];
let symbols = [];
function drawPattern() {
  pattern.textContent = '';
  symbols = [];
  const spacing = innerWidth < 800 ? 24 : 36;
  const rows = Math.ceil(pattern.clientHeight / spacing);
  const cols = Math.ceil(pattern.clientWidth / spacing);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const el = document.createElement('span');
      el.className = 'symbol';
      el.style.left = `${col * spacing + 4}px`;
      el.style.top = `${row * spacing + 4}px`;
      el.innerHTML = `<svg viewBox="0 0 10 10">${shapes[(row * 3 + col * 7) % shapes.length]}</svg>`;
      const middle = Math.exp(-(((col / cols - .5) * 3) ** 2));
      const bottom = Math.round(rows * .70);
      const amplitude = 1 + middle * 2.5;
      if (Math.abs(row - bottom) < amplitude && (row + col) % 3 !== 0) el.classList.add('active');
      pattern.append(el);
      symbols.push({el, row, col, bottom, amplitude});
    }
  }
}
drawPattern();
new ResizeObserver(drawPattern).observe(pattern);
let frame = 0;
function animatePattern() {
  if (!context || !analyser) return;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let energy = 0;
  for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
  const volume = Math.min(1, Math.sqrt(energy / samples.length) * 6);
  for (const {el, row, col, bottom, amplitude} of symbols) {
    const spread = volume * amplitude * (1 + Math.sin(col * .6 + performance.now() / 220));
    el.classList.toggle('active', Math.abs(row - bottom) < .6 + spread && (row + col) % 3 !== 0);
  }
  frame = requestAnimationFrame(animatePattern);
}

let analyser;
let socket,stream,context,processor,source,playAt=0,playing=[], pending=[],activity=0, stopping=false;
let generation = 0;
let muted = false; // microphone off: no audio reaches Grok and new commands are ignored
function state(label, hint, connected=false) {
  const active = connected || label === 'CONNECTING…';
  $('#connection').textContent = label;
  $('#hint').textContent = hint;
  $('#voiceHint').textContent = hint;
  $('#startVoice').hidden = active;
  $('#closeButton').hidden = !active;
  $('#muteButton').hidden = !connected;
  $('#emptyState').hidden = active;
  $('#conversation').hidden = !active;
  $('.voice').classList.toggle('live', active);
  $('.voice').classList.toggle('listening', connected);
  if (active && !connected) { $('#headline').textContent = 'Grok'; $('#transcript').textContent = 'Connecting…'; }
}

function log(name,detail){if(!activity)$('#activity').textContent='';activity++;$('#count').textContent=String(activity).padStart(2,'0');const row=document.createElement('div');row.className='entry';const icon=document.createElement('span');icon.className='icon';icon.textContent='↗';const body=document.createElement('div');body.textContent=name;const sub=document.createElement('small');sub.textContent=detail;body.append(sub);row.append(icon,body);$('#activity').prepend(row)}
function send(obj){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(obj))}
function stopAudio(){for(const node of playing){try{node.stop()}catch{}}playing=[];playAt=0}
function disconnect(){generation++;stopping=true;cancelAnimationFrame(frame);analyser=null;stopAudio();processor?.disconnect();source?.disconnect();stream?.getTracks().forEach(t=>t.stop());context?.close();socket?.close();socket=stream=context=processor=source=null;pending=[];setMuted(false);$('#startVoice').disabled=false;state('READY TO CONNECT','What would you like to do?');drawPattern()}
function playback(base64){if(!context)return;const raw=atob(base64);const len=Math.floor(raw.length/2);const buf=context.createBuffer(1,len,24000);const data=buf.getChannelData(0);for(let i=0;i<len;i++){let n=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);if(n>=32768)n-=65536;data[i]=n/32768}const node=context.createBufferSource();node.buffer=buf;node.connect(context.destination);playAt=Math.max(context.currentTime,playAt);node.start(playAt);playAt+=buf.duration;playing.push(node);node.onended=()=>{playing=playing.filter(n=>n!==node)}}
// Microphone off: stop sending audio, drop what Grok already heard and cancel its reply.
function setMuted(value){
  muted=value;
  const button=$('#muteButton');
  button.setAttribute('aria-pressed',String(value));
  button.setAttribute('aria-label',value?'Turn microphone on':'Turn microphone off');
  button.title=value?'Microphone off. Tap to turn it on':'Turn microphone off';
  button.classList.toggle('muted',value);
  $('.voice').classList.toggle('muted',value);
  if(value){send({type:'input_audio_buffer.clear'});send({type:'response.cancel'});stopAudio();$('#hint').textContent='Microphone off. Grok cannot hear you.'}
  else if(socket)$('#hint').textContent='Speak to Grok';
}

// Emergency controls skip the command queue on the server and cancel what is waiting.
async function emergency(kind){
  const label=kind==='motors'?'Motors cut':'Switch off';
  $('#safetyStatus').textContent=kind==='motors'?'Cutting motors…':'Landing…';
  if(socket)disconnect(); // no more voice commands after an emergency
  try{
    const response=await fetch('/api/emergency',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind})});
    const result=await response.json();
    $('#safetyStatus').textContent=result.ok?(kind==='motors'?'Motors stopped':'Landed'):serverMessage(result.error)||'Failed';
    log(`Tello · ${label}`,result.ok?'Done':`Failed · ${serverMessage(result.error)}`);
  }catch{$('#safetyStatus').textContent='Server unreachable'}
  await refreshDrone();
}
$('#switchOff').addEventListener('click',()=>emergency('land'));
// Cutting the motors drops the drone, so the button needs a second tap within 2 s.
let killArmed=0;
$('#killMotors').addEventListener('click',()=>{
  if(Date.now()-killArmed<2000){killArmed=0;$('#killMotors').textContent='Cut motors';emergency('motors');return}
  killArmed=Date.now();$('#killMotors').textContent='Tap again to cut';
  setTimeout(()=>{if(killArmed&&Date.now()-killArmed>=2000){killArmed=0;$('#killMotors').textContent='Cut motors'}},2100);
});
$('#muteButton').addEventListener('click',()=>setMuted(!muted));

// Two real drones. Grok names them by colour; the server knows them as tello and rmtt.
const FLEET={black:{id:'tello',name:'Drone 1 · Black',model:'Tello EDU'},red:{id:'rmtt',name:'Drone 2 · Red',model:'RoboMaster TT'}};
const nameOf=id=>Object.values(FLEET).find(d=>d.id===id)?.name||id;
let drones=[]; // from /api/drones: each drone with owner {state: mine | other | lost | claiming | waiting}
// Another laptop flies this drone: it is see-only here, emergency included.
const seeOnly=d=>['other','lost'].includes(d?.owner?.state);
const ownedIds=()=>drones.filter(d=>d.owner?.state==='mine').map(d=>d.id);
const ownedColours=()=>Object.keys(FLEET).filter(c=>ownedIds().includes(FLEET[c].id));
// Every voice action goes to a real drone through the local server.
const actionLabels={approach:'Approach',release:'Released',photo:'Photo',emergency:'Motors cut',takeoff:'Takeoff',land:'Landing',move:'Move',rotate:'Rotation',flip:'Flip',speed:'Speed',stop:'Stop',status:'Status',test_flight:'Test flight',scan:'360° scan',look:'Look'};
// Each drone has its own queue: commands for Black and Red run at the same time, and a
// sequence for one drone keeps its order. Tools answer Grok at once ("started"); when the
// drone finishes, Grok gets an automatic update. land, stop and emergency skip the queue.
const URGENT=['land','stop','emergency'];
const droneQueues={};
let responding=false, wantResponse=false;
function requestResponse(){ if(muted) return; if(responding){wantResponse=true;return} wantResponse=false; send({type:'response.create'}) }
// speak=false: Grok learns the result but stays silent (a finished action needs no comment).
function notifyGrok(text,speak=true){
  send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:`(automatic drone update, not said by the person${speak?'':'; do not reply to this'}) ${text}`}]}});
  if(speak) requestResponse();
}
// Actions whose success needs no words; answers to questions and every failure are spoken.
const SILENT_WHEN_OK=['takeoff','land','move','rotate','flip','speed','stop','test_flight','release','emergency'];
async function runOnDrone(id,name,rest){
  try {
    // droneId and action go last so the model's arguments cannot override them.
    const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...rest,droneId:id,action:name})});
    const result=await response.json();
    return response.ok?result:{ok:false,mode:'real',error:serverMessage(result.error)||'Server unavailable'};
  } catch { return {ok:false,mode:'real',error:'Server unreachable'}; }
}
// A photo taken by voice shows over the page for a few seconds (tap to close).
let photoTimer=0;
function showPhoto(url,label){
  const box=$('#photoView');
  box.querySelector('img').src=url;
  box.querySelector('p').textContent=label;
  box.hidden=false;
  clearTimeout(photoTimer);
  photoTimer=setTimeout(()=>{box.hidden=true},10000);
}
$('#photoView').addEventListener('click',()=>{$('#photoView').hidden=true});
function dispatch(name,args,failed,run){
  // Grok can still finish a reply after the microphone went off; only safety commands run then.
  if(muted&&!URGENT.includes(name)) return {ok:false,mode:'real',error:'Microphone is off; command ignored'};
  if(name==='mute'){setMuted(true);log('Grok · Microphone off','Done');return {ok:true,action:'mute'}}
  const {drone:colour,...rest}=args;
  // Natural commands: "vai a destra" moves 50 cm, "ruota" turns 90 degrees clockwise.
  if(name==='move'&&rest.centimeters===undefined) rest.centimeters=50;
  if(name==='rotate'){rest.direction??='clockwise';rest.degrees??=90}
  // Emergency without a named drone cuts the motors of every drone this laptop flies.
  if(name==='emergency'&&!colour){void emergency('motors');return {ok:true,action:'emergency',drones:'every drone this laptop flies'}}
  let ids;
  if(FLEET[colour]) ids=[FLEET[colour].id];
  else if(URGENT.includes(name)){
    // In a hurry nobody names the drone: every drone not known to be another laptop's. The page's
    // view can be a moment old, so the server decides; it refuses another laptop's drone.
    ids=Object.values(FLEET).map(f=>f.id).filter(id=>!seeOnly(drones.find(d=>d.id===id)));
    if(!ids.length) return {ok:false,mode:'real',error:'This laptop flies no drone right now'};
  }
  else return {ok:false,mode:'real',error:'Say which drone: black (Drone 1) or red (Drone 2)'};
  for(const id of ids){
    const label=`${nameOf(id)} · ${actionLabels[name]||name}`;
    const task=async()=>{
      if(run!==generation) return;
      if(failed.has(id)&&!URGENT.includes(name)){notifyGrok(`${label}: skipped because an earlier step for this drone failed`);return}
      const result=await runOnDrone(id,name,rest);
      if(!result.ok) failed.add(id);
      log(label,result.ok?'Done':`Rejected · ${serverMessage(result.error)}`);
      if(result.ok&&result.photo) showPhoto(result.photo,label);
      void refreshDrone();
      if(run!==generation) return;
      const {drone:snapshot,mode,ok,action,...details}=result;
      const quiet=result.ok&&SILENT_WHEN_OK.includes(name);
      // Telemetry goes along only when it was asked for (status); otherwise just the outcome.
      const facts=name==='status'&&snapshot?` battery ${snapshot.battery ?? '?'}% height ${snapshot.heightCm ?? '?'} cm ${snapshot.flight}`:'';
      notifyGrok(`${label}: ${result.ok?'done':'failed'}${quiet?'':` ${JSON.stringify(details).slice(0,700)}`}${facts}`,!quiet);
    };
    if(URGENT.includes(name)) void task();
    else droneQueues[id]=(droneQueues[id]??Promise.resolve()).then(task,task);
  }
  return {ok:true,status:'started',drones:ids.map(nameOf),note:'Running now; an automatic drone update will follow. Do not wait for it.'};
}

function finishCalls(){
  const run=generation;
  const calls=pending;
  pending=[];
  const failed=new Set(); // a failed step skips the later steps of the same drone in this batch
  for(const event of calls){
    if(run!==generation) return;
    let args=null;
    try {args=JSON.parse(event.arguments||'{}')} catch {}
    const output=args?dispatch(event.name,args,failed,run):{ok:false,mode:'real',error:'Invalid arguments'};
    send({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.call_id,output:JSON.stringify(output)}});
  }
  if(calls.length) requestResponse();
}
const tool=(name,description,properties={},required=[])=>({type:'function',name,description,parameters:{type:'object',properties,required,additionalProperties:false}});
const INSTRUCTIONS='You are Grok, the voice pilot of two real drones for Metoera: Drone 1, called Black (a Tello EDU), and Drone 2, called Red (a RoboMaster TT). Every drone tool takes drone: black or red. If the person does not say which drone and more than one could be meant, ask; never choose for them. If they say both or all, call the tool for black and for red in the same reply: they run at the same time. land and stop without a drone apply to every drone this laptop flies. If the person asks you to choose which drone to fly or land, call status on black and on red first and wait for both updates, prefer a connected drone that is on the ground with more battery for flying (at least 20 percent), say which one you picked and why, then act. If they ask to test the drones, propose a short plan (for example: status on both, test_flight on black, then test_flight on red), and run it step by step only after they agree. Each drone has its own camera with object detection: scan and look take drone black or red, and for both drones call them once per drone and report the result of each drone separately. Every tool call physically moves a drone, so do exactly what the person says: no extra steps, no skipped steps, no changed values. Speak in the language the person uses (usually Italian) and be very brief: do exactly what is asked and nothing more. Confirm a command with one or two words (for example: ok, fatto, decollo). Never mention battery, height, heading, distances, counts or other drone data unless the person asks for it, and then answer only that. Understand natural commands in Italian or English: destra = right, sinistra = left, avanti = forward, indietro = back, su = up, giù = down, ruota/gira = rotate, girati = rotate 180, fai una foto = photo, atterra = land, decolla = take off, fermati = stop. If no distance is given, move uses 50 cm; if no angle is given, rotate uses 90 degrees; a little = 30 cm, a lot = 100 cm. Only ask when the drone or the direction is really unclear. Convert units yourself: 1 meter = 100 centimeters, half a meter = 50. Turn right means clockwise, turn left means counterclockwise. Drone tools answer at once with status started: the drone works in the background and you receive an automatic drone update message when it is done or failed. Never wait for a drone before handling the next request: the two drones are independent and run at the same time, so you can command Red while Black is still busy. For a sequence on the same drone, call its tools in order in one go; they run in that order, and if one fails the rest for that drone is skipped. When a drone update says done for an action, stay silent. Speak about an update only when it failed (say why in one short sentence) or when it answers something the person asked. If the person says stop, wait, hold or freeze, call stop at once. If they say land, or sound alarmed, call land at once. If they just say fly or test flight, call test_flight. The drone has a camera with object detection. To count or find things all around (for example: do a 360 and count the people at the table), take off first if it is on the ground, then call scan with the object name in English (person for people). scan turns a full circle in four 90-degree steps and returns a count per view and a total; give the total, mention where they are if useful, and say it is approximate because someone at the edge between two views can be missed or counted twice. To say what is in front of the drone right now, or how many people it sees, call look (label person to count people); to count all around, scan. For a photo, call photo. To come toward someone or something (vieni verso la persona, avvicinati alla bottiglia), call approach with the object name in English (person by default); it stops about 1 m away, or the distance the person says (vicino = 60 cm). The drone must be flying; if it is on the ground, say so. Report only what the results contain; never invent objects. If the person says emergency, cut the motors or kill the motors, call emergency at once (leave drone empty to stop every drone this laptop flies): the motors stop and the drone drops. If they say stop listening, mute or microphone off, call mute; after that you hear nothing until they turn the microphone back on. Only say a drone did something when its drone update says done, and report rejections in plain words, including limits such as the maximum distance.';
const dir=(values)=>({type:'string',enum:values});
// Grok only gets the drones this laptop flies. Another laptop's drone is see-only: if this
// laptop flies none, the names stay listed so Grok can say who flies them, and the server refuses.
function droneParam(){
  const list=ownedColours().length?ownedColours():Object.keys(FLEET);
  return {type:'string',enum:list,description:list.map(c=>`${c} = ${FLEET[c].name} (${FLEET[c].model})`).join(', ')};
}
function ownershipNote(){
  const own=ownedColours();
  const others=Object.entries(FLEET).map(([c,f])=>[c,drones.find(d=>d.id===f.id)]).filter(([,d])=>seeOnly(d)).map(([c,d])=>`${c} is flown by another laptop (${d.owner.name})`);
  return ` This laptop flies: ${own.length?own.join(' and '):'no drone right now'}.${others.length?` ${others.join('; ')}: you cannot command it at all, not even land or emergency; if asked, say which laptop flies it.`:''}`;
}
const ownershipKey=()=>JSON.stringify([ownedColours(),drones.filter(seeOnly).map(d=>[d.id,d.owner.name]),drones.map(d=>[d.id,d.pilot?.name??'',d.pilot?.me??false]),myName]);
let sessionKey='';
// Other people on this same link: Grok must not try to move the drone they fly.
function pilotNote(){
  const busy=Object.entries(FLEET).map(([c,f])=>[c,drones.find(d=>d.id===f.id)]).filter(([,d])=>d?.pilot&&!d.pilot.me).map(([c,d])=>`${c} is flown by ${d.pilot.name}, another person on this link`);
  const yours=Object.entries(FLEET).filter(([,f])=>drones.find(d=>d.id===f.id)?.pilot?.me).map(([c])=>c);
  return `${myName?` You are talking to ${myName}.`:''}${yours.length?` ${myName||'This person'} flies ${yours.join(' and ')}.`:''}${busy.length?` ${busy.join('; ')}: only land, stop, emergency, status, look and photo work on it; for anything else say who flies it.`:''} The first person who moves a free drone becomes its pilot; release gives it back.`;
}
function sessionConfig(){ return {instructions:INSTRUCTIONS+ownershipNote()+pilotNote(),tools:buildTools()} }
// Every drone tool gets the drone parameter; mute is about the microphone, not a drone.
const droneTool=(name,description,properties={},required=[])=>tool(name,description,{drone:droneParam(),...properties},['emergency','land','stop'].includes(name)?required:['drone',...required]);
const buildTools=()=>[
  droneTool('takeoff','Take off and hover at about 80 cm'),
  droneTool('land','Land now'),
  droneTool('stop','Hover in place immediately, interrupting a move in progress'),
  droneTool('move','Move in a straight line: forward/back, left/right, up/down (avanti, indietro, sinistra, destra, su, giù). Without a distance it moves 50 cm',{direction:dir(['forward','back','left','right','up','down']),centimeters:{type:'integer',minimum:20,maximum:500,description:'Optional, default 50'}},['direction']),
  droneTool('rotate','Turn in place (ruota, gira). Right = clockwise, left = counterclockwise. Without an angle it turns 90 degrees; turn around = 180',{direction:dir(['clockwise','counterclockwise']),degrees:{type:'integer',minimum:1,maximum:360,description:'Optional, default 90'}},[]),
  droneTool('release','Give this drone back so another person on the link can fly it (lascia il drone, rilascia)'),
  droneTool('approach','Fly toward the person or object in front of the drone and stop at a safe distance (vieni verso, avvicinati, vai dalla persona). Uses the camera only; distances are estimates',{label:{type:'string',description:'Object class in English, default person'},stopCm:{type:'integer',minimum:50,maximum:300,description:'How far from it to stop, default 100'}},[]),
  droneTool('photo','Take a photo with the camera of this drone (with the object boxes) and show it on the page (fai una foto, scatta)'),
  droneTool('flip','Flip in a direction; needs at least 50% battery',{direction:dir(['left','right','forward','back'])},['direction']),
  droneTool('speed','Set the speed used by later moves',{cmPerSecond:{type:'integer',minimum:10,maximum:100}},['cmPerSecond']),
  droneTool('emergency','EMERGENCY: stop the motors immediately; the drone drops. Only when the person asks for an emergency or to cut the motors'),
  tool('mute','Turn the microphone off so you stop hearing the person'),
  droneTool('status','Read battery, height, heading and whether the drone is flying'),
  droneTool('test_flight','Take off, hover 5 seconds, then land'),
  droneTool('scan','Turn 360 degrees in four 90-degree steps and count one kind of object in the camera; drone must be flying',{label:{type:'string',description:'Object class in English, e.g. person, chair, bottle, cup, laptop'}},[]),
  droneTool('look','Describe what the camera sees right now (object counts and left/center/right)',{label:{type:'string',description:'Optional object class to filter on'}},[]),
];
async function start(){const run=++generation;state('CONNECTING…','Connecting voice session.');$('#startVoice').disabled=true;stopping=false;try{const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});if(run!==generation){acquired.getTracks().forEach(t=>t.stop());return}stream=acquired;context=new AudioContext({sampleRate:24000});await context.resume();if(run!==generation)return;const tokenResponse=await fetch('/session',{method:'POST'});const token=await tokenResponse.json();if(run!==generation)return;if(!tokenResponse.ok)throw Error(serverMessage(token.error)||'Token unavailable');if(!token.value)throw Error('Invalid token response');socket=new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest',[`xai-client-secret.${token.value}`]);socket.onopen=()=>{if(run!==generation)return;send({type:'session.update',session:{voice:'eve',...sessionConfig(),turn_detection:{type:'server_vad'},audio:{input:{format:{type:'audio/pcm',rate:context.sampleRate},transcription:{language_hint:'it'}},output:{format:{type:'audio/pcm',rate:24000}}}}});sessionKey=ownershipKey();source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);animatePattern();processor=context.createScriptProcessor(4096,1,1);processor.onaudioprocess=e=>{if(socket?.readyState!==WebSocket.OPEN||muted)return;const input=e.inputBuffer.getChannelData(0);const pcm=new Int16Array(input.length);for(let i=0;i<input.length;i++)pcm[i]=Math.max(-1,Math.min(1,input[i]))*32767;let str='';const bytes=new Uint8Array(pcm.buffer);for(let i=0;i<bytes.length;i++)str+=String.fromCharCode(bytes[i]);send({type:'input_audio_buffer.append',audio:btoa(str)})};source.connect(processor);processor.connect(context.destination);state('LISTENING','Speak to Grok',true);$('#headline').textContent='Grok';$('#transcript').textContent="I am listening.";if ($('#settingsDialog').open) $('#settingsDialog').close();$('#startVoice').disabled=false};socket.onmessage=async message=>{if(run!==generation)return;const e=JSON.parse(message.data);if(e.type==='input_audio_buffer.speech_started')stopAudio();if(e.type==='response.output_audio.delta'||e.type==='response.audio.delta')playback(e.delta);if(e.type==='conversation.item.input_audio_transcription.completed'){$('#transcript').textContent=`“${e.transcript}”`;$('#headline').textContent='You'}if(e.type==='response.output_audio_transcript.delta'||e.type==='response.audio_transcript.delta'){if($('#headline').textContent!=='Grok'){$('#headline').textContent='Grok';$('#transcript').textContent=''}$('#transcript').textContent+=e.delta}if(e.type==='response.created')responding=true;if(e.type==='response.function_call_arguments.done')pending.push(e);if(e.type==='response.done'){responding=false;if(pending.length)finishCalls();else if(wantResponse)requestResponse()}if(e.type==='error'){$('#hint').textContent=e.error?.message||'Session error'}};socket.onerror=()=>{if(run===generation)$('#hint').textContent='Voice connection failed.'};socket.onclose=()=>{if(run===generation&&!stopping){disconnect();state('CONNECTION LOST','Try starting the session again')}}}catch(error){if(run!==generation)return;disconnect();state('NOT CONNECTED',error.message||'Could not start the session')}}
$('#startVoice').addEventListener('click',()=>{ if (!socket && !$('#startVoice').disabled) start(); });
const settings = $('#settingsDialog');
$('#settingsButton').addEventListener('click', () => settings.showModal());
$('#closeButton').addEventListener('click', disconnect);
settings.querySelector('.dismiss').addEventListener('click', () => settings.close());
settings.addEventListener('click', event => { if(event.target === settings) {
  const rect = settings.getBoundingClientRect();
  if(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) settings.close();
}});
window.addEventListener('pagehide', disconnect);

// The real drones as reported by the server: Drone 1 · Black and Drone 2 · Red.
const droneDialog = $('#dronesDialog');
const CHECKING = 'Checking that no other laptop controls this drone';
// Dot colour: green connected, amber connecting (or still checking the other laptops), red
// offline, grey when another laptop flies it.
const linkOf = d => !d ? 'none' : seeOnly(d) ? 'other' : d.owner?.state !== 'mine' ? 'waiting' : d.connected ? 'connected' : d.verified ? 'waiting' : 'offline';
function availability(d) {
  if (!d) return 'Not configured';
  const o = d.owner;
  if (o?.state === 'other') return `Connected to ${o.name}`;
  if (o?.state === 'lost') return `${o.name} stopped answering · it lands by itself`;
  if (o?.state === 'mine') return `${d.connected ? 'Connected' : (d.linkError || 'Connecting…')}${d.pilot ? (d.pilot.me ? ' · you fly it' : ` · flown by ${d.pilot.name}`) : ''}${o.conflict ? ` · also claimed by ${o.conflict}` : ''}`;
  return o?.reason && o.reason !== CHECKING ? o.reason : 'Checking other laptops…';
}
const coordinates = d => d?.connected ? `Battery ${d.battery ?? '–'}% · Height ${d.heightCm ?? '–'} cm` : 'Unavailable';
const motion = d => d ? `${d.flight === 'flying' ? 'Flying' : 'On the ground'}${Number.isFinite(d.heading) ? ` · ${d.heading}°` : ''}${d.lastError && !seeOnly(d) ? ` · ${d.lastError}` : ''}` : 'Set its IP in .env.tello';
let clientsText = '';
let cardsKey = '';
function renderDrone() {
  const grid = $('#droneGrid');
  grid.replaceChildren();
  cardsKey = ownershipKey();
  for (const [colour, info] of Object.entries(FLEET)) {
    const d = drones.find(x => x.id === info.id);
    const card = document.createElement('article');
    card.className = `drone-card drone-${colour}${seeOnly(d) ? ' drone-other' : ''}`;
    card.innerHTML = '<div class="drone-card-head"><h3></h3><span class="drone-availability"></span></div><div class="drone-video"><img alt=""><span>Camera off: start metoera-vision</span></div><p class="drone-position"></p><div class="drone-coordinates"></div><div class="drone-motion"><span>State</span><strong></strong></div>';
    // Live YOLO video of this laptop's drones, only while the panel is open (the stream stops
    // when the image goes away). Another laptop's drone sends its video to that laptop.
    const img = card.querySelector('.drone-video img');
    if (d?.connected && d.owner?.state === 'mine') { img.src = `/video/${info.id}`; img.alt = `${info.name} camera`; img.onerror = () => card.querySelector('.drone-video').classList.add('off'); }
    else {
      card.querySelector('.drone-video').classList.add('off');
      if (seeOnly(d)) card.querySelector('.drone-video span').textContent = `Camera on ${d.owner.name}'s laptop`;
    }
    card.querySelector('h3').textContent = info.name;
    card.querySelector('.drone-position').textContent = info.model.toUpperCase();
    card.querySelector('.drone-availability').textContent = availability(d);
    card.querySelector('.drone-coordinates').textContent = coordinates(d);
    card.querySelector('.drone-motion strong').textContent = motion(d);
    grid.append(card);
  }
  $('#telemetryNote').textContent = 'The server checks each of its drones every 5 seconds. Drone 1 uses TELLO_IP, Drone 2 uses RMTT_IP. A drone another laptop flies is see-only here.';
  $('#clientsLine').textContent = clientsText;
}
$('#dronesButton').addEventListener('click', () => { renderDrone(); droneDialog.showModal(); });
droneDialog.querySelector('.dismiss').addEventListener('click', () => droneDialog.close());
// Closing the panel drops the video streams.
droneDialog.addEventListener('close', () => $('#droneGrid').replaceChildren());

// While the panel is open, refresh the text only, so the video is not rebuilt. When a drone
// changes hands (ours ↔ another laptop's) the cards are rebuilt to start or drop its video.
function updateCards() {
  if (ownershipKey() !== cardsKey) { renderDrone(); return; }
  for (const [colour, info] of Object.entries(FLEET)) {
    const card = $('#droneGrid').querySelector?.(`.drone-${colour}`);
    if (!card) continue;
    const d = drones.find(x => x.id === info.id);
    card.querySelector('.drone-availability').textContent = availability(d);
    card.querySelector('.drone-coordinates').textContent = coordinates(d);
    card.querySelector('.drone-motion strong').textContent = motion(d);
  }
  $('#clientsLine').textContent = clientsText;
}

// Always-visible link indicator, one dot per drone: green connected, amber linked without telemetry, red offline.
function showLink(text, state, detail) {
  const pill=$('#linkStatus');
  pill.setAttribute('data-state',state);
  pill.title=`${detail}. Click for details`;
  $('#linkText').textContent=text;
}
$('#linkStatus').addEventListener('click', () => { renderDrone(); droneDialog.showModal(); });

async function refreshDrone() {
  try {
    const response = await fetch('/api/drones', {cache:'no-store'});
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.drones)) throw new Error('Invalid status');
    drones = data.drones.filter(d => Object.values(FLEET).some(f => f.id === d.id));
    const others = (data.clients || []).map(c => c.name);
    clientsText = data.claimsError || `Laptops on this network: you${data.me ? ` (${data.me})` : ''}${others.length ? `, ${others.join(', ')}` : '. No other laptop heard'}`;
    // A drone changed hands during a voice session: Grok gets the new list of drones it may fly.
    const key = ownershipKey();
    if (key !== sessionKey) { sessionKey = key; if (socket?.readyState === WebSocket.OPEN) send({type:'session.update',session:sessionConfig()}); }
    const parts = Object.entries(FLEET).map(([colour, info]) => {
      const d = drones.find(x => x.id === info.id);
      const label = colour === 'black' ? 'Black' : 'Red';
      const text = !d ? `${label} –` : seeOnly(d) ? `${label} · ${d.owner.name}` : d.owner?.state !== 'mine' ? `${label} …` : d.connected ? `${label} ${d.battery ?? '–'}%${d.flight==='flying'?' ✈':''}` : `${label} off`;
      return {state:linkOf(d), text, detail:`${info.name}: ${availability(d)}`};
    });
    // The overall colour is about this laptop's drones; another laptop's drone does not count.
    const configured = parts.filter(p => !['none', 'other'].includes(p.state));
    const overall = !configured.length ? (parts.some(p => p.state === 'other') ? 'other' : 'none') : configured.every(p => p.state === 'connected') ? 'connected' : configured.some(p => ['connected', 'waiting'].includes(p.state)) ? 'waiting' : 'offline';
    showLink(parts.map(p => p.text).join(' · '), overall, parts.map(p => p.detail).join('. '));
    $('#droneState').textContent = parts.map(p => p.text).join(' · ');
    for (const [i, p] of parts.entries()) $(`#dot${i}`).setAttribute('data-state', p.state);
  } catch {
    drones = [];
    $('#droneState').textContent = 'Server unreachable';
    showLink('Server offline', 'offline', 'Start the server with npm start');
  }
  if (droneDialog.open) updateCards();
}
// Each person on the link has a name, so the others see who flies each drone.
let myName='';
try { myName=localStorage.getItem('metoera_name')||''; } catch {}
async function sendName(name){
  try { const r=await fetch('/api/pilot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}); const j=await r.json(); if(j.ok){myName=j.name; try{localStorage.setItem('metoera_name',myName)}catch{} $('#pilotLine').textContent=`You are ${myName}`;} } catch {}
}
const nameDialog=$('#nameDialog');
nameDialog.addEventListener('close',()=>{ const v=$('#pilotName').value.trim(); if(v) void sendName(v); else if(!myName) setTimeout(()=>nameDialog.showModal?.(),0); });
if(myName) void sendName(myName); else nameDialog.showModal?.();
$('#pilotLine').addEventListener('click',()=>{ $('#pilotName').value=myName; nameDialog.showModal(); });
refreshDrone();
setInterval(refreshDrone, 1500);
