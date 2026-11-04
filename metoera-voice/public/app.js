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
const INSTRUCTIONS='You are Grok, the voice pilot of two real drones for Metoera: Drone 1, called Black (a Tello EDU), and Drone 2, called Red (a RoboMaster TT). Every drone tool takes drone: black or red. If the person does not say which drone and more than one could be meant, ask; never choose for them. If they say both or all, call the tool for black and for red in the same reply: they run at the same time. land and stop without a drone apply to every drone you fly. If the person asks you to choose which drone to fly or land, call status on black and on red first and wait for both updates, prefer a connected drone that is on the ground with more battery for flying (at least 20 percent), say which one you picked and why, then act. If they ask to test the drones, propose a short plan (for example: status on both, test_flight on black, then test_flight on red), and run it step by step only after they agree. Each drone has its own camera with object detection: scan and look take drone black or red, and for both drones call them once per drone and report the result of each drone separately. Every tool call physically moves a drone, so do exactly what the person says: no extra steps, no skipped steps, no changed values. Speak in the language the person uses (usually Italian) and be very brief: do exactly what is asked and nothing more. Confirm a command with one or two words (for example: ok, fatto, decollo). Never mention battery, height, heading, distances, counts or other drone data unless the person asks for it, and then answer only that. Understand natural commands in Italian or English: destra = right, sinistra = left, avanti = forward, indietro = back, su = up, giù = down, ruota/gira = rotate, girati = rotate 180, fai una foto = photo, atterra = land, decolla = take off, fermati = stop. If no distance is given, move uses 50 cm; if no angle is given, rotate uses 90 degrees; a little = 30 cm, a lot = 100 cm. Only ask when the drone or the direction is really unclear. Convert units yourself: 1 meter = 100 centimeters, half a meter = 50. Turn right means clockwise, turn left means counterclockwise. Drone tools answer at once with status started: the drone works in the background and you receive an automatic drone update message when it is done or failed. Never wait for a drone before handling the next request: the two drones are independent and run at the same time, so you can command Red while Black is still busy. For a sequence on the same drone, call its tools in order in one go; they run in that order, and if one fails the rest for that drone is skipped. When a drone update says done for an action, stay silent. Speak about an update only when it failed (say why in one short sentence) or when it answers something the person asked. If the person says stop, wait, hold or freeze, call stop at once. If they say land, or sound alarmed, call land at once. If they just say fly or test flight, call test_flight. The drone has a camera with object detection. To count or find things all around (for example: do a 360 and count the people at the table), take off first if it is on the ground, then call scan with the object name in English (person for people). scan turns a full circle in four 90-degree steps and returns a count per view and a total; give the total, mention where they are if useful, and say it is approximate because someone at the edge between two views can be missed or counted twice. To say what is in front of the drone right now, or how many people it sees, call look (label person to count people); to count all around, scan. For a photo, call photo. To understand the scene precisely (clothes, colours, who is where), call describe: it sends the camera image to Grok vision. To find something described in words (la persona con la maglietta verde), call find with the full description; it turns the drone to face it, then call approach to go there. Each drone remembers its position (room frame from its first takeoff), its actions, saved places and what it saw: call memory before answering about the past or where things are. To go back somewhere (torna dove eri, torna a casa, torna al punto di prima), call go_to with place home, last_landing, previous or a saved name, or x,y from memory; if the drone is on the ground, take off first. Save a spot with mark when asked to remember it. Pad-nav demo (Black on pad-01 home → pad-02 target): after an automatic pad mission update says Black is waiting at the target, listen for the next command — do not land by yourself. If they say return to home and land, return home and land, torna a casa e atterra, or rientra e atterra: on black call go_to with place home, then land. If they say go to the first point and wait, go home and wait, vai al primo punto e aspetta, or torna al primo punto e aspetta: on black call go_to with place home only (hover; do not land). When an automatic update includes a pad mission vision report, say that short report in a few words, then say you are waiting for the next command. To send a drone to someone or something without naming the drone (mandami un drone, manda quello più vicino), take its x,y from memory (sightings; match the description, e.g. green t-shirt) and call dispatch with x, y and label: the server chooses the nearest free drone. If it is not in memory yet, explore or find first. If the person names the drone (mandami il rosso dalla persona), call go_to with the x,y on that drone, then face, then approach. To explore or map the room (esplora la stanza, mappa la stanza), call explore; with both drones, call explore for black and for red in the same reply so they work at the same time. Both drones share one room map (Map button on the page). After explore, answer in one sentence with what was found. For where is X questions, call memory and use the sightings (room coordinates in cm; x = toward the wall both drones faced at the start, y = left). Use what you learned earlier in the conversation and from memory; never forget a result you already got. To come toward someone or something (vieni verso la persona, avvicinati alla bottiglia), call approach with the object name in English (person by default); it stops about 1 m away, or the distance the person says (vicino = 60 cm). The drone must be flying; if it is on the ground, say so. Report only what the results contain; never invent objects. If the person says emergency, cut the motors or kill the motors, call emergency at once (leave drone empty to stop every drone you fly): the motors stop and the drone drops. If they say stop listening, mute or microphone off, call mute; after that you hear nothing until they turn the microphone back on. Only say a drone did something when its drone update says done, and report rejections in plain words, including limits such as the maximum distance.';
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
function sessionConfig(){ return {instructions:INSTRUCTIONS+pilotNote()+memoryNote()+zoneNote(),tools:buildTools()} }
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
    decideName(data.pilot&&typeof data.pilot.name==='string'?data.pilot.name:'', true);
    handleRedzone(data.redzone ?? null);
  } catch {
    drones = [];
    $('#droneState').textContent = 'Server unreachable';
    showLink('Server offline', 'offline', 'Start the server with npm start');
    decideName('', false);
  }
  if (droneDialog.open) updateCards();
}
// The name belongs to this browser, shared by its tabs: localStorage and a metoera_name cookie.
// Saving only after the dialog's close event misses a new tab: that event can run once the input is already cleared.
let myName='';
let nameDecided=false;
function storedName(){
  try {
    const saved = localStorage.getItem('metoera_name');
    if (saved) return saved;
  } catch {}
  try {
    const match = /(?:^|;\s*)metoera_name=([^;]*)/.exec(document.cookie || '');
    return match ? decodeURIComponent(match[1]) : '';
  } catch { return ''; }
}
function rememberName(name){
  myName=name;
  try { localStorage.setItem('metoera_name', myName); } catch {}
  try { document.cookie = `metoera_name=${encodeURIComponent(myName)}; Path=/; Max-Age=31536000; SameSite=Lax`; } catch {}
  $('#pilotLine').textContent=`You are ${myName}`;
}
async function sendName(name){
  try { const r=await fetch('/api/pilot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}); const j=await r.json(); if(j.ok) rememberName(j.name); } catch {}
}
// A failed poll must not open the dialog. The next poll may still carry this browser's name, and opening now would ignore it.
function decideName(serverName, confirmed){
  if(nameDecided) return;
  const fromServer=typeof serverName==='string'?serverName.trim():'';
  const saved=storedName();
  if(!confirmed && !fromServer && !saved) return;
  nameDecided=true;
  if(fromServer){ rememberName(fromServer); return; }
  if(saved){ rememberName(saved); void sendName(saved); return; }
  nameDialog.showModal?.();
}
const nameDialog=$('#nameDialog');
nameDialog.querySelector('form').addEventListener('submit', () => {
  const v = ($('#pilotName').value || '').trim();
  if (v) { rememberName(v); void sendName(v); }
});
nameDialog.addEventListener('close',()=>{ const v=($('#pilotName').value || '').trim(); if(v) void sendName(v); else if(!myName) setTimeout(()=>nameDialog.showModal?.(),0); });
// The lock goes by the name: renaming while flying gives up control of the drone.
$('#pilotLine').addEventListener('click',()=>{
  $('#pilotName').value=myName;
  const flying=Object.keys(FLEET).filter(c=>{const d=droneOf(c);return d?.pilot?.me&&d.flight==='flying'}).map(c=>c[0].toUpperCase()+c.slice(1));
  const warning=$('#nameWarning');
  warning.hidden=!flying.length;
  warning.textContent=flying.length?`You fly ${flying.join(' and ')}. With another name you can't command it, and the server lands it after 15 s.`:'';
  nameDialog.showModal();
});
// ---- Dashboard panels: Room, Drones, Phones (always on screen, no pop-ups) ----
const camerasDialog=$('#camerasDialog');
const mapDialog=$('#mapDialog');
const PANELS=['mapDialog','dronesDialog','camerasDialog'];
function showPanel(id){
  for(const pid of PANELS){
    const panel=$(`#${pid}`);
    const on=pid===id;
    panel.hidden=!on;
    panel.open=on;
  }
  for(const tab of document.querySelectorAll?.('.tab')??[]) tab.setAttribute('aria-selected',String(tab.dataset.panel===id));
  // Video streams only run on the panel that shows them.
  if(id!=='dronesDialog') $('#droneGrid').replaceChildren();
  if(id!=='camerasDialog') for(const img of $('#cameraGrid').querySelectorAll?.('img')??[]) img.removeAttribute('src');
  if(id==='dronesDialog') renderDrone();
  if(id==='camerasDialog') updateCameras();
  if(id==='mapDialog') void renderMap();
}
$('#dronesButton').addEventListener('click', () => showPanel('dronesDialog'));
$('#linkStatus').addEventListener('click', () => showPanel('dronesDialog'));
$('#camerasButton').addEventListener('click', () => showPanel('camerasDialog'));
$('#mapButton').addEventListener('click', () => showPanel('mapDialog'));

// ---- Phone cameras (Masoud's metoera-redzone) ----
// The server reads the phones and places the people they see on the plan. A person entering a red
// zone drawn on the plan is an event: Grok is told and, with auto-send on, this page claims it
// (only one page may) and sends the nearest drone to that person.
let redzone=null, eventsPrimed=false, autoSend=false;
const seenEvents=new Set();
try { autoSend=localStorage.getItem('metoera_autosend')==='1'; } catch {}
$('#autoSend').checked=autoSend;
$('#autoSend').addEventListener('change',()=>{ autoSend=$('#autoSend').checked; try{localStorage.setItem('metoera_autosend',autoSend?'1':'0')}catch{} });
let alertTimer=0;
function showZoneAlert(text){ const el=$('#zoneAlert'); el.textContent=text; el.hidden=false; clearTimeout(alertTimer); alertTimer=setTimeout(()=>{el.hidden=true},12000); }
let roomData=null; // {plan, room:{drones, cameras, zones}}
function zoneNote(){
  const zones=roomData?.room?.zones||[];
  return zones.length?` Red zones drawn on the room plan (metres): ${zones.map(z=>`${z.name} around (${(z.points.reduce((s,p)=>s+p[0],0)/z.points.length).toFixed(1)}, ${(z.points.reduce((s,p)=>s+p[1],0)/z.points.length).toFixed(1)})`).join(', ')}. Phones watch them; when a person enters one you get an automatic update with where the person is.`:'';
}
function handleRedzone(rz){
  redzone=rz;
  if(!rz) return;
  if(!eventsPrimed){ for(const e of rz.events||[]) seenEvents.add(e.id); eventsPrimed=true; }
  for(const e of rz.events||[]){ if(seenEvents.has(e.id)) continue; seenEvents.add(e.id); void onIntrusion(e); }
  void handlePadNav(rz.padNav ?? null);
  if(camerasDialog.open) updateCameras();
}

// ---- Pad-nav (cam1 → Black pad-01→pad-02): claim + fly under this named pilot ----
// Redzone only triggers (ARM required). This page claims so return-home voice commands work
// and the 15 s pilot-absent auto-land does not fire while Black waits at pad-02.
let padMissionBusy=false;
let lastPadReportId='';
async function padPhase(phase, extra={}){
  try {
    await fetch('/api/pad-nav/phase',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase,...extra})});
  } catch {}
}
async function runPadSteps(mission, steps, {pathOnly=false}={}){
  const id=mission.droneId||FLEET.black.id;
  const name=nameOf(id);
  let report=null;
  for(const step of steps||[]){
    const action=step.action;
    if(pathOnly && action==='takeoff') continue;
    if(action==='wait'){
      await padPhase('awaiting_command',{report:report||undefined, note:step.note||'Waiting for next command'});
      return {ok:true, report, waited:true};
    }
    if(action==='describe'){
      const result=await runOnDrone(id,'describe',{question:step.question||mission.describeQuestion||'Briefly describe the scene in two short sentences.'});
      if(!result.ok){ notifyGrok(`${name}: pad describe failed: ${result.error}`); await padPhase('failed',{error:result.error||'describe failed'}); return result; }
      report=typeof result.answer==='string'?result.answer:null;
      log('Pad · describe', report||'ok');
      continue;
    }
    const rest={};
    if(action==='move'){ rest.direction=step.direction; rest.centimeters=step.centimeters; }
    if(action==='rotate'){ rest.direction=step.direction; rest.degrees=step.degrees; }
    if(action==='go_to'){ rest.place=step.place||'home'; }
    const result=await runOnDrone(id, action, rest);
    if(!result.ok){ notifyGrok(`${name}: pad ${action} failed: ${result.error}`); await padPhase('failed',{error:result.error||`${action} failed`}); return result; }
    log(`Pad · ${action}`, action==='go_to'?(rest.place||'home'):(step.direction?`${step.direction} ${step.centimeters||step.degrees||''}`:'ok'));
  }
  return {ok:true, report};
}
async function claimAndFlyPadMission(state){
  if(padMissionBusy) return;
  if(!myName){ log('Pad nav','Set your name first — then the page can claim Black'); return; }
  const black=drones.find(d=>d.id===FLEET.black.id);
  if(!black?.connected || elsewhere(black) || blocked(black)){ log('Pad nav','Black not free on this laptop'); return; }
  padMissionBusy=true;
  try{
    const claim=await fetch('/api/pad-nav/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({claimedBy:myName, eventId:state.eventId})});
    const claimed=await claim.json();
    if(!claimed?.ok){ log('Pad nav', claimed?.error||'claim failed'); return; }
    const mission=claimed.mission||state.mission;
    if(!mission){ log('Pad nav','No mission payload'); return; }
    showZoneAlert(`Pad mission · Black ${mission.homePad||'pad-01'} → ${mission.targetPad||'pad-02'}`);
    notifyGrok(`Pad mission started for Black: takeoff from ${mission.homePad||'pad-01'}, then toward ${mission.targetPad||'pad-02'}. Say so in a few words.`,true);
    await padPhase('outbound',{note:`${myName} flying outbound`});
    const takeoffStep=(mission.steps||[]).find(s=>s.action==='takeoff')||{action:'takeoff'};
    const takeoff=await runOnDrone(FLEET.black.id,'takeoff',{});
    if(!takeoff.ok){ notifyGrok(`Black: pad takeoff failed: ${takeoff.error}`); await padPhase('failed',{error:takeoff.error||'takeoff failed'}); return; }
    log('Pad · takeoff', takeoffStep.note||'ok');
    if(!mission.executePath){
      await padPhase('awaiting_command',{note:'Takeoff done; path deferred (executePath=false). Enable executePath or PAD_NAV_EXECUTE_PATH=1 for the 2 m hop + describe.'});
      notifyGrok('Black took off for the pad mission, but the path to pad-02 is still disabled (executePath). Hovering — keep ARM discipline; enable the path only for a supervised 2.0 m test.',true);
      return;
    }
    const after=await runPadSteps(mission, mission.steps||[], {pathOnly:true});
    if(!after.ok) return;
    const report=after.report;
    if(report){
      lastPadReportId=String(Date.now());
      await padPhase('awaiting_command',{report, note:'At pad-02; waiting for return-home-land or go-home-wait'});
      notifyGrok(`Pad mission vision report at ${mission.targetPad||'pad-02'}: ${report} Black is hovering and waiting. Next command: return to home and land, or go to the first point and wait.`,true);
    } else {
      await padPhase('awaiting_command',{note:'Path complete; waiting for next command'});
      notifyGrok(`Black reached ${mission.targetPad||'pad-02'} and is waiting for the next command: return to home and land, or go to the first point and wait.`,true);
    }
  } catch(error){
    await padPhase('failed',{error:error?.message||'pad mission error'});
    log('Pad nav', error?.message||'failed');
  } finally {
    padMissionBusy=false;
    void refreshDrone();
  }
}
function handlePadNav(pad){
  const state=pad?.state;
  if(!state) return;
  if(state.reportId && state.reportId!==lastPadReportId && state.report && state.phase==='awaiting_command' && !padMissionBusy){
    lastPadReportId=state.reportId;
    // Report already spoken when this page ran describe; skip duplicate if we own it.
  }
  if(state.phase==='triggered' && !padMissionBusy) void claimAndFlyPadMission(state);
}
async function onIntrusion(e){
  const sending=autoSend;
  showZoneAlert(`Person in ${e.name}${sending?' · sending the nearest drone':''}`);
  log(e.name,`Person at ${e.x.toFixed(1)}, ${e.y.toFixed(1)} m`);
  notifyGrok(`${e.name}: a person entered, standing at (${e.x.toFixed(2)}, ${e.y.toFixed(2)}) m on the room plan, which is (${Math.round(e.x*100)}, ${Math.round(e.y*100)}) cm in drone coordinates. ${sending?'The nearest drone is being sent automatically; say so in a few words.':'Tell the person in one short sentence and offer to send a drone (dispatch with those cm coordinates).'}`);
  if(!sending) return;
  try {
    const r=await fetch('/api/redzone/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:e.id})});
    const j=await r.json();
    if(j.ok) void runDispatch({x:Math.round(j.x*100),y:Math.round(j.y*100),label:'person'},generation);
  } catch {}
}
async function cameraCommand(slot,command){
  try { const r=await fetch('/api/cameras/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot,command})}); return await r.json(); }
  catch { return {ok:false,error:'Server unreachable'}; }
}
function cameraCard(slot){
  const card=document.createElement('article');
  card.className='camera-card';
  card.dataset.slot=slot.id;
  card.innerHTML=`<div class="drone-card-head"><h3>Phone ${slot.id}</h3><span class="camera-state"></span></div><div class="camera-video"><img alt=""><span>No picture yet</span></div><div class="camera-controls"><button class="watch"></button><div class="lens"><button data-lens="wide">Wide</button><button data-lens="normal">Normal</button><button data-lens="tele">Tele</button></div></div><label class="camera-sens">Sensitivity <input type="range" min="0" max="100" step="5" class="sens"></label><label class="camera-arm"><input type="checkbox" class="arm"> ARM: phone may take off a drone by itself (keep off)</label><div class="camera-link"><input readonly aria-label="Link for phone ${slot.id}"><button class="copy">Copy</button></div><p class="camera-result" role="status"></p>`;
  const out=card.querySelector('.camera-result');
  const run=async(command,done)=>{ const j=await cameraCommand(slot.id,command); out.textContent=j.ok===false?(j.error||'Failed'):done; };
  card.querySelector('.watch').addEventListener('click',()=>{ const s=redzone?.slots?.find(x=>x.id===slot.id); void run({type:'watch',watching:!s?.watching},s?.watching?'Stopped watching':'Watching'); });
  for(const b of card.querySelectorAll('.lens button')) b.addEventListener('click',()=>void run({type:'lens',lens:b.dataset.lens},`Lens: ${b.textContent}`));
  card.querySelector('.sens').addEventListener('change',e=>void run({type:'sensitivity',sensitivity:Number(e.target.value)},`Sensitivity ${e.target.value}`));
  card.querySelector('.arm').addEventListener('change',e=>{ if(e.target.checked&&!confirm('With ARM on the phone itself can make a drone take off. Only with someone next to the drone. Turn ARM on?')){ e.target.checked=false; return; } void run({type:'arm',armed:e.target.checked},e.target.checked?'ARM on':'ARM off'); });
  card.querySelector('.copy').addEventListener('click',async()=>{ const v=card.querySelector('.camera-link input').value; try{ await navigator.clipboard.writeText(v); out.textContent='Link copied'; }catch{ card.querySelector('.camera-link input').select(); out.textContent='Select and copy the link'; } });
  return card;
}
function updateCameras(){
  const grid=$('#cameraGrid');
  if(!redzone){ $('#camerasNote').textContent='Server unreachable.'; return; }
  $('#camerasNote').textContent=redzone.available?`Camera service running · its own console: ${redzone.console}`:'Camera service not running: start it with npm start in metoera-redzone.';
  for(const slot of redzone.slots||[]){
    let card=grid.querySelector?.(`[data-slot="${slot.id}"]`);
    if(!card){ card=cameraCard(slot); grid.append(card); }
    const state=!slot.online?'Phone not connected':`${slot.watching?'Watching':'Not watching'} · ${slot.peopleCount||0} people · ${slot.calibrated?'calibrated':'not calibrated'}${slot.armed?' · ARM on':''}`;
    card.querySelector('.camera-state').textContent=state;
    card.querySelector('.watch').textContent=slot.watching?'Stop watching':'Start watching';
    card.querySelector('.watch').disabled=!slot.online;
    for(const b of card.querySelectorAll('.lens button')){ b.disabled=!slot.online||slot.lensesAvailable?.[b.dataset.lens]===false; b.classList.toggle('active',slot.lens===b.dataset.lens); }
    const sens=card.querySelector('.sens'); if(document.activeElement!==sens&&typeof slot.sensitivity==='number') sens.value=slot.sensitivity;
    card.querySelector('.arm').checked=Boolean(slot.armed);
    const link=card.querySelector('.camera-link input');
    const want=slot.link||'Start metoera-redzone to get the phone link';
    if(link.value!==want) link.value=want;
    const img=card.querySelector('.camera-video img'), box=card.querySelector('.camera-video');
    if(slot.online&&slot.hasPreview){ if(!img.getAttribute('src')) img.src=`/cameras/${slot.id}.mjpeg`; box.classList.remove('off'); }
    else { img.removeAttribute('src'); box.classList.add('off'); }
  }
}

// ---- Room panel: the plan, live, and the setup tools ----
// Plan frame: metres, x to the right, y up. The drones use the same frame in cm.
const SVGNS='http://www.w3.org/2000/svg';
function svgEl(tag,attrs,text){const e=document.createElementNS(SVGNS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e}
let roomTool='view', placeStart=null, draftZone=[], calib=null, lastMap=null;
async function loadRoom(){
  try { const r=await fetch('/api/room',{cache:'no-store'}); if(r.ok) roomData=await r.json(); } catch {}
}
const HINTS={
  view:'The plan of the room, live: drones, phones, people and red zones. Pick a tool to set it up.',
  place:'Click where it stands on the plan, then click again in the direction it faces.',
  zone:'Click the corners of the red zone on the plan, then Finish zone.',
};
function setTool(t){
  roomTool=t; placeStart=null; draftZone=[];
  for(const b of document.querySelectorAll?.('.room-tools .tool')??[]) b.classList.toggle('active',b.dataset.tool===t);
  $('#zoneFinish').hidden=t!=='zone'; $('#zoneCancel').hidden=t!=='zone';
  const cal=t.startsWith('calibrate:');
  $('#calibration').hidden=!cal;
  $('#roomHint').textContent=cal?'Click a floor point in the phone picture, then the same point on the plan. Four times, spread out (corners, pillars, tape marks).':t.startsWith('place:')?HINTS.place:HINTS[t]||HINTS.view;
  if(cal) startCalibration(t.split(':')[1]); else calib=null;
  void renderMap();
}
for(const b of document.querySelectorAll?.('.room-tools .tool')??[]) b.addEventListener('click',()=>setTool(b.dataset.tool));
async function post(url,body){ try{ const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return await r.json(); }catch{ return {ok:false,error:'Server unreachable'}; } }
function planPoint(evt){
  const svg=$('#mapSvg'); const pt=svg.createSVGPoint(); pt.x=evt.clientX; pt.y=evt.clientY;
  const p=pt.matrixTransform(svg.getScreenCTM().inverse());
  return [Math.round(p.x)/100, Math.round(-p.y)/100]; // screen y is down, plan y is up
}
$('#mapSvg').addEventListener?.('click',async evt=>{
  if(roomTool==='view') return;
  const p=planPoint(evt);
  if(roomTool.startsWith('place:')){
    if(!placeStart){ placeStart=p; $('#roomHint').textContent='Now click in the direction it faces.'; void renderMap(); return; }
    const at=placeStart; placeStart=null;
    const heading=Math.round(Math.atan2(p[1]-at[1],p[0]-at[0])*180/Math.PI);
    const what=roomTool.split(':')[1];
    const j=what.startsWith('cam')?await post('/api/room/camera',{slot:what.slice(3),x:at[0],y:at[1],heading}):await post('/api/room/drone',{id:what,x:at[0],y:at[1],heading});
    $('#roomHint').textContent=j.ok?`Saved: ${what.startsWith('cam')?`phone ${what.slice(3)}`:what==='tello'?'Black':'Red'} at (${at[0].toFixed(2)}, ${at[1].toFixed(2)}) m, facing ${heading}°.`:j.error;
    await loadRoom(); void renderMap(); return;
  }
  if(roomTool==='zone'){ draftZone.push(p); void renderMap(); return; }
  if(calib&&calib.img.length>calib.plan.length){ calib.plan.push(p); updateCalibration(); void renderMap(); }
});
$('#zoneFinish').addEventListener('click',async()=>{
  if(draftZone.length<3){ $('#roomHint').textContent='A zone needs at least 3 corners.'; return; }
  const zones=[...(roomData?.room?.zones||[]),{id:`z${Date.now()}`,name:`Zone ${(roomData?.room?.zones?.length||0)+1}`,points:draftZone}];
  const j=await post('/api/room/zones',{zones});
  $('#roomHint').textContent=j.ok?`Saved ${zones[zones.length-1].name}.`:j.error;
  draftZone=[]; await loadRoom(); void renderMap();
});
$('#zoneCancel').addEventListener('click',()=>{ draftZone=[]; void renderMap(); });
$('#zonesClear').addEventListener('click',async()=>{ if(!confirm('Delete all red zones?')) return; await post('/api/room/zones',{zones:[]}); await loadRoom(); void renderMap(); });
// Calibration: four pairs of (point in the phone picture, same point on the plan).
function startCalibration(slot){
  calib={slot,img:[],plan:[]};
  $('#calTitle').textContent=`Calibrate phone ${slot}`;
  $('#calImage').src=`/cameras/${slot}.jpg?t=${Date.now()}`;
  updateCalibration();
}
function updateCalibration(){
  if(!calib) return;
  const n=calib.plan.length, waitingPlan=calib.img.length>calib.plan.length;
  $('#calStep').textContent=n>=4?'Four points done. Save, or add more points for a better fit.':waitingPlan?`Point ${n+1}: now click the same spot on the plan.`:`Point ${n+1} of 4: click a floor spot in the picture.`;
  $('#calSave').disabled=n<4||waitingPlan;
  const marks=$('#calMarks'); marks.replaceChildren();
  calib.img.forEach(([u,v],i)=>{ marks.append(svgEl('circle',{cx:u,cy:v,r:.022,fill:'#ff1744',stroke:'#fff','stroke-width':.006})); marks.append(svgEl('text',{x:u+.015,y:v-.01,'font-size':.06,fill:'#ff1744'},String(i+1))); });
}
$('#calImage').addEventListener?.('click',evt=>{
  if(!calib||calib.img.length>calib.plan.length) return;
  const r=evt.target.getBoundingClientRect();
  calib.img.push([(evt.clientX-r.left)/r.width,(evt.clientY-r.top)/r.height]);
  updateCalibration();
});
$('#calRefresh').addEventListener('click',()=>{ if(calib) $('#calImage').src=`/cameras/${calib.slot}.jpg?t=${Date.now()}`; });
$('#calUndo').addEventListener('click',()=>{ if(!calib) return; if(calib.img.length>calib.plan.length) calib.img.pop(); else { calib.img.pop(); calib.plan.pop(); } updateCalibration(); void renderMap(); });
$('#calSave').addEventListener('click',async()=>{
  if(!calib) return;
  const j=await post('/api/room/camera',{slot:calib.slot,img:calib.img,plan:calib.plan});
  $('#calStep').textContent=j.ok?`Saved. Fit error ${j.errorM!=null?`${Math.round(j.errorM*100)} cm`:'n/a'}${j.errorM>0.3?': click the points more carefully, or use points farther apart':''}.`:j.error;
  await loadRoom(); void renderMap();
});

async function renderMap(){
  if(!roomData) await loadRoom();
  let data;
  try { const r=await fetch('/api/map',{cache:'no-store'}); data=await r.json(); if(!r.ok||!Array.isArray(data.drones)) throw 0; lastMap=data; }
  catch { data=lastMap; if(!data){ $('#mapNote').textContent='Map unavailable.'; return; } }
  const svg=$('#mapSvg');
  svg.replaceChildren();
  const plan=roomData?.plan;
  // cm, x right, y up -> screen X = x, screen Y = -y.
  const b=plan?{x0:plan.bounds.min[0]*100-80,x1:plan.bounds.max[0]*100+80,y0:plan.bounds.min[1]*100-80,y1:plan.bounds.max[1]*100+80}:{x0:-500,x1:500,y0:-400,y1:400};
  const W=b.x1-b.x0, H=b.y1-b.y0;
  svg.setAttribute('viewBox',`${b.x0} ${-b.y1} ${W} ${H}`);
  const unit=Math.max(W,H)/600;
  for(let g=Math.ceil(b.x0/100)*100;g<=b.x1;g+=100) svg.append(svgEl('line',{x1:g,y1:-b.y1,x2:g,y2:-b.y0,class:'map-grid','stroke-width':unit}));
  for(let g=Math.ceil(b.y0/100)*100;g<=b.y1;g+=100) svg.append(svgEl('line',{x1:b.x0,y1:-g,x2:b.x1,y2:-g,class:'map-grid','stroke-width':unit}));
  for(const a of plan?.above||[]){
    if(['Corpo4','Corpo16','Corpo17'].includes(a.solid)) continue; // roof
    svg.append(svgEl('rect',{x:a.min[0]*100,y:-a.max[1]*100,width:(a.max[0]-a.min[0])*100,height:(a.max[1]-a.min[1])*100,fill:'#1e88e5','fill-opacity':.05,stroke:'#1e88e5','stroke-dasharray':`${8*unit} ${6*unit}`,'stroke-width':unit}));
  }
  for(const w of plan?.walls||[]) svg.append(svgEl('line',{x1:w.a[0]*100,y1:-w.a[1]*100,x2:w.b[0]*100,y2:-w.b[1]*100,stroke:'#222','stroke-width':3*unit,'stroke-linecap':'round'}));
  // Red zones
  for(const z of data.zones||[]){
    svg.append(svgEl('polygon',{points:z.points.map(p=>`${p[0]*100},${-p[1]*100}`).join(' '),fill:'#e53935','fill-opacity':z.occupied?.35:.12,stroke:'#e53935','stroke-width':(z.occupied?4:2)*unit}));
    const cx=z.points.reduce((s,p)=>s+p[0],0)/z.points.length*100, cy=z.points.reduce((s,p)=>s+p[1],0)/z.points.length*100;
    svg.append(svgEl('text',{x:cx,y:-cy,'font-size':14*unit,'font-weight':600,fill:'#c62828','text-anchor':'middle'},`${z.name}${z.occupied?' · person!':''}`));
  }
  if(draftZone.length){
    svg.append(svgEl('polyline',{points:draftZone.map(p=>`${p[0]*100},${-p[1]*100}`).join(' '),fill:'none',stroke:'#e53935','stroke-width':2*unit,'stroke-dasharray':`${6*unit} ${4*unit}`}));
    for(const p of draftZone) svg.append(svgEl('circle',{cx:p[0]*100,cy:-p[1]*100,r:5*unit,fill:'#e53935'}));
  }
  // Phones: position and view direction
  for(const [slot,c] of Object.entries(data.cameras||{})){
    if(typeof c.x!=='number') continue;
    const h=(c.heading||0)*Math.PI/180, x=c.x*100, y=-c.y*100, L=120*unit;
    const a1=h-0.6,a2=h+0.6;
    svg.append(svgEl('path',{d:`M${x},${y} L${x+Math.cos(a1)*L},${y-Math.sin(a1)*L} L${x+Math.cos(a2)*L},${y-Math.sin(a2)*L} Z`,fill:'#7e57c2','fill-opacity':.15,stroke:'#7e57c2','stroke-width':unit}));
    svg.append(svgEl('rect',{x:x-8*unit,y:y-8*unit,width:16*unit,height:16*unit,rx:3*unit,fill:'#7e57c2'}));
    svg.append(svgEl('text',{x:x+11*unit,y:y-10*unit,'font-size':12*unit,fill:'#5e35b1'},`Phone ${slot}${c.calibrated?'':' · not calibrated'}`));
  }
  // People seen by the phones (feet on the floor)
  for(const p of data.people||[]){
    svg.append(svgEl('circle',{cx:p.x*100,cy:-p.y*100,r:10*unit,fill:'#fb8c00',stroke:'#fff','stroke-width':2*unit}));
    svg.append(svgEl('text',{x:p.x*100+13*unit,y:-p.y*100+4*unit,'font-size':11*unit,fill:'#e65100'},`person (phone ${p.slot})`));
  }
  // Calibration points on the plan
  if(calib) calib.plan.forEach((p,i)=>{ svg.append(svgEl('circle',{cx:p[0]*100,cy:-p[1]*100,r:7*unit,fill:'#e53935'})); svg.append(svgEl('text',{x:p[0]*100+9*unit,y:-p[1]*100-6*unit,'font-size':13*unit,fill:'#e53935'},String(i+1))); });
  if(placeStart) svg.append(svgEl('circle',{cx:placeStart[0]*100,cy:-placeStart[1]*100,r:8*unit,fill:'none',stroke:'#111','stroke-width':2*unit}));
  // Drones, what they saw, depth hits
  const colours={tello:'#1c1c1c',rmtt:'#d32f2f'};
  let things=0;
  for(const d of data.drones){
    const c=colours[d.id]||'#555';
    for(const o of d.obstacles||[]) svg.append(svgEl('rect',{x:o.x-4*unit,y:-o.y-4*unit,width:8*unit,height:8*unit,fill:'#9e9e9e',opacity:.5}));
    if(d.path.length>1) svg.append(svgEl('polyline',{points:d.path.map(p=>`${p.x},${-p.y}`).join(' '),fill:'none',stroke:c,'stroke-width':2*unit,'stroke-dasharray':`${6*unit} ${4*unit}`,opacity:.6}));
    for(const[name,p]of Object.entries(d.places||{})){
      svg.append(svgEl('rect',{x:p.x-5*unit,y:-p.y-5*unit,width:10*unit,height:10*unit,fill:'none',stroke:c,'stroke-width':1.5*unit}));
      svg.append(svgEl('text',{x:p.x-8*unit,y:-p.y+14*unit,'font-size':10*unit,fill:c,'text-anchor':'end'},name.replace('_',' ')));
    }
    for(const s of d.sightings){
      things++;
      const person=s.label==='person', col=person?'#1e88e5':'#43a047';
      if(s.approx){ svg.append(svgEl('line',{x1:s.fromX,y1:-s.fromY,x2:s.x,y2:-s.y,stroke:col,'stroke-width':1.2*unit,'stroke-dasharray':`${2*unit} ${3*unit}`,opacity:.7})); continue; }
      svg.append(svgEl('circle',{cx:s.x,cy:-s.y,r:(person?6:4.5)*unit,fill:col}));
      svg.append(svgEl('text',{x:s.x+9*unit,y:-s.y+4*unit,'font-size':10*unit,fill:'#333'},(s.description||s.label).slice(0,28)));
    }
    const h=d.pose.heading*Math.PI/180, px=d.pose.x, py=-d.pose.y;
    svg.append(svgEl('line',{x1:px,y1:py,x2:px+Math.cos(h)*30*unit,y2:py-Math.sin(h)*30*unit,stroke:c,'stroke-width':4*unit,'stroke-linecap':'round'}));
    svg.append(svgEl('circle',{cx:px,cy:py,r:12*unit,fill:c}));
    svg.append(svgEl('text',{x:px+15*unit,y:py-14*unit,'font-size':13*unit,'font-weight':600,fill:c},d.id==='tello'?'Black':d.id==='rmtt'?'Red':d.id));
  }
  $('#mapNote').textContent=`${plan?'Capannone plan · ':''}grid 1 m · black = walls · purple = phones · orange = people seen by phones · red = zones · ${things} things the drones saw · positions of drones come from their own moves and drift a little.`;
}
if (storedName()) rememberName(storedName());
refreshDrone();
setInterval(refreshDrone, 1500);
// The map refreshes on its own timer, registered after the drone poll.
setInterval(()=>{if(mapDialog.open) void renderMap()},1500);
showPanel('mapDialog');
