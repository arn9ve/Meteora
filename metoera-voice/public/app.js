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
let drones=[]; // from /api/drones: owner {state: mine | other | lost | taking | yielding | claiming | waiting}, pilot {name, me}
const droneOf=colour=>drones.find(d=>d.id===FLEET[colour]?.id);
// Held by another laptop (owner.locked: flying or flown there), or its laptop went silent.
const elsewhere=d=>['other','lost'].includes(d?.owner?.state);
// The person who takes off a drone flies it until it lands. Blocked: someone else flies it,
// here or on another laptop; nothing at all may be sent to it, not even land or emergency.
const blocked=d=>Boolean((d?.pilot&&!d.pilot.me)||(d?.owner?.state==='other'&&d.owner.locked)||d?.owner?.state==='lost');
// On the ground and linked to another laptop: a takeoff from here moves it to this laptop.
const takeable=d=>d?.owner?.state==='other'&&!d.owner.locked;
// The drones this person may command: on this laptop and not flown by someone else, or takeable.
const flyable=d=>Boolean(d)&&!blocked(d)&&(['mine','taking'].includes(d.owner?.state)||takeable(d));
const flyableColours=()=>Object.keys(FLEET).filter(c=>flyable(droneOf(c)));
// Every voice action goes to a real drone through the local server.
const actionLabels={face:'Face target',dispatch:'Dispatch',explore:'Explore',describe:'Look (vision)',find:'Find',memory:'Memory',mark:'Place saved',go_to:'Go back',approach:'Approach',photo:'Photo',emergency:'Motors cut',takeoff:'Takeoff',land:'Landing',move:'Move',rotate:'Rotation',flip:'Flip',speed:'Speed',stop:'Stop',status:'Status',test_flight:'Test flight',scan:'360° scan',look:'Look'};
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
const SILENT_WHEN_OK=['takeoff','land','move','rotate','flip','speed','stop','test_flight','release','emergency','mark','go_to'];
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
// "Send the nearest drone there": the server picks the drone, this page runs the steps on that
// drone's own queue (takeoff if needed, fly to 1 m short, face the target, approach it).
async function runDispatch(args,run){
  const {x,y,label,stopCm}=args;
  let pick;
  try { const r=await fetch('/api/nearest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,y,stopCm})}); pick=await r.json(); }
  catch { pick={ok:false,error:'Server unreachable'}; }
  if(run!==generation) return;
  if(!pick.ok){ notifyGrok(`Dispatch: failed ${pick.error}`); return; }
  const id=pick.drone, name=nameOf(id);
  log(`${name} · Dispatch`,`nearest, ${pick.distanceCm} cm away`);
  const steps=[];
  if(!pick.flying) steps.push(['takeoff',{}]);
  if(pick.distanceCm>(stopCm??100)+20) steps.push(['go_to',{x:pick.stop.x,y:pick.stop.y}]);
  steps.push(['face',{x,y}]);
  if(label) steps.push(['approach',{label,...(stopCm?{stopCm}:{})}]);
  const task=async()=>{
    for(const [action,extra] of steps){
      if(run!==generation) return;
      const result=await runOnDrone(id,action,extra);
      log(`${name} · ${actionLabels[action]||action}`,result.ok?'Done':`Rejected · ${serverMessage(result.error)}`);
      if(!result.ok){ notifyGrok(`Dispatch: sent ${name}, but ${action} failed: ${result.error}`); void refreshDrone(); return; }
    }
    void refreshDrone();
    notifyGrok(`Dispatch: ${name} was the nearest (${pick.distanceCm} cm away) and has arrived${label?` near the ${label}`:''}. Say it in a few words.`);
  };
  droneQueues[id]=(droneQueues[id]??Promise.resolve()).then(task,task);
}
function dispatch(name,args,failed,run){
  // Grok can still finish a reply after the microphone went off; only safety commands run then.
  if(muted&&!URGENT.includes(name)) return {ok:false,mode:'real',error:'Microphone is off; command ignored'};
  if(name==='mute'){setMuted(true);log('Grok · Microphone off','Done');return {ok:true,action:'mute'}}
  if(name==='dispatch'){ if(muted) return {ok:false,mode:'real',error:'Microphone is off; command ignored'}; if(typeof args.x!=='number'||typeof args.y!=='number') return {ok:false,error:'dispatch needs x and y from memory'}; void runDispatch(args,run); return {ok:true,status:'started',note:'Choosing the nearest drone; an automatic update follows.'}; }
  const {drone:colour,...rest}=args;
  // Natural commands: "vai a destra" moves 50 cm, "ruota" turns 90 degrees clockwise.
  if(name==='move'&&rest.centimeters===undefined) rest.centimeters=50;
  if(name==='rotate'){rest.direction??='clockwise';rest.degrees??=90}
  // Emergency without a named drone cuts the motors of every drone this person may command.
  if(name==='emergency'&&!colour){void emergency('motors');return {ok:true,action:'emergency',drones:'every drone you fly'}}
  let ids;
  if(FLEET[colour]) ids=[FLEET[colour].id];
  else if(URGENT.includes(name)){
    // In a hurry nobody names the drone: every drone on this laptop that nobody else flies.
    // The page's view can be a moment old, so the server decides; it refuses the others.
    ids=Object.values(FLEET).map(f=>f.id).filter(id=>{const d=drones.find(x=>x.id===id);return !blocked(d)&&!elsewhere(d)});
    if(!ids.length) return {ok:false,mode:'real',error:'You fly no drone right now'};
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
const INSTRUCTIONS='You are Grok, the voice pilot of two real drones for Metoera: Drone 1, called Black (a Tello EDU), and Drone 2, called Red (a RoboMaster TT). Every drone tool takes drone: black or red. If the person does not say which drone and more than one could be meant, ask; never choose for them. If they say both or all, call the tool for black and for red in the same reply: they run at the same time. land and stop without a drone apply to every drone you fly. If the person asks you to choose which drone to fly or land, call status on black and on red first and wait for both updates, prefer a connected drone that is on the ground with more battery for flying (at least 20 percent), say which one you picked and why, then act. If they ask to test the drones, propose a short plan (for example: status on both, test_flight on black, then test_flight on red), and run it step by step only after they agree. Each drone has its own camera with object detection: scan and look take drone black or red, and for both drones call them once per drone and report the result of each drone separately. Every tool call physically moves a drone, so do exactly what the person says: no extra steps, no skipped steps, no changed values. Speak in the language the person uses (usually Italian) and be very brief: do exactly what is asked and nothing more. Confirm a command with one or two words (for example: ok, fatto, decollo). Never mention battery, height, heading, distances, counts or other drone data unless the person asks for it, and then answer only that. Understand natural commands in Italian or English: destra = right, sinistra = left, avanti = forward, indietro = back, su = up, giù = down, ruota/gira = rotate, girati = rotate 180, fai una foto = photo, atterra = land, decolla = take off, fermati = stop. If no distance is given, move uses 50 cm; if no angle is given, rotate uses 90 degrees; a little = 30 cm, a lot = 100 cm. Only ask when the drone or the direction is really unclear. Convert units yourself: 1 meter = 100 centimeters, half a meter = 50. Turn right means clockwise, turn left means counterclockwise. Drone tools answer at once with status started: the drone works in the background and you receive an automatic drone update message when it is done or failed. Never wait for a drone before handling the next request: the two drones are independent and run at the same time, so you can command Red while Black is still busy. For a sequence on the same drone, call its tools in order in one go; they run in that order, and if one fails the rest for that drone is skipped. When a drone update says done for an action, stay silent. Speak about an update only when it failed (say why in one short sentence) or when it answers something the person asked. If the person says stop, wait, hold or freeze, call stop at once. If they say land, or sound alarmed, call land at once. If they just say fly or test flight, call test_flight. The drone has a camera with object detection. To count or find things all around (for example: do a 360 and count the people at the table), take off first if it is on the ground, then call scan with the object name in English (person for people). scan turns a full circle in four 90-degree steps and returns a count per view and a total; give the total, mention where they are if useful, and say it is approximate because someone at the edge between two views can be missed or counted twice. To say what is in front of the drone right now, or how many people it sees, call look (label person to count people); to count all around, scan. For a photo, call photo. To understand the scene precisely (clothes, colours, who is where), call describe: it sends the camera image to Grok vision. To find something described in words (la persona con la maglietta verde), call find with the full description; it turns the drone to face it, then call approach to go there. Each drone remembers its position (room frame from its first takeoff), its actions, saved places and what it saw: call memory before answering about the past or where things are. To go back somewhere (torna dove eri, torna a casa, torna al punto di prima), call go_to with place home, last_landing, previous or a saved name, or x,y from memory; if the drone is on the ground, take off first. Save a spot with mark when asked to remember it. To send a drone to someone or something without naming the drone (mandami un drone, manda quello più vicino), take its x,y from memory (sightings; match the description, e.g. green t-shirt) and call dispatch with x, y and label: the server chooses the nearest free drone. If it is not in memory yet, explore or find first. If the person names the drone (mandami il rosso dalla persona), call go_to with the x,y on that drone, then face, then approach. To explore or map the room (esplora la stanza, mappa la stanza), call explore; with both drones, call explore for black and for red in the same reply so they work at the same time. Both drones share one room map (Map button on the page). After explore, answer in one sentence with what was found. For where is X questions, call memory and use the sightings (room coordinates in cm; x = toward the wall both drones faced at the start, y = left). Use what you learned earlier in the conversation and from memory; never forget a result you already got. To come toward someone or something (vieni verso la persona, avvicinati alla bottiglia), call approach with the object name in English (person by default); it stops about 1 m away, or the distance the person says (vicino = 60 cm). The drone must be flying; if it is on the ground, say so. Report only what the results contain; never invent objects. If the person says emergency, cut the motors or kill the motors, call emergency at once (leave drone empty to stop every drone you fly): the motors stop and the drone drops. If they say stop listening, mute or microphone off, call mute; after that you hear nothing until they turn the microphone back on. Only say a drone did something when its drone update says done, and report rejections in plain words, including limits such as the maximum distance.';
const dir=(values)=>({type:'string',enum:values});
// Grok only gets the drones this person may command. If there are none, the names stay listed
// so Grok can say who flies them, and the server refuses.
function droneParam(){
  const list=flyableColours().length?flyableColours():Object.keys(FLEET);
  return {type:'string',enum:list,description:list.map(c=>`${c} = ${FLEET[c].name} (${FLEET[c].model})`).join(', ')};
}
// Who flies what, for Grok: the person who takes off a drone flies it until it lands.
function whoFlies(d){
  if(d.pilot&&!d.pilot.me) return `${d.pilot.name}, another person on this laptop`;
  if(d.owner?.state==='lost') return `nobody right now: ${d.owner.name}'s laptop stopped answering and it lands by itself`;
  return `${d.owner.pilot||'someone'} on ${d.owner.name}'s laptop`;
}
function pilotNote(){
  const entries=Object.keys(FLEET).map(c=>[c,droneOf(c)]).filter(([,d])=>d);
  const yours=entries.filter(([,d])=>d.pilot?.me).map(([c])=>c);
  const free=entries.filter(([,d])=>d.owner?.state==='mine'&&!d.pilot).map(([c])=>c);
  const away=entries.filter(([,d])=>takeable(d)).map(([c,d])=>`${c} is on the ground, linked to ${d.owner.name}'s laptop: only takeoff, test_flight and status work on it, and a takeoff first moves it to this laptop (about 2 seconds)`);
  const others=entries.filter(([,d])=>blocked(d)).map(([c,d])=>`${c} is flown by ${whoFlies(d)}`);
  return `${myName?` You are talking to ${myName}.`:' The person has not typed a name yet; without one they cannot take off.'}${yours.length?` ${myName||'This person'} flies ${yours.join(' and ')}.`:''}${free.length?` Free to fly: ${free.join(' and ')}.`:''}${away.length?` ${away.join('; ')}.`:''}${others.length?` ${others.join('; ')}: you cannot command it at all, not even land, stop or emergency (status still works); if asked, say who flies it.`:''} The person who takes off a drone flies it until it has landed; then anyone may fly it.`;
}
// What each drone remembers, so a new or reconnected session starts with the history.
function memoryNote(){
  const lines=Object.entries(FLEET).map(([c,f])=>{const d=drones.find(x=>x.id===f.id);return d?.memory?`${c}: ${d.memory}`:null}).filter(Boolean);
  return lines.length?` Drone memory at the start of this session: ${lines.join(' | ')}.`:'';
}
const ownershipKey=()=>JSON.stringify([drones.map(d=>[d.id,d.owner?.state,d.owner?.name??'',d.owner?.pilot??'',Boolean(d.owner?.locked),d.pilot?.name??'',Boolean(d.pilot?.me)]),myName]);
let sessionKey='';
function sessionConfig(){ return {instructions:INSTRUCTIONS+pilotNote()+memoryNote(),tools:buildTools()} }
// Every drone tool gets the drone parameter; mute is about the microphone, not a drone.
const droneTool=(name,description,properties={},required=[])=>tool(name,description,{drone:droneParam(),...properties},['emergency','land','stop'].includes(name)?required:['drone',...required]);
const buildTools=()=>[
  droneTool('takeoff','Take off and hover at about 80 cm'),
  droneTool('land','Land now'),
  droneTool('stop','Hover in place immediately, interrupting a move in progress'),
  droneTool('move','Move in a straight line: forward/back, left/right, up/down (avanti, indietro, sinistra, destra, su, giù). Without a distance it moves 50 cm',{direction:dir(['forward','back','left','right','up','down']),centimeters:{type:'integer',minimum:20,maximum:500,description:'Optional, default 50'}},['direction']),
  droneTool('rotate','Turn in place (ruota, gira). Right = clockwise, left = counterclockwise. Without an angle it turns 90 degrees; turn around = 180',{direction:dir(['clockwise','counterclockwise']),degrees:{type:'integer',minimum:1,maximum:360,description:'Optional, default 90'}},[]),
  droneTool('approach','Fly toward the person or object in front of the drone and stop at a safe distance (vieni verso, avvicinati, vai dalla persona). Uses the camera only; distances are estimates',{label:{type:'string',description:'Object class in English, default person'},stopCm:{type:'integer',minimum:50,maximum:300,description:'How far from it to stop, default 100'}},[]),
  droneTool('explore','Explore the room from where the drone is: six photos turning all around, YOLO and Grok vision put people, furniture and objects on the room map (esplora, guardati intorno e ricorda). Drone must be flying'),
  droneTool('describe','Look through the camera with Grok vision and answer a question about the scene (cosa vedi, chi c\'è, di che colore è). Precise: clothes, colours, positions',{question:{type:'string',description:'What to look for or ask about the image'}},[]),
  droneTool('find','Find something described in words (la persona con la maglietta verde, lo zaino rosso): takes photos all around, Grok vision picks it, and the drone turns to face it. Drone must be flying. Then call approach to fly to it',{description:{type:'string',description:'What to find, with details'}},['description']),
  droneTool('memory','What this drone remembers: position in the room, the last actions, saved places and things it saw with their position'),
  droneTool('face','Turn this drone to face a point of the room map (x,y from memory)',{x:{type:'integer'},y:{type:'integer'}},['x','y']),
  droneTool('mark','Save the current position under a name (ricorda questo punto come …)',{name:{type:'string'}},['name']),
  droneTool('go_to','Fly back to a remembered place: home (where it first took off), last_landing, previous (before its last move), a name saved with mark, or room coordinates x,y in cm from memory. Drone must be flying',{place:{type:'string'},x:{type:'integer'},y:{type:'integer'}},[]),
  droneTool('photo','Take a photo with the camera of this drone (with the object boxes) and show it on the page (fai una foto, scatta)'),
  droneTool('flip','Flip in a direction; needs at least 50% battery',{direction:dir(['left','right','forward','back'])},['direction']),
  droneTool('speed','Set the speed used by later moves',{cmPerSecond:{type:'integer',minimum:10,maximum:100}},['cmPerSecond']),
  droneTool('emergency','EMERGENCY: stop the motors immediately; the drone drops. Only when the person asks for an emergency or to cut the motors'),
  tool('dispatch','Send the best drone (nearest, free, with battery) to a point of the room map: it takes off if needed, flies to 1 m short, faces it and, with a label, approaches it. Use the x,y of a sighting from memory (mandami un drone là, manda il drone più vicino dalla persona)',{x:{type:'integer'},y:{type:'integer'},label:{type:'string',description:'What is there, in English (person, bottle…), to approach it at the end'},stopCm:{type:'integer',minimum:50,maximum:300}},['x','y']),
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
// offline, grey when someone else flies it or it is linked to another laptop.
const linkOf = d => !d ? 'none' : blocked(d) || elsewhere(d) ? 'other' : d.owner?.state !== 'mine' ? 'waiting' : d.connected ? 'connected' : d.verified ? 'waiting' : 'offline';
function availability(d) {
  if (!d) return 'Not configured';
  const o = d.owner;
  if (o?.state === 'other') return o.locked ? `${o.pilot ? `Flown by ${o.pilot}` : 'In use'} · ${o.name}'s laptop` : `On the ground · on ${o.name}'s laptop · say take off to fly it here`;
  if (o?.state === 'lost') return `${o.name} stopped answering · it lands by itself`;
  if (o?.state === 'taking') return `Taking over${o.name ? ` from ${o.name}` : ''}…`;
  if (o?.state === 'yielding') return `Handing over to ${o.name}…`;
  if (o?.state === 'mine') return `${d.connected ? 'Connected' : (d.linkError || 'Connecting…')} · ${d.pilot ? (d.pilot.me ? 'you fly it' : `flown by ${d.pilot.name}`) : 'free'}${o.conflict ? ` · also claimed by ${o.conflict}` : ''}`;
  return o?.reason && o.reason !== CHECKING ? o.reason : 'Checking other laptops…';
}
const coordinates = d => d?.connected ? `Battery ${d.battery ?? '–'}% · Height ${d.heightCm ?? '–'} cm` : 'Unavailable';
const motion = d => d ? `${d.flight === 'flying' ? 'Flying' : 'On the ground'}${Number.isFinite(d.heading) ? ` · ${d.heading}°` : ''}${d.lastError && !elsewhere(d) ? ` · ${d.lastError}` : ''}` : 'Set its IP in .env.tello';
let clientsText = '';
// The cards are rebuilt (video started or dropped) only when a drone changes laptop.
const videoKey = () => JSON.stringify(drones.map(d => [d.id, d.owner?.state, d.owner?.name ?? '']));
let cardsKey = '';
function renderDrone() {
  const grid = $('#droneGrid');
  grid.replaceChildren();
  cardsKey = videoKey();
  for (const [colour, info] of Object.entries(FLEET)) {
    const d = drones.find(x => x.id === info.id);
    const card = document.createElement('article');
    card.className = `drone-card drone-${colour}${blocked(d) ? ' drone-other' : ''}`;
    card.innerHTML = '<div class="drone-card-head"><h3></h3><span class="drone-availability"></span></div><div class="drone-video"><img alt=""><span>Camera off: start metoera-vision</span></div><p class="drone-position"></p><div class="drone-coordinates"></div><div class="drone-motion"><span>State</span><strong></strong></div>';
    // Live YOLO video of this laptop's drones, only while the panel is open (the stream stops
    // when the image goes away). Another laptop's drone sends its video to that laptop.
    const img = card.querySelector('.drone-video img');
    if (d?.connected && d.owner?.state === 'mine') { img.src = `/video/${info.id}`; img.alt = `${info.name} camera`; img.onerror = () => card.querySelector('.drone-video').classList.add('off'); }
    else {
      card.querySelector('.drone-video').classList.add('off');
      if (elsewhere(d)) card.querySelector('.drone-video span').textContent = `Camera on ${d.owner.name}'s laptop`;
    }
    card.querySelector('h3').textContent = info.name;
    card.querySelector('.drone-position').textContent = info.model.toUpperCase();
    card.querySelector('.drone-availability').textContent = availability(d);
    card.querySelector('.drone-coordinates').textContent = coordinates(d);
    card.querySelector('.drone-motion strong').textContent = motion(d);
    grid.append(card);
  }
  $('#telemetryNote').textContent = 'The server checks each of its drones every 5 seconds. Drone 1 uses TELLO_IP, Drone 2 uses RMTT_IP. The person who takes off a drone flies it until it lands; a landed drone on another laptop moves here when someone takes off with it.';
  $('#clientsLine').textContent = clientsText;
}
$('#dronesButton').addEventListener('click', () => { renderDrone(); droneDialog.showModal(); });
droneDialog.querySelector('.dismiss').addEventListener('click', () => droneDialog.close());
// Closing the panel drops the video streams.
droneDialog.addEventListener('close', () => $('#droneGrid').replaceChildren());

// While the panel is open, refresh the text only, so the video is not rebuilt. When a drone
// changes hands (ours ↔ another laptop's) the cards are rebuilt to start or drop its video.
function updateCards() {
  if (videoKey() !== cardsKey) { renderDrone(); return; }
  for (const [colour, info] of Object.entries(FLEET)) {
    const card = $('#droneGrid').querySelector?.(`.drone-${colour}`);
    if (!card) continue;
    const d = drones.find(x => x.id === info.id);
    card.classList.toggle('drone-other', blocked(d));
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
      const who = d?.pilot && !d.pilot.me ? ` · ${d.pilot.name}` : '';
      const text = !d ? `${label} –` : elsewhere(d) ? `${label} · ${d.owner.pilot || d.owner.name}` : d.owner?.state !== 'mine' ? `${label} …` : d.connected ? `${label} ${d.battery ?? '–'}%${d.flight==='flying'?' ✈':''}${who}` : `${label} off${who}`;
      return {state:linkOf(d), text, detail:`${info.name}: ${availability(d)}`};
    });
    // The overall colour is about the drones this person may fly here; the others do not count.
    const configured = parts.filter(p => !['none', 'other'].includes(p.state));
    const overall = !configured.length ? (parts.some(p => p.state === 'other') ? 'other' : 'none') : configured.every(p => p.state === 'connected') ? 'connected' : configured.some(p => ['connected', 'waiting'].includes(p.state)) ? 'waiting' : 'offline';
    showLink(parts.map(p => p.text).join(' · '), overall, parts.map(p => p.detail).join('. '));
    $('#droneState').textContent = parts.map(p => p.text).join(' · ');
    for (const [i, p] of parts.entries()) $(`#dot${i}`).setAttribute('data-state', p.state);
    decideName(data.pilot&&typeof data.pilot.name==='string'?data.pilot.name:'');
  } catch {
    drones = [];
    $('#droneState').textContent = 'Server unreachable';
    showLink('Server offline', 'offline', 'Start the server with npm start');
    decideName('');
  }
  if (droneDialog.open) updateCards();
}
// The name belongs to this browser, shared by its tabs: localStorage and the metoera_pilot cookie.
let myName='';
let nameDecided=false;
function storedName(){
  try { return localStorage.getItem('metoera_name')||''; } catch { return ''; }
}
function rememberName(name){
  myName=name;
  try { localStorage.setItem('metoera_name', myName); } catch {}
  $('#pilotLine').textContent=`You are ${myName}`;
}
async function sendName(name){
  try { const r=await fetch('/api/pilot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}); const j=await r.json(); if(j.ok) rememberName(j.name); } catch {}
}
function decideName(serverName){
  if(nameDecided) return;
  nameDecided=true;
  const fromServer=typeof serverName==='string'?serverName.trim():'';
  if(fromServer){ rememberName(fromServer); return; }
  const saved=storedName();
  if(saved){ void sendName(saved); return; }
  nameDialog.showModal?.();
}
const nameDialog=$('#nameDialog');
nameDialog.addEventListener('close',()=>{ const v=$('#pilotName').value.trim(); if(v) void sendName(v); else if(!myName) setTimeout(()=>nameDialog.showModal?.(),0); });
// The lock goes by the name: renaming while flying gives up control of the drone.
$('#pilotLine').addEventListener('click',()=>{
  $('#pilotName').value=myName;
  const flying=Object.keys(FLEET).filter(c=>{const d=droneOf(c);return d?.pilot?.me&&d.flight==='flying'}).map(c=>c[0].toUpperCase()+c.slice(1));
  const warning=$('#nameWarning');
  warning.hidden=!flying.length;
  warning.textContent=flying.length?`You fly ${flying.join(' and ')}. With another name you can't command it, and the server lands it after 15 s.`:'';
  nameDialog.showModal();
});
// Top-down room map: both drones, their paths, saved places and what they saw.
const mapDialog=$('#mapDialog');
const SVGNS='http://www.w3.org/2000/svg';
function svgEl(tag,attrs,text){const e=document.createElementNS(SVGNS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e}
async function renderMap(){
  let data;
  try { const r=await fetch('/api/map',{cache:'no-store'}); data=await r.json(); if(!r.ok||!Array.isArray(data.drones)) throw 0; }
  catch { $('#mapNote').textContent='Map unavailable.'; return; }
  const svg=$('#mapSvg');
  svg.replaceChildren();
  // Room frame: x forward (drawn up), y left (drawn left). Screen: X = -y, Y = -x.
  const pts=[];
  for(const d of data.drones){pts.push(d.pose,...d.path,...Object.values(d.places||{}),...d.sightings,...(d.obstacles||[]))}
  const xs=pts.map(p=>-p.y), ys=pts.map(p=>-p.x);
  let minX=Math.min(-150,...xs)-80, maxX=Math.max(150,...xs)+80, minY=Math.min(-150,...ys)-80, maxY=Math.max(150,...ys)+80;
  const span=Math.max(400,maxX-minX,maxY-minY), cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  minX=cx-span/2; minY=cy-span/2;
  svg.setAttribute('viewBox',`${minX} ${minY} ${span} ${span}`);
  const unit=span/400; // keeps strokes and text readable at any zoom
  for(let g=Math.ceil(minX/100)*100;g<=minX+span;g+=100) svg.append(svgEl('line',{x1:g,y1:minY,x2:g,y2:minY+span,class:'map-grid','stroke-width':unit}));
  for(let g=Math.ceil(minY/100)*100;g<=minY+span;g+=100) svg.append(svgEl('line',{x1:minX,y1:g,x2:minX+span,y2:g,class:'map-grid','stroke-width':unit}));
  const colours={tello:'#1c1c1c',rmtt:'#d32f2f'};
  let things=0;
  for(const d of data.drones){
    const c=colours[d.id]||'#555';
    // Depth hits (walls, furniture), like a LiDAR sweep.
    for(const o of d.obstacles||[]) svg.append(svgEl('rect',{x:-o.y-4*unit,y:-o.x-4*unit,width:8*unit,height:8*unit,fill:'#9e9e9e',opacity:.55}));
    if(d.path.length>1) svg.append(svgEl('polyline',{points:d.path.map(p=>`${-p.y},${-p.x}`).join(' '),fill:'none',stroke:c,'stroke-width':2*unit,'stroke-dasharray':`${6*unit} ${4*unit}`,opacity:.6}));
    for(const[name,p]of Object.entries(d.places||{})){
      svg.append(svgEl('rect',{x:-p.y-5*unit,y:-p.x-5*unit,width:10*unit,height:10*unit,fill:'none',stroke:c,'stroke-width':1.5*unit}));
      svg.append(svgEl('text',{x:-p.y-8*unit,y:-p.x+14*unit,'font-size':10*unit,fill:c,'text-anchor':'end'},name.replace('_',' ')));
    }
    for(const s of d.sightings){
      things++;
      const person=s.label==='person', col=person?'#1e88e5':'#43a047';
      if(s.approx){
        // Distance unknown: a dotted direction from where the drone saw it.
        svg.append(svgEl('line',{x1:-s.fromY,y1:-s.fromX,x2:-s.y,y2:-s.x,stroke:col,'stroke-width':1.2*unit,'stroke-dasharray':`${2*unit} ${3*unit}`,opacity:.7}));
        svg.append(svgEl('text',{x:-s.y+4*unit,y:-s.x-4*unit,'font-size':9*unit,fill:col,opacity:.85},`${(s.description||s.label).slice(0,24)} ?`));
        continue;
      }
      const r=(person?6:4.5)*unit*Math.min(1.6,1+0.15*((s.count||1)-1)); // seen more often = bigger
      svg.append(svgEl('circle',{cx:-s.y,cy:-s.x,r,fill:col,stroke:col,'stroke-width':1.5*unit}));
      svg.append(svgEl('text',{x:-s.y+9*unit,y:-s.x+4*unit,'font-size':10*unit,fill:'#333'},`${(s.description||s.label).slice(0,28)}${s.distanceCm?` · ${(s.distanceCm/100).toFixed(1)} m`:''}`));
    }
    const h=d.pose.heading*Math.PI/180, px=-d.pose.y, py=-d.pose.x;
    svg.append(svgEl('line',{x1:px,y1:py,x2:px-Math.sin(h)*28*unit,y2:py-Math.cos(h)*28*unit,stroke:c,'stroke-width':3*unit,'stroke-linecap':'round'}));
    svg.append(svgEl('circle',{cx:px,cy:py,r:10*unit,fill:c}));
    svg.append(svgEl('text',{x:px+13*unit,y:py-12*unit,'font-size':12*unit,'font-weight':600,fill:c},d.id==='tello'?'Black':d.id==='rmtt'?'Red':d.id));
  }
  $('#mapNote').textContent=data.drones.length?`${things} things on the map · blue = people, green = objects, dotted line = direction only (distance unknown), grey = walls and obstacles from depth, squares = saved places.`:'No drone flown from here yet.';
}
$('#mapButton').addEventListener('click',()=>{void renderMap();mapDialog.showModal()});
mapDialog.querySelector('.dismiss').addEventListener('click',()=>mapDialog.close());
setInterval(()=>{if(mapDialog.open) void renderMap()},1500);
refreshDrone();
setInterval(refreshDrone, 1500);
