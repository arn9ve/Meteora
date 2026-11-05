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
// A long task (a flight to a table, a scan…) must not make the next command wait: a new command for
// the same drone stops it first. Status and memory never wait at all.
const LONG_TASKS=['go_to','calibrate','explore','scan','find','approach','pad_hop','test_flight','localize'];
const READ_NOW=['status','memory'];
const longTask={};
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
    const body=JSON.stringify({...rest,droneId:id,action:name});
    let response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body});
    let result=await response.json();
    // The server forgot this browser's name (restarted, or a new session): say it again and retry once.
    if(!result.ok&&myName&&/Type your name first/.test(String(result.error||''))){
      await sendName(myName);
      response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body});
      result=await response.json();
    }
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
      if(LONG_TASKS.includes(name)) longTask[id]=name;
      const result=await runOnDrone(id,name,rest).finally(()=>{ if(longTask[id]===name) delete longTask[id]; });
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
    if(URGENT.includes(name)||READ_NOW.includes(name)) void task();
    else {
      // A new order while it is flying somewhere: that flight stops here, this one goes next.
      if(longTask[id]){ log(`${nameOf(id)} · ${actionLabels[longTask[id]]||longTask[id]}`,'Interrupted by a new command'); void runOnDrone(id,'stop',{}); }
      droneQueues[id]=(droneQueues[id]??Promise.resolve()).then(task,task);
    }
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
const INSTRUCTIONS='You are Grok, the voice pilot of two real drones for Metoera: Drone 1, called Black (a Tello EDU), and Drone 2, called Red (a RoboMaster TT). Every drone tool takes drone: black or red. If the person does not say which drone and more than one could be meant, ask; never choose for them. If they say both or all, call the tool for black and for red in the same reply: they run at the same time. land and stop without a drone apply to every drone you fly. If the person asks you to choose which drone to fly or land, call status on black and on red first and wait for both updates, prefer a connected drone that is on the ground with more battery for flying (at least 20 percent), say which one you picked and why, then act. If they ask to test the drones, propose a short plan (for example: status on both, test_flight on black, then test_flight on red), and run it step by step only after they agree. Each drone has its own camera with object detection: scan and look take drone black or red, and for both drones call them once per drone and report the result of each drone separately. Every tool call physically moves a drone, so do exactly what the person says: no extra steps, no skipped steps, no changed values. Speak in the language the person uses (usually Italian) and be very brief: do exactly what is asked and nothing more. Confirm a command with one or two words (for example: ok, fatto, decollo). Never mention battery, height, heading, distances, counts or other drone data unless the person asks for it, and then answer only that. Understand natural commands in Italian or English: destra = right, sinistra = left, avanti = forward, indietro = back, su = up, giù = down, ruota/gira = rotate, girati = rotate 180, fai una foto = photo, atterra = land, decolla = take off, fermati = stop. If no distance is given, move uses 50 cm; if no angle is given, rotate uses 90 degrees; a little = 30 cm, a lot = 100 cm. Only ask when the drone or the direction is really unclear. Convert units yourself: 1 meter = 100 centimeters, half a meter = 50. Turn right means clockwise, turn left means counterclockwise. Drone tools answer at once with status started: the drone works in the background and you receive an automatic drone update message when it is done or failed. Never wait for a drone before handling the next request: the two drones are independent and run at the same time, so you can command Red while Black is still busy. For a sequence on the same drone, call its tools in order in one go; they run in that order, and if one fails the rest for that drone is skipped. When a drone update says done for an action, stay silent. Speak about an update only when it failed (say why in one short sentence) or when it answers something the person asked. If the person says stop, wait, hold or freeze, call stop at once. If they say land, or sound alarmed, call land at once. If they just say fly or test flight, call test_flight. The drone has a camera with object detection. To count or find things all around (for example: do a 360 and count the people at the table), take off first if it is on the ground, then call scan with the object name in English (person for people). scan turns a full circle in four 90-degree steps and returns a count per view and a total; give the total, mention where they are if useful, and say it is approximate because someone at the edge between two views can be missed or counted twice. To say what is in front of the drone right now, or how many people it sees, call look (label person to count people); to count all around, scan. For a photo, call photo. To understand the scene precisely (clothes, colours, who is where), call describe: it sends the camera image to Grok vision. To find something described in words (la persona con la maglietta verde), call find with the full description; it turns the drone to face it, then call approach to go there. Each drone remembers its position (room frame from its first takeoff), its actions, saved places and what it saw: call memory before answering about the past or where things are. To go back somewhere (torna dove eri, torna a casa, torna al punto di prima), call go_to with place home, last_landing, previous or a saved name, or x,y from memory; if the drone is on the ground, take off first. Save a spot with mark when asked to remember it. Mission pads: to go to the next pad (vai al prossimo pad, vai al pad successivo), call pad_hop on that drone (take off first if it is on the ground); add land true if they say to land on it. Pad-nav demo (Black on pad-01 home → pad-02 target): after an automatic pad mission update says Black is waiting at the target, listen for the next command — do not land by yourself. If they say return to home and land, return home and land, torna a casa e atterra, or rientra e atterra: on black call go_to with place home, then land. If they say go to the first point and wait, go home and wait, vai al primo punto e aspetta, or torna al primo punto e aspetta: on black call go_to with place home only (hover; do not land). When an automatic update includes a pad mission vision report, say that short report in a few words, then say you are waiting for the next command. To send a drone to someone or something without naming the drone (mandami un drone, manda quello più vicino), take its x,y from memory (sightings; match the description, e.g. green t-shirt) and call dispatch with x, y and label: the server chooses the nearest free drone. If it is not in memory yet, explore or find first. If the person names the drone (mandami il rosso dalla persona), call go_to with the x,y on that drone, then face, then approach. To explore or map the room (esplora la stanza, mappa la stanza), call explore; with both drones, call explore for black and for red in the same reply so they work at the same time. Both drones share one room map (Map button on the page). After explore, answer in one sentence with what was found. For where is X questions, call memory and use the sightings (room coordinates in cm; x = toward the wall both drones faced at the start, y = left). Use what you learned earlier in the conversation and from memory; never forget a result you already got. To come toward someone or something (vieni verso la persona, avvicinati alla bottiglia), call approach with the object name in English (person by default); it stops about 1 m away, or the distance the person says (vicino = 60 cm). The drone must be flying; if it is on the ground, say so. Report only what the results contain; never invent objects. If the person says emergency, cut the motors or kill the motors, call emergency at once (leave drone empty to stop every drone you fly): the motors stop and the drone drops. If they say stop listening, mute or microphone off, call mute; after that you hear nothing until they turn the microphone back on. Every drone update carries where: the position of the drone in words from the room plan (above table 1, next to table 3, between table 1 and pillar 3). When asked where a drone is (dove sei, dove si trova), call status and say that place in a few words; never read out coordinates. A new command for a drone that is still flying somewhere stops that flight and runs at once. Only say a drone did something when its drone update says done, and report rejections in plain words, including limits such as the maximum distance.';
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
  droneTool('pad_hop','Fly straight ahead until the drone is over the next mission pad (a different pad from the one below it), then centre over it (vai al prossimo pad, vai al pad successivo). Uses the drone\'s own pad sensor, no map. Must be flying. Stops and hovers if no pad within maxCentimeters',{maxCentimeters:{type:'integer',minimum:20,maximum:800,description:'Give up after this many cm, default 400'},land:{type:'boolean',description:'Land on the pad when there (atterra sul pad)'}},[]),
  droneTool('approach','Fly toward the person or object in front of the drone and stop at a safe distance (vieni verso, avvicinati, vai dalla persona). Uses the camera only; distances are estimates',{label:{type:'string',description:'Object class in English, default person'},stopCm:{type:'integer',minimum:50,maximum:300,description:'How far from it to stop, default 100'}},[]),
  droneTool('explore','Explore the room from where the drone is: six photos turning all around, YOLO and Grok vision put people, furniture and objects on the room map (esplora, guardati intorno e ricorda). Drone must be flying'),
  droneTool('describe','Look through the camera with Grok vision and answer a question about the scene (cosa vedi, chi c\'è, di che colore è). Precise: clothes, colours, positions',{question:{type:'string',description:'What to look for or ask about the image'}},[]),
  droneTool('find','Find something described in words (la persona con la maglietta verde, lo zaino rosso): takes photos all around, Grok vision picks it, and the drone turns to face it. Drone must be flying. Then call approach to fly to it',{description:{type:'string',description:'What to find, with details'}},['description']),
  droneTool('memory','What this drone remembers: position in the room, the last actions, saved places and things it saw with their position'),
  droneTool('face','Turn this drone to face a point of the room map (x,y from memory)',{x:{type:'integer'},y:{type:'integer'}},['x','y']),
  droneTool('mark','Save the current position under a name (ricorda questo punto come …)',{name:{type:'string'}},['name']),
  droneTool('go_to','Fly into a red zone by its name (vai nella zona 1: place "Zone 1"; it ends inside the zone and checks it with a photo), or to a table or object of the room plan by its name (table 1 … table 6; with centre true it goes over the middle of the table: al centro del tavolo, sopra il tavolo), or to a remembered place: home (where it took off), last_landing, previous, a name saved with mark, or room coordinates x,y in cm from memory. The server plans a way around tables, pillars and walls and stops next to a table, not above it; a table with a mission pad is the exception: the drone goes over it and centres exactly on the pad. Drone must be flying',{place:{type:'string'},x:{type:'integer'},y:{type:'integer'},centre:{type:'boolean',description:'Over the middle of the table instead of next to it'}},[]),
  droneTool('preflight','Check before flying to a place, nothing moves (controlla prima, funzionerà?, sei pronto?): says whether it should work, what could go wrong and how long it takes. Say the verdict, the main risk and the time in two short sentences',{place:{type:'string',description:'Where it would go, e.g. centre of table 3'}},['place']),
  droneTool('calibrate','Calibration test (fai la calibrazione, testa la precisione): the drone must be on the ground on its take-off spot; it takes off, flies right, left, right, forward, back, forward, comes back to the start with its telemetry and lands, then reports the error of each move. Takes about a minute',{sizeCm:{type:'integer',minimum:20,maximum:80,description:'Size of the moves, default 50'},photo:{type:'boolean',description:'Also check the position with a photo'}},[]),
  droneTool('localize','Check where the drone really is: one photo, Grok vision recognises the pillars and tables of the room plan in it, and the position is corrected (dove sei esattamente, controlla la posizione, ricalibra la posizione). Must be flying; it is also done by itself at the end of a go_to when the position is in doubt'),
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
const coordinates = d => d?.connected ? `Battery ${d.battery ?? '–'}% · Height ${d.heightCm ?? '–'} cm${Number.isFinite(d.heightAboveFloorCm) && d.startSurface?.heightCm ? ` (${d.heightAboveFloorCm} cm above the floor)` : ''}${d.startSurface ? ` · ${surfaceText(d)}` : ''}` : 'Unavailable';
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
    // This page has a name but the server session has none (server restarted): send it again.
    if(nameDecided&&myName&&!(data.pilot&&data.pilot.name)&&!resendingName){ resendingName=true; void sendName(myName).finally(()=>{resendingName=false}); }
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
let nameDecided=false, resendingName=false;
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
// On unless this browser turned it off.
autoSend=true; try { autoSend=localStorage.getItem('metoera_autosend')!=='0'; } catch {}
$('#autoSend').checked=autoSend;
$('#autoSend').addEventListener('change',()=>{ autoSend=$('#autoSend').checked; try{localStorage.setItem('metoera_autosend',autoSend?'1':'0')}catch{} });
let alertTimer=0;
function showZoneAlert(text){ const el=$('#zoneAlert'); el.textContent=text; el.hidden=false; clearTimeout(alertTimer); alertTimer=setTimeout(()=>{el.hidden=true},12000); }
let roomData=null; // {plan, room:{drones, cameras, zones}}
function zoneNote(){
  const zones=roomData?.room?.zones||[], objects=roomData?.room?.objects||[];
  const z=zones.length?` Red zones drawn on the room plan (metres): ${zones.map(q=>`${q.name} around (${(q.points.reduce((s,p)=>s+p[0],0)/q.points.length).toFixed(1)}, ${(q.points.reduce((s,p)=>s+p[1],0)/q.points.length).toFixed(1)})`).join(', ')}. Phones watch them; when a person enters one you get an automatic update with where the person is.`:'';
  const o=objects.length?` Things on the room plan, by name: ${objects.map(q=>`${q.name} (${q.kind}, ${q.w}x${q.d} m)`).join(', ')}. To go to one (vai al tavolo 1), call go_to with place set to its name: the server flies around tables and pillars and stops next to it, not above it. For a tour (fai il giro dei tavoli, passa da tutti i tavoli) call go_to once per table in the order asked (default table 1, 2, 3 … in order), all in one reply so they run one after the other, then go_to home if they ask to come back. Moves the person gives in metres or centimetres (vai avanti di un metro e mezzo) are relative moves with move: split anything over 100 cm into steps of at most 100 cm.`:'';
  return z+o;
}
function handleRedzone(rz){
  redzone=rz;
  if(!rz) return;
  // On page load, old alarms are not replayed; one from the last 10 s is still handled.
  if(!eventsPrimed){ for(const e of rz.events||[]) if(Date.now()-e.at>10000) seenEvents.add(e.id); eventsPrimed=true; }
  for(const e of rz.events||[]){ if(seenEvents.has(e.id)) continue; seenEvents.add(e.id); void onIntrusion(e); }
  void handlePadNav(rz.padNav ?? null);
  if(camerasDialog.open) updateCameras();
}

// ---- Pad-nav (cam1 → Black pad-01→pad-02): claim + fly under this named pilot ----
// Redzone only triggers (ARM required). This page claims so return-home voice commands work
// and the 15 s pilot-absent auto-land does not fire while Black waits at pad-02.
let padMissionBusy=false, autoDispatching=false;
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
    if(action==='pad_hop'){ if(Number.isInteger(step.maxCentimeters)) rest.maxCentimeters=step.maxCentimeters; if(typeof step.land==='boolean') rest.land=step.land; }
    const result=await runOnDrone(id, action, rest);
    if(!result.ok){ notifyGrok(`${name}: pad ${action} failed: ${result.error}`); await padPhase('failed',{error:result.error||`${action} failed`}); return result; }
    log(`Pad · ${action}`, action==='pad_hop'?`pad ${result.fromPad??'?'} → pad ${result.pad} (${result.travelledCm} cm)`:action==='go_to'?(rest.place||'home'):(step.direction?`${step.direction} ${step.centimeters||step.degrees||''}`:'ok'));
  }
  return {ok:true, report};
}
async function claimAndFlyPadMission(state){
  if(padMissionBusy) return;
  if(autoDispatching){ log('Pad nav','A drone is already on its way to a red-zone person: pad mission skipped'); return; }
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
    // Already in the air (hovering over the last pad): the next person means the next pad.
    if(black.flight!=='flying'){
      const takeoff=await runOnDrone(FLEET.black.id,'takeoff',{});
      if(!takeoff.ok){ notifyGrok(`Black: pad takeoff failed: ${takeoff.error}`); await padPhase('failed',{error:takeoff.error||'takeoff failed'}); return; }
      log('Pad · takeoff', takeoffStep.note||'ok');
    }
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
  // The old pad-to-pad mission is no longer started from here: a person in a red zone sends the
  // nearest drone into the zone with the full mission (onIntrusion -> runZoneMission).
  void state;
}
async function onIntrusion(e){
  // A person in a red zone, seen by a phone with ARM on: the nearest drone takes off (if needed)
  // and flies INTO the zone with the full mission: look around, reason, route, enter, check.
  // Automatic: the phone's own ARM switch (which it resets when it reconnects) no longer blocks it.
  const sending=autoSend&&!autoDispatching;
  showZoneAlert(`Person in ${e.name}${sending?' · sending the nearest drone':''}`);
  log(e.name,`Person at ${e.x.toFixed(1)}, ${e.y.toFixed(1)} m`);
  notifyGrok(`${e.name}: phone ${e.slot||''} sees a person. ${sending?`Say right now, in the person's language, in one short sentence: you saw a person in ${e.name} and you are going to check. The nearest drone is taking off by itself.`:`Tell the person in one short sentence and offer to send a drone (go_to place "${e.name}").`}`);
  if(!sending) return;
  try {
    const r=await fetch('/api/redzone/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:e.id})});
    const j=await r.json();
    if(j.ok){ autoDispatching=true; try{ await runZoneMission(e,generation); } finally { autoDispatching=false; } }
  } catch {}
}
async function runZoneMission(e,run){
  const goal=e.target||{x:e.x,y:e.y};
  let pick;
  try { pick=await (await fetch('/api/nearest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:Math.round(goal.x*100),y:Math.round(goal.y*100),stopCm:0})})).json(); } catch { pick={ok:false,error:'Server unreachable'}; }
  if(run!==generation) return;
  if(!pick.ok){ notifyGrok(`${e.name}: no drone can go: ${pick.error}`); return; }
  const id=pick.drone, name=nameOf(id);
  log(`${name} · ${e.name}`,'sent into the zone');
  longTask[id]='go_to';
  try {
    if(!pick.flying){ const up=await runOnDrone(id,'takeoff',{}); if(!up.ok){ notifyGrok(`${e.name}: ${name} could not take off: ${up.error}`); return; } }
    const r=await runOnDrone(id,'go_to',{place:e.name});
    void refreshDrone();
    notifyGrok(r.insideZone?`${name} is inside ${e.name}${r.checkedWithPhoto?', confirmed with a photo':''}. Say it in a few words.`:`${name} did not get inside ${e.name}: ${r.error||'unknown'}${r.where?` (it is ${r.where})`:''}. Say it in one short sentence.`);
  } finally { if(longTask[id]==='go_to') delete longTask[id]; }
}
async function cameraCommand(slot,command){
  try { const r=await fetch('/api/cameras/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot,command})}); return await r.json(); }
  catch { return {ok:false,error:'Server unreachable'}; }
}
function cameraCard(slot){
  const card=document.createElement('article');
  card.className='camera-card';
  card.dataset.slot=slot.id;
  card.innerHTML=`<div class="drone-card-head"><h3>Phone ${slot.id}</h3><span class="camera-state"></span></div><div class="camera-video"><img alt=""><span>No picture yet</span></div><div class="camera-controls"><button class="watch"></button><div class="lens"><button data-lens="wide">Wide</button><button data-lens="normal">Normal</button><button data-lens="tele">Tele</button></div></div><label class="camera-sens">Sensitivity <input type="range" min="0" max="100" step="5" class="sens"></label><label class="camera-arm"><input type="checkbox" class="arm"> ARM: a person this phone sees in a red zone makes the nearest drone take off and fly into the zone</label><div class="camera-link"><input readonly aria-label="Link for phone ${slot.id}"><button class="copy">Copy</button></div><p class="camera-result" role="status"></p>`;
  const out=card.querySelector('.camera-result');
  const run=async(command,done)=>{ const j=await cameraCommand(slot.id,command); out.textContent=j.ok===false?(j.error||'Failed'):done; };
  card.querySelector('.watch').addEventListener('click',()=>{ const s=redzone?.slots?.find(x=>x.id===slot.id); void run({type:'watch',watching:!s?.watching},s?.watching?'Stopped watching':'Watching'); });
  for(const b of card.querySelectorAll('.lens button')) b.addEventListener('click',()=>void run({type:'lens',lens:b.dataset.lens},`Lens: ${b.textContent}`));
  card.querySelector('.sens').addEventListener('change',e=>void run({type:'sensitivity',sensitivity:Number(e.target.value)},`Sensitivity ${e.target.value}`));
  card.querySelector('.arm').addEventListener('change',e=>{ void run({type:'arm',armed:e.target.checked},e.target.checked?'ARM on':'ARM off'); });
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
    const state=!slot.online?'Phone not connected':`${slot.watching?'Watching':'Not watching'} · ${slot.peopleCount||0} people · ${slot.calibrated?'calibrated':'estimate only'}${slot.armed?' · ARM on':''}`;
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

// ---- Room panel: the plan at real size, what is on it, and how to edit it ----
// One frame for everything: metres on the plan, x to the right, y up. The drones fly in the same
// frame in centimetres, so a drone placed here knows where every table, phone and zone is.
// Drawing is in centimetres with screen y = -y.
const SVGNS='http://www.w3.org/2000/svg';
function svgEl(tag,attrs,text){const e=document.createElementNS(SVGNS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e}
const DRONE_SIZE_CM={tello:[9.8,9.25],rmtt:[9.8,9.25]}; // Tello EDU and RoboMaster TT with prop guards
const PHONE_SIZE_CM=[7.5,15];
const LENS_FOV={wide:100,normal:68,tele:32};
const VIEW_RANGE_CM=600; // how far a phone cone is drawn
const OBJECT_KINDS=['table','shelf','wall','obstacle','other'];
const DRONE_LABEL={tello:'Black',rmtt:'Red'};
const DRONE_COLOUR={tello:'#111',rmtt:'#d32f2f'};
let viewTouched=false, mapLive=null, view=null, sel=null, mode=null, drag=null, rafPending=false, inspectorKey='';
const mapSvg=$('#mapSvg');
async function post(url,body){ try{ const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return await r.json(); }catch{ return {ok:false,error:'Server unreachable'}; } }
async function loadRoom(){ try { const r=await fetch('/api/room',{cache:'no-store'}); if(r.ok){ roomData=await r.json(); roomData.room.objects??=[]; } } catch {} }
const R=()=>roomData?.room??{drones:{},cameras:{},zones:[],objects:[]};
const slotOf=id=>redzone?.slots?.find(s=>s.id===String(id));
const droneById=id=>drones.find(d=>d.id===id);
// Live: the server streams each drone 10 times a second (position from its telemetry once the
// odometry is calibrated). The real track of the current flight is kept here for the map.
const liveDrones={}, trails={};
let liveSource=null, last3d=0;
function startLive(){
  if(liveSource||typeof EventSource==='undefined') return;
  liveSource=new EventSource('/api/live');
  liveSource.onmessage=e=>{
    let data; try { data=JSON.parse(e.data); } catch { return; }
    for(const d of data.drones||[]){
      const was=liveDrones[d.id]; liveDrones[d.id]=d;
      // A new flight plan for a drone this person flies: Grok says it before the drone moves.
      // Said by the page that sent the flight (or the pilot's page): what it is doing and why, before it moves.
      if(d.plan&&d.plan.at!==was?.plan?.at&&was&&(longTask[d.id]||drones.find(x=>x.id===d.id)?.pilot?.me)&&Date.now()-d.plan.at<8000) notifyGrok(`${nameOf(d.id)} is thinking out loud, before moving: ${d.plan.text} Say this reasoning to the person in two short sentences, in their language (where it is, what it saw, where the target is and what it will do), then that it is going.`,true);
      if(d.flying&&!was?.flying) trails[d.id]=[];
      if(d.flying){ const t=trails[d.id]||=[]; const q=t[t.length-1]; if(!q||Math.hypot(q[0]-d.pose.x,q[1]-d.pose.y)>=3){ t.push([d.pose.x,d.pose.y]); if(t.length>3000) t.shift(); } }
    }
    if(mapDialog.open){ scheduleDraw(); if(sel?.kind==='drone') updateInspectorLive(); if(Date.now()-last3d>500){ last3d=Date.now(); update3d(); } }
  };
  liveSource.onerror=()=>{ liveSource?.close(); liveSource=null; setTimeout(startLive,2000); };
}
const livePose=id=>liveDrones[id]?.pose??mapLive?.drones?.find(d=>d.id===id)?.pose;
const fmt=(v,n=2)=>Number.isFinite(v)?v.toFixed(n):'–';
function hint(text){ $('#roomHint').textContent=text||''; }
// Everything shown in centimetres from the inside corner of the room: from the left end wall (x)
// and from the long wall at the bottom of the plan (y). The plan and the drones keep metres/cm
// around the room centre inside; this is only how numbers are shown and typed.
const origin=()=>roomData?.plan?.inside_origin||roomData?.plan?.bounds?.min||[0,0];
const cmX=m=>Math.round((m-origin()[0])*100), cmY=m=>Math.round((m-origin()[1])*100);
function where(xm,ym){ return `${cmX(xm)} cm from the left wall · ${cmY(ym)} cm from the bottom wall`; }

// ---- view: zoom and pan ----
function upp(){ const w=mapSvg.clientWidth||600; return view?view.w/w:1; } // cm per screen pixel
function px(n){ return n*upp(); }
function fitView(){
  const b=roomData?.plan?.bounds; const box=b?{x0:b.min[0]*100,x1:b.max[0]*100,y0:b.min[1]*100,y1:b.max[1]*100}:{x0:-500,x1:500,y0:-400,y1:400};
  const pad=60, W=box.x1-box.x0+pad*2, H=box.y1-box.y0+pad*2;
  const aspect=(mapSvg.clientWidth||600)/(mapSvg.clientHeight||400);
  const w=Math.max(W,H*aspect), h=w/aspect;
  view={x:(box.x0+box.x1)/2-w/2, y:-(box.y0+box.y1)/2-h/2, w, h};
  applyView();
}
function applyView(){
  if(!view) return;
  const aspect=(mapSvg.clientWidth||600)/(mapSvg.clientHeight||400);
  view.h=view.w/aspect;
  mapSvg.setAttribute('viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);
  // Scale bar: a round length between 60 and 160 px.
  const per=upp(); const L=[10,20,50,100,200,500,1000,2000].find(l=>l/per>=60)||2000;
  $('#scaleBar').style.width=`${Math.round(L/per)}px`;
  $('#scaleText').textContent=L>=100?`${L/100} m`:`${L} cm`;
  scheduleDraw();
}
function zoomAt(factor,cx,cy){
  viewTouched=true;
  const w=Math.min(6000,Math.max(60,view.w*factor)); const k=w/view.w;
  view.x=cx-(cx-view.x)*k; view.y=cy-(cy-view.y)*k; view.w=w; applyView();
}
function svgPoint(evt){ const pt=mapSvg.createSVGPoint(); pt.x=evt.clientX; pt.y=evt.clientY; const p=pt.matrixTransform(mapSvg.getScreenCTM().inverse()); return {cx:p.x, cy:p.y, m:[Math.round(p.x)/100, Math.round(-p.y)/100]}; }
mapSvg.addEventListener?.('wheel',evt=>{ if(!view) return; evt.preventDefault(); const p=svgPoint(evt); zoomAt(Math.exp(evt.deltaY*0.0015),p.cx,p.cy); },{passive:false});
$('#zoomIn').addEventListener('click',()=>view&&zoomAt(0.7,view.x+view.w/2,view.y+view.h/2));
$('#zoomOut').addEventListener('click',()=>view&&zoomAt(1/0.7,view.x+view.w/2,view.y+view.h/2));
$('#zoomFit').addEventListener('click',()=>{ viewTouched=false; fitView(); });
// Until the person zooms or pans, keep the whole room in view when the panel changes size.
try { new ResizeObserver(()=>{ if(view) viewTouched?applyView():fitView(); }).observe(mapSvg); } catch {}

// ---- saving ----
async function saveDrone(id,facingConfirmed=false){ const d=R().drones[id]; const j=await post('/api/room/drone',{id,x:d.x,y:d.y,heading:d.heading,...(facingConfirmed?{facingConfirmed:true}:{})}); if(!j.ok) hint(j.error||'Could not place the drone'); await refreshRoom(); }
async function savePhone(slot){ const c=R().cameras[slot]; const j=await post('/api/room/camera',{slot,x:c.x,y:c.y,heading:c.heading,...(Number.isFinite(c.z)?{z:c.z}:{}),...(Number.isFinite(c.tilt)?{tilt:c.tilt}:{})}); if(!j.ok) hint(j.error||'Could not place the phone'); await refreshRoom(); }
async function saveZones(){ const j=await post('/api/room/zones',{zones:R().zones}); if(!j.ok) hint(j.error||'Could not save the zones'); await refreshRoom(); }
async function saveObjects(){ const j=await post('/api/room/objects',{objects:R().objects}); if(!j.ok) hint(j.error||'Could not save the tables'); await refreshRoom(); }
async function removeFromPlan(kind,id){
  const j=kind==='drone'?await post('/api/room/drone',{id,remove:true}):await post('/api/room/camera',{slot:id,remove:true});
  if(!j.ok){ hint(j.error||'Could not remove it'); return; }
  sel=null; await refreshRoom();
}
async function refreshRoom(){ await loadRoom(); inspectorKey=''; await renderMap(); }

// ---- what is selected, and the list ----
function select(kind,id){ sel=kind?{kind,id:String(id)}:null; mode=mode?.kind==='calibrate'&&sel?.kind==='phone'&&sel.id===mode.slot?mode:null; inspectorKey=''; renderSide(); scheduleDraw();
  // Bring the details into view: on a short screen they sit below the list.
  if(sel){ const side=document.querySelector?.('.room-side'); side?.scrollTo?.({top:0,behavior:'smooth'}); $('#inspector').scrollIntoView?.({block:'nearest',behavior:'smooth'}); } }
function startMode(m){ mode=m; inspectorKey=''; mapSvg.classList.toggle('placing',Boolean(m)); renderSide(); scheduleDraw();
  hint(!m?'':m.kind==='place'?`Click on the plan where ${m.label} is. Then drag the round handle to turn it.`:m.kind==='zone'?'Click the corners of the zone. Click the first corner again, or Finish, to close it.':m.kind==='table'?'Click where the centre of the table is.':m.kind==='calibrate'?'Click a floor spot in the phone picture, then the same spot on the plan. Four times.':''); }
$('#addTable').addEventListener('click',()=>startMode({kind:'table'}));
$('#addZone').addEventListener('click',()=>{ select(null); startMode({kind:'zone',points:[]}); });
document.addEventListener?.('keydown',evt=>{
  if(!mapDialog.open||/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName||'')) return;
  if(evt.key==='Escape'){ if(mode) startMode(null); else select(null); }
  if((evt.key==='Delete'||evt.key==='Backspace')&&sel&&['zone','object'].includes(sel.kind)){ evt.preventDefault(); void deleteSelected(); }
  if(evt.key==='Enter'&&mode?.kind==='zone') void finishZone();
});
async function deleteSelected(){
  if(sel?.kind==='zone'){ R().zones=R().zones.filter(z=>z.id!==sel.id); sel=null; await saveZones(); }
  if(sel?.kind==='object'){ R().objects=R().objects.filter(o=>o.id!==sel.id); sel=null; await saveObjects(); }
}
async function finishZone(){
  const pts=mode?.points||[];
  if(pts.length<3){ hint('A zone needs at least 3 corners.'); return; }
  const id=`z${Date.now()}`;
  R().zones.push({id,name:`Zone ${R().zones.length+1}`,points:pts});
  startMode(null); sel={kind:'zone',id}; await saveZones();
}
function row(kind,id,name,detail,placed){
  const b=document.createElement('button'); b.className='room-row'+(sel?.kind===kind&&sel.id===String(id)?' selected':'')+(placed?'':' unplaced');
  b.innerHTML='<span class="row-dot"></span><span class="row-name"></span><span class="row-detail"></span>';
  b.querySelector('.row-name').textContent=name; b.querySelector('.row-detail').textContent=detail;
  if(kind==='drone') b.querySelector('.row-dot')?.setAttribute('style',`background:${DRONE_COLOUR[id]||'#555'}`);
  if(kind==='phone') b.querySelector('.row-dot')?.setAttribute('data-state',slotOf(id)?.online?'on':'off');
  if(kind==='zone') b.querySelector('.row-dot')?.setAttribute('data-state','zone');
  b.addEventListener('click',()=>select(kind,id));
  return b;
}
function group(title,rows){ const g=document.createElement('div'); g.className='room-group'; const h=document.createElement('p'); h.className='caption'; h.textContent=title; g.append(h,...rows); return g; }
// Flight data from the telemetry, live.
function flightData(id){
  const l=liveDrones[id]; if(!l?.connected) return '';
  const o=l.odometry||{}, a=l.attitude||{};
  const from=l.source==='telemetry'?`Position from the telemetry (${o.reading}; ${o.fitError}% unexplained)`:o.calibrated?'Position from the telemetry once it takes off':'Position from the commands until the telemetry is understood: it needs moves of at least 20 cm in two different directions, one of them sideways (for example forward 1 m, then left 1 m)';
  const dec=l.decision&&Date.now()-l.decision.at<30000?`Step ${l.decision.step}: ${l.decision.action} (${l.decision.by==='model'?`Grok, ${l.decision.ms} ms`:l.decision.by==='timeout'?'Grok too slow: hovering':'rules'}${l.decision.reason&&l.decision.by==='model'?`: ${l.decision.reason}`:''}${l.decision.overruled?`; rules changed it: ${l.decision.overruled}`:''})`:'';
  const where=l.where?`Where: ${l.where}`:'';
  const pad=l.padSeen?`over mission pad ${l.padSeen.pad} (${l.padSeen.fromCentreCm} cm from its centre)`:'';
  return [where, dec, pad, from, l.flying?`flown ${(o.flownCm/100).toFixed(2)} m · ${(o.fromTakeoffCm/100).toFixed(2)} m from take-off · ${o.speedCms} cm/s`:'', l.flying?`tilt ${a.pitch}° / ${a.roll}° · ground speed ${a.vgx}, ${a.vgy}, ${a.vgz}`:''].filter(Boolean).join(' · ');
}
function surfaceText(d){ const s=d?.startSurface; if(!s) return ''; const what=s.heightCm>0?`on a ${(s.heightCm/100).toFixed(2)} m surface`:'on the floor'; return d.flight==='flying'?`took off ${what} (${s.source==='sensor'?'confirmed by the infrared sensor':s.source==='plan'?'from the plan, not yet checked':'assumed'})`:`${what} (${s.source==='plan'?'plan':'assumed'})`; }
function droneDetail(id){ const d=droneById(id); const placed=Boolean(R().drones[id]); if(!placed) return 'not on the plan'; if(!d?.connected) return 'on the plan · not connected'; return `${d.flight==='flying'?`flying · ${Number.isFinite(d.heightAboveFloorCm)?`${(d.heightAboveFloorCm/100).toFixed(2)} m above the floor`:''}`:'on the ground'}${Number.isFinite(d.battery)?` · ${d.battery}%`:''}`; }
function phoneDetail(slot){ const s=slotOf(slot); const placed=typeof R().cameras[slot]?.x==='number'; const st=!s?.online?'offline':`${s.watching?'watching':'not watching'} · ${s.lens||'normal'} · ${s.peopleCount||0} people`; return placed?st:`not on the plan · ${st}`; }
function renderList(){
  const list=$('#roomList'); const r=R();
  const ds=['tello','rmtt'].filter(id=>drones.some(d=>d.id===id)||r.drones[id]);
  list.replaceChildren(
    group('DRONES',ds.map(id=>row('drone',id,DRONE_LABEL[id]||id,droneDetail(id),Boolean(r.drones[id])))),
    group('PHONES',['1','2','3'].map(s=>row('phone',s,`Phone ${s}`,phoneDetail(s),typeof r.cameras[s]?.x==='number'))),
    group('RED ZONES',r.zones.length?r.zones.map(z=>row('zone',z.id,z.name,`${z.points.length} corners · ${fmt(area(z.points),1)} m²${mapLive?.zones?.find(q=>q.id===z.id)?.occupied?' · person inside':''}`,true)):[emptyRow('None yet: Add → Red zone')]),
    group('TABLES AND OBJECTS',r.objects.length?r.objects.map(o=>row('object',o.id,o.name,`${Math.round(o.w*100)} × ${Math.round(o.d*100)} cm${o.pad?` · pad ${o.pad}`:''}`,true)):[emptyRow('None yet: Add → Table')]),
  );
}
function emptyRow(t){ const p=document.createElement('p'); p.className='row-empty'; p.textContent=t; return p; }
function area(pts){ let a=0; for(let i=0;i<pts.length;i++){ const [x1,y1]=pts[i],[x2,y2]=pts[(i+1)%pts.length]; a+=x1*y2-x2*y1; } return Math.abs(a)/2; }

// ---- the inspector: numbers in metres, and the actions for what is selected ----
function field(label,value,onChange,{step=0.05,suffix='m',type='number',cm=null}={}){
  // cm: 'x' / 'y' = a position in cm from the inside corner; 'size' = a length in cm. Stored in metres.
  const l=document.createElement('label'); l.className='field';
  const s=document.createElement('span'); s.textContent=label;
  const i=document.createElement('input'); i.type=type;
  const off=cm==='x'?origin()[0]:cm==='y'?origin()[1]:0;
  if(cm){ step=1; suffix='cm'; }
  if(type==='number'){ i.step=String(step); i.value=Number.isFinite(value)?String(cm?Math.round((value-off)*100):Math.round(value*100)/100):''; } else i.value=value??'';
  i.addEventListener('change',()=>{ if(type!=='number') return onChange(i.value.trim()); const n=Number(i.value); if(i.value===''||!Number.isFinite(n)) return; onChange(cm?n/100+off:n); });
  const u=document.createElement('small'); u.textContent=suffix;
  l.append(s,i,u); return l;
}
function btn(text,onClick,cls=''){ const b=document.createElement('button'); b.textContent=text; b.className=`chip ${cls}`; b.addEventListener('click',onClick); return b; }
function para(text,cls='note'){ const p=document.createElement('p'); p.className=cls; p.textContent=text; return p; }
function renderSide(){ renderList(); renderInspector(); }
function renderInspector(){
  const box=$('#inspector');
  const key=JSON.stringify([sel,mode?.kind,mode?.points?.length,mode?.img?.length,mode?.plan?.length,sel?.kind==='drone'?Boolean(liveDrones[sel.id]?.flying):null]);
  if(key===inspectorKey){ updateInspectorLive(); return; }
  inspectorKey=key; box.replaceChildren();
  const r=R();
  if(mode?.kind==='zone'){ box.append(para('NEW RED ZONE','caption'),para(`${mode.points.length} corners. Click the corners on the plan; click the first one again to close it.`),btn('Finish zone',()=>void finishZone(),'dark'),btn('Cancel',()=>startMode(null))); return; }
  if(mode?.kind==='table'){ box.append(para('NEW TABLE','caption'),para('Click on the plan where its centre is. You can then type its real size.'),btn('Cancel',()=>startMode(null))); return; }
  if(mode?.kind==='place'){ box.append(para(`PLACE ${mode.label.toUpperCase()}`,'caption'),para('Click on the plan where it is now. Then turn it with the round handle, or type the direction.'),btn('Cancel',()=>startMode(null))); return; }
  if(!sel){ box.append(para('Select something in the list or on the plan.','note muted'),para('Drag to move it, drag the round handle to turn it, or type exact numbers here. Scroll to zoom, drag the empty plan to move around.','note muted')); return; }
  if(sel.kind==='drone') return droneInspector(box,sel.id);
  if(sel.kind==='phone') return phoneInspector(box,sel.id);
  if(sel.kind==='zone'){
    const z=r.zones.find(q=>q.id===sel.id); if(!z){ sel=null; return renderInspector(); }
    box.append(para('RED ZONE','caption'),field('Name',z.name,v=>{ const c=R().zones.find(q=>q.id===z.id); if(c){ c.name=v||c.name; void saveZones(); } },{type:'text',suffix:''}),
      para(`${z.points.length} corners · ${fmt(area(z.points),1)} m². Drag a corner on the plan to change the shape. A person seen inside it by a phone is an alert; with auto-send on, the nearest drone goes there.`),
      btn('Delete zone',()=>void deleteSelected(),'danger'));
    return;
  }
  if(sel.kind==='object'){
    const o=r.objects.find(q=>q.id===sel.id); if(!o){ sel=null; return renderInspector(); }
    // The room is reloaded every 1.5 s: always change the current copy, not the one shown when the panel was built.
    const cur=()=>R().objects.find(q=>q.id===o.id);
    const set=(k)=>v=>{ const c=cur(); if(c&&(k==='name'||k==='kind'||Number.isFinite(v))){ c[k]=v; void saveObjects(); } };
    const kind=document.createElement('label'); kind.className='field'; kind.innerHTML='<span>Kind</span><select></select><small></small>';
    for(const k of OBJECT_KINDS){ const op=document.createElement('option'); op.value=k; op.textContent=k; op.selected=o.kind===k; kind.querySelector('select').append(op); }
    kind.querySelector('select').addEventListener('change',e=>set('kind')(e.target.value));
    // A Tello mission pad (1-8) in the middle of this table: exact positions over it.
    const pad=document.createElement('label'); pad.className='field'; pad.innerHTML='<span>Mission pad</span><select></select><small></small>';
    for(const v of ['',1,2,3,4,5,6,7,8]){ const op=document.createElement('option'); op.value=String(v); op.textContent=v===''?'none':`pad ${v}`; op.selected=(o.pad??'')===v; pad.querySelector('select').append(op); }
    pad.querySelector('select').addEventListener('change',e=>{ const c=cur(); if(!c) return; const v=Number(e.target.value); if(v>=1&&v<=8) c.pad=v; else delete c.pad; void saveObjects(); });
    box.append(para(o.kind.toUpperCase(),'caption'),field('Name',o.name,set('name'),{type:'text',suffix:''}),kind,pad,
      field('Centre from left',o.x,set('x'),{cm:'x'}),field('Centre from bottom',o.y,set('y'),{cm:'y'}),field('Width',o.w,set('w'),{cm:'size'}),field('Depth',o.d,set('d'),{cm:'size'}),field('Turned',o.rotation,set('rotation'),{step:5,suffix:'°'}),field('Height',o.heightM,set('heightM'),{cm:'size'}),
      para(o.pad?`Pad ${o.pad} lies in the middle, at the table's height (${Math.round((o.heightM??0.75)*100)} cm). Say "go to ${o.name}": the drone flies around the other tables and pillars, goes over this one at least 50 cm above it and centres exactly on the pad.`:'Say "go to '+o.name+'": the drone flies around tables and pillars (dashed line on the plan) and stops 60 cm from its edge, not above it. Put a mission pad in its middle for an exact position.'),
      btn('Duplicate',async()=>{ const c={...o,id:`o${Date.now()}`,name:`${o.kind} ${r.objects.length+1}`,x:o.x+o.w+0.3}; r.objects.push(c); sel={kind:'object',id:c.id}; await saveObjects(); }),
      btn('Delete',()=>void deleteSelected(),'danger'));
  }
}
function droneInspector(box,id){
  const r=R(); const p=r.drones[id];
  box.append(para(`DRONE · ${(DRONE_LABEL[id]||id).toUpperCase()}`,'caption'));
  const live=para('','note live-drone'); box.append(live,para('','note flight-data'));
  if(p){
    // Back to its spot: flying, it flies there; on the ground, the person put it back and says so.
    const acts=document.createElement('div'); acts.className='drone-actions';
    const flying=liveDrones[id]?.flying??droneById(id)?.flight==='flying';
    if(flying) acts.append(btn('Fly back to its spot',()=>{ void runOnDrone(id,'go_to',{place:'home'}).then(r=>hint(r.ok?'Back at its spot':`Not back: ${r.error}`)); },'dark'));
    else acts.append(btn('It is back on its spot',async()=>{ const j=await post('/api/room/drone',{id,x:p.x,y:p.y,heading:p.heading,facingConfirmed:Boolean(p.facingConfirmed)}); hint(j.ok?`${DRONE_LABEL[id]} is on its spot again: ${where(p.x,p.y)}`:j.error); await refreshRoom(); }));
    acts.append(btn('Remove from the plan',()=>void removeFromPlan('drone',id),'danger'));
    box.append(acts, calibrationBox(id));
  }
  if(!p){ box.append(para('Not on the plan: the drone does not know where it is, so "go to table 1" and the nearest-drone choice cannot use it.'),btn('Place on the plan',()=>startMode({kind:'place',what:'drone',id,label:DRONE_LABEL[id]||id}),'dark')); updateInspectorLive(); return; }
  // Typing one number moves the drone from where it is now (not from where it was first placed).
  const set=k=>v=>{ if(Number.isFinite(v)){ const now=R().drones[id]||p, at=posOf('drone',id)||now; R().drones[id]={...now,x:at.x,y:at.y,heading:at.heading,[k]:v}; void saveDrone(id,k==='heading'||Boolean(now.facingConfirmed)); } };
  const now=posOf('drone',id)||p;
  if(!p.facingConfirmed){
    const warn=document.createElement('div'); warn.className='facing-warn';
    warn.append(para('WHICH WAY DOES ITS CAMERA LOOK?','caption'),para(`Turn the arrow on the plan with the round handle (or type Facing) until it points where the camera of the real drone points, then confirm. Until then "go to table" is refused: every right and left depends on it.`,'note'),btn('The camera looks this way',async()=>{ await post('/api/room/drone',{id,x:now.x,y:now.y,heading:now.heading,facingConfirmed:true}); await refreshRoom(); },'dark'));
    box.append(warn);
  }
  box.append(field('From left wall',now.x,set('x'),{cm:'x'}),field('From bottom wall',now.y,set('y'),{cm:'y'}),field('Facing',now.heading,set('heading'),{step:5,suffix:'°'}),
    para(`Drawn at real size (${DRONE_SIZE_CM[id]?.join(' × ')||'10 × 10'} cm). Place it where it stands before take-off; it can only be moved while it is on the ground. 0° = facing right on the plan, 90° = up.`),
    btn('Move it on the plan',()=>startMode({kind:'place',what:'drone',id,label:DRONE_LABEL[id]||id})));
  updateInspectorLive();
}
// Calibration test: take off from the table, a pattern that returns to the start on paper,
// back to the start with the telemetry, land; then the person measures where it landed.
let calTimer=0;
function calibrationBox(id){
  const box=document.createElement('details'); box.className='cal-test';
  box.innerHTML='<summary><span class="caption">CALIBRATION TEST</span> <span class="cal-count note"></span></summary><p class="note">The first times: right, left, right, forward, back, forward (twice by default), back to the start and landing; each move is measured with the telemetry. After a couple of tests the drone knows its telemetry and does not need it. With 50 cm moves a drone in the middle of a table stays above it. Stay next to Cut motors.</p><div class="cal-row"><label>Moves <select class="cal-size"><option value="30">30 cm</option><option value="50" selected>50 cm</option><option value="80">80 cm</option></select></label><label>Rounds <select class="cal-rounds"><option value="1">1</option><option value="2" selected>2</option></select></label><label><input type="checkbox" class="cal-photo"> photo check</label></div><div class="cal-actions"></div><pre class="cal-log"></pre><p class="note strong cal-summary"></p><div class="cal-measure" hidden><label>It landed <input type="number" min="0" max="1000" step="1" class="cal-cm"> cm from where it took off</label></div>';
  const start=btn('Start the test',async()=>{
    const size=Number(box.querySelector('.cal-size').value), photo=box.querySelector('.cal-photo').checked, rounds=Number(box.querySelector('.cal-rounds').value);
    if(!confirm(`${DRONE_LABEL[id]} on its take-off spot (the one on the plan), 2 m around it clear, you next to Cut motors. It takes off, flies ${size}-${2*size} cm moves for about a minute, comes back and lands. Start?`)) return;
    start.disabled=true; box.querySelector('.cal-summary').textContent='Running…';
    pollCalibration(id,box);
    const r=await runOnDrone(id,'calibrate',{sizeCm:size,photo,rounds});
    clearInterval(calTimer); start.disabled=false;
    showCalibration(box,r.report||null,r.summary||r.error);
  },'dark');
  box.querySelector('.cal-actions').append(start);
  box.querySelector('.cal-cm').addEventListener('change',async e=>{ const j=await post('/api/calibration/measured',{drone:id,cm:Number(e.target.value)}); showCalibration(box,j.report||null,j.summary||j.error); });
  void fetch(`/api/calibration?drone=${id}`,{cache:'no-store'}).then(r=>r.json()).then(j=>{ box.querySelector('.cal-count').textContent=j.count?`· ${j.count} done${j.count>=2?', the telemetry is known':''}`:'· never done: do it twice'; box.open=!j.count||Boolean(j.running); if(j.report) showCalibration(box,j.report,j.summary); if(j.running) pollCalibration(id,box); }).catch(()=>{});
  return box;
}
function pollCalibration(id,box){ clearInterval(calTimer); calTimer=setInterval(async()=>{ try { const j=await (await fetch(`/api/calibration?drone=${id}`,{cache:'no-store'})).json(); if(j.running) box.querySelector('.cal-log').textContent=j.running.join('\n'); else clearInterval(calTimer); } catch {} },1000); }
function showCalibration(box,report,text){
  box.querySelector('.cal-summary').textContent=text||'';
  if(!report) return;
  box.querySelector('.cal-log').textContent=[...report.moves.map(m=>`${m.command.padEnd(12)} measured ${m.measuredCm??'?'} cm · error ${m.errorCm??'?'} cm`),...report.log].join('\n');
  box.querySelector('.cal-measure').hidden=!report.landed;
  if(report.measuredLandingCm!==null) box.querySelector('.cal-cm').value=report.measuredLandingCm;
}

let aiTimer=0, aiSlot='';
function phoneInspector(box,slot){
  const r=R(); const c=r.cameras[slot]; const s=slotOf(slot);
  box.append(para(`PHONE ${slot}`,'caption'));
  const v=document.createElement('div'); v.className='phone-live'; v.innerHTML='<img alt=""><span>Phone offline: open its link from the Phones tab</span>'; box.append(v);
  box.append(para('','note phone-status'),para('','ai-line'));
  const ctr=document.createElement('div'); ctr.className='phone-controls';
  ctr.append(btn('Watch',async()=>{ const w=slotOf(slot)?.watching; await cameraCommand(slot,{type:'watch',watching:!w}); }, 'watch'));
  for(const l of ['wide','normal','tele']) ctr.append(btn(l[0].toUpperCase()+l.slice(1),()=>void cameraCommand(slot,{type:'lens',lens:l}),`lens lens-${l}`));
  box.append(ctr);
  if(!c||typeof c.x!=='number'){ box.append(para('Not on the plan: place it where it stands and turn it the way it looks, so the people it sees appear on the plan.'),btn('Place on the plan',()=>startMode({kind:'place',what:'phone',id:slot,label:`phone ${slot}`}),'dark')); }
  else {
    const set=k=>v=>{ const cam=R().cameras[slot]; if(cam&&Number.isFinite(v)){ cam[k]=v; void savePhone(slot); } };
    box.append(field('From left wall',c.x,set('x'),{cm:'x'}),field('From bottom wall',c.y,set('y'),{cm:'y'}),field('Looks at',c.heading,set('heading'),{step:5,suffix:'°'}),
      field('Height',c.z,set('z'),{cm:'size'}),field('Tilt down',c.tilt,set('tilt'),{step:1,suffix:'°'}),
      para('Height = from the floor to the phone. Tilt down = 0° looking level, 90° looking straight at the floor. With both set, people are placed where the line from the phone through their feet meets the floor.'),
      para(c.calibrated?'Calibrated: people are placed exactly where their feet touch the floor.':'People are placed from where they are in the picture and how tall they look (about ±1 m at 5 m). For exact spots, calibrate below.'),
      btn('Remove from the plan',()=>void removeFromPlan('phone',slot),'danger'));
    const det=document.createElement('details'); det.className='calibrate';
    det.innerHTML='<summary>Exact positions (optional): calibrate</summary>';
    det.append(para('Calibrating tells the server exactly which spot on the floor each point of the phone picture is: you click 4 floor points in the picture (tape marks, table legs, corners) and the same 4 points on the plan. Without it, positions are estimates.'));
    if(mode?.kind==='calibrate'&&mode.slot===slot){
      det.open=true;
      const pic=document.createElement('div'); pic.className='cal-image'; pic.innerHTML='<img alt="Phone picture"><svg viewBox="0 0 1 1" preserveAspectRatio="none"></svg>';
      pic.querySelector('img').src=`/cameras/${slot}.jpg?t=${Date.now()}`;
      pic.querySelector('img').addEventListener('click',evt=>{ if(mode.img.length>mode.plan.length) return; const b=evt.target.getBoundingClientRect(); mode.img.push([(evt.clientX-b.left)/b.width,(evt.clientY-b.top)/b.height]); inspectorKey=''; renderInspector(); });
      const marks=pic.querySelector('svg'); mode.img.forEach(([u,w],i)=>{ marks.append(svgEl('circle',{cx:u,cy:w,r:.02,fill:'#fff',stroke:'#111','stroke-width':.006})); marks.append(svgEl('text',{x:u+.025,y:w-.015,'font-size':.06,fill:'#fff'},String(i+1))); });
      const n=mode.plan.length, wait=mode.img.length>n;
      det.append(pic,para(n>=4&&!wait?'Four points done: save, or add more for a better fit.':wait?`Point ${n+1}: now click the same spot on the plan.`:`Point ${n+1} of 4: click a floor spot in the picture.`,'note strong'),
        btn('Undo point',()=>{ if(mode.img.length>mode.plan.length) mode.img.pop(); else { mode.img.pop(); mode.plan.pop(); } inspectorKey=''; renderInspector(); scheduleDraw(); }),
        btn('Save',async()=>{ const j=await post('/api/room/camera',{slot,img:mode.img,plan:mode.plan}); hint(j.ok?`Calibrated. Fit error ${Math.round((j.errorM||0)*100)} cm.`:j.error); startMode(null); await refreshRoom(); },'dark'),
        btn('Cancel',()=>startMode(null)));
      if(n<4||wait) det.lastChild.previousSibling.disabled=true;
    } else {
      det.append(btn('Start calibrating',()=>{ det.open=true; startMode({kind:'calibrate',slot,img:[],plan:[]}); }));
      if(c.calibrated) det.append(btn('Forget calibration',async()=>{ await post('/api/room/camera',{slot,clear:true}); await refreshRoom(); }));
    }
    box.append(det);
  }
  updateInspectorLive();
}
function updateInspectorLive(){
  const box=$('#inspector');
  if(sel?.kind==='drone'){ const el=box.querySelector('.live-drone'); const d=droneById(sel.id); const at=posOf('drone',sel.id); const fd=$('#inspector').querySelector('.flight-data'); if(fd) fd.textContent=flightData(sel.id); if(el) el.textContent=[at?`${where(at.x,at.y)}${Number.isFinite(d?.heightAboveFloorCm)?` · ${d.heightAboveFloorCm} cm above the floor`:''}`:'',droneDetail(sel.id),surfaceText(d),d?.connected&&Number.isFinite(d.tofCm)?`infrared below: ${d.tofCm} cm`:''].filter(Boolean).join(' · '); }
  if(sel?.kind==='phone'){
    const s=slotOf(sel.id); const v=box.querySelector('.phone-live'); if(!v) return;
    const img=v.querySelector('img');
    if(s?.online&&s.hasPreview){ if(!img.getAttribute('src')) img.src=`/cameras/${sel.id}.mjpeg`; v.classList.remove('off'); } else { img.removeAttribute('src'); v.classList.add('off'); }
    box.querySelector('.phone-status').textContent=!s?.online?'Offline':`Online · ${s.watching?'watching for people':'not watching'} · lens ${s.lens||'normal'}${s.roi?' · it also has its own zone drawn on the phone (ignored here: only the red zones on this plan count)':''}`;
    const w=box.querySelector('.phone-controls .watch'); if(w){ w.textContent=s?.watching?'Stop watching':'Start watching'; w.disabled=!s?.online; w.classList.toggle('dark',Boolean(s?.watching)); }
    for(const b of box.querySelectorAll('.phone-controls .lens')){ const l=[...b.classList].find(c=>c.startsWith('lens-'))?.slice(5); b.disabled=!s?.online||s.lensesAvailable?.[l]===false; b.classList.toggle('dark',(s?.lens||'normal')===l); }
    if(aiSlot!==sel.id){ aiSlot=sel.id; clearTimeout(aiTimer); void askPhoneAI(sel.id); }
  } else if(aiSlot){ aiSlot=''; clearTimeout(aiTimer); }
}
// What the phone sees, in words: Grok vision on its picture every 6 s while it is selected.
async function askPhoneAI(slot){
  const line=()=>$('#inspector').querySelector('.ai-line');
  if(aiSlot!==slot) return;
  if(!slotOf(slot)?.online){ if(line()) line().textContent=''; aiTimer=setTimeout(()=>void askPhoneAI(slot),6000); return; }
  try {
    const j=await (await fetch(`/api/cameras/${slot}/ai`,{cache:'no-store'})).json();
    if(aiSlot===slot&&line()) line().textContent=j.ok?`AI · ${j.people===0?'nobody':j.people===1?'1 person':`${j.people} people`} · ${j.summary}`:`AI · ${j.error||'unavailable'}`;
  } catch {}
  if(aiSlot===slot) aiTimer=setTimeout(()=>void askPhoneAI(slot),6000);
}

// ---- pointer: select, drag, turn, pan; place things; draw zones; calibrate ----
function itemAt(evt){ const t=evt.target.closest?.('[data-kind]'); return t?{kind:t.dataset.kind,id:t.dataset.id,handle:t.dataset.handle,index:Number(t.dataset.index)}:null; }
function posOf(kind,id){
  const r=R();
  // Where the drone really is (also after landing somewhere else); its placement only before any flight.
  if(kind==='drone'){ const p=r.drones[id]; const live=livePose(id);
    if(live&&(p||liveDrones[id]?.flying)) return {x:live.x/100,y:live.y/100,heading:live.heading};
    return p?{...p}:null; }
  if(kind==='phone'){ const c=r.cameras[id]; return c&&typeof c.x==='number'?{x:c.x,y:c.y,heading:c.heading??0}:null; }
  if(kind==='object'){ const o=r.objects.find(q=>q.id===id); return o?{x:o.x,y:o.y,heading:o.rotation||0}:null; }
  return null;
}
mapSvg.addEventListener?.('pointerdown',async evt=>{
  if(!view||evt.button!==0) return;
  const p=svgPoint(evt), hit=itemAt(evt);
  if(mode?.kind==='place'){
    const r=R(); const [x,y]=p.m;
    if(mode.what==='drone'){ r.drones[mode.id]={x,y,heading:r.drones[mode.id]?.heading??0}; const id=mode.id; startMode(null); sel={kind:'drone',id}; await saveDrone(id); }
    else { r.cameras[mode.id]={...(r.cameras[mode.id]||{}),x,y,heading:r.cameras[mode.id]?.heading??0}; const id=mode.id; startMode(null); sel={kind:'phone',id}; await savePhone(id); }
    hint('Now drag the round handle to turn it the way it faces.'); return;
  }
  if(mode?.kind==='table'){ const id=`o${Date.now()}`; const r=R(); r.objects.push({id,name:`table ${r.objects.filter(o=>o.kind==='table').length+1}`,kind:'table',x:p.m[0],y:p.m[1],w:1.6,d:0.8,rotation:0,heightM:0.75}); startMode(null); sel={kind:'object',id}; await saveObjects(); hint('Type its real size on the right, or drag it.'); return; }
  if(mode?.kind==='zone'){
    const first=mode.points[0];
    if(first&&mode.points.length>=3&&Math.hypot(first[0]-p.m[0],first[1]-p.m[1])*100<px(12)){ void finishZone(); return; }
    mode.points.push(p.m); inspectorKey=''; renderInspector(); scheduleDraw(); return;
  }
  if(mode?.kind==='calibrate'){ if(mode.img.length>mode.plan.length){ mode.plan.push(p.m); inspectorKey=''; renderInspector(); scheduleDraw(); } return; }
  mapSvg.setPointerCapture?.(evt.pointerId);
  if(hit?.handle==='rotate'){ drag={type:'rotate',kind:hit.kind,id:hit.id,moved:false}; return; }
  if(hit?.handle==='vertex'){ drag={type:'vertex',id:hit.id,index:hit.index,moved:false}; return; }
  if(hit&&hit.kind!=='person'){
    if(!(sel?.kind===hit.kind&&sel.id===hit.id)) select(hit.kind,hit.id);
    const editable=hit.kind==='zone'||hit.kind==='object'||hit.kind==='phone'||(hit.kind==='drone'&&droneById(hit.id)?.flight!=='flying');
    drag={type:editable?'move':'none',kind:hit.kind,id:hit.id,start:p.m,moved:false,orig:hit.kind==='zone'?R().zones.find(z=>z.id===hit.id)?.points.map(q=>[...q]):posOf(hit.kind,hit.id)};
    return;
  }
  drag={type:'pan',sx:evt.clientX,sy:evt.clientY,view:{...view},moved:false};
});
mapSvg.addEventListener?.('pointermove',evt=>{
  if(!view) return;
  const p=svgPoint(evt);
  $('#roomCursor').textContent=where(p.m[0],p.m[1]);
  if(mode?.kind==='zone'){ mode.cursor=p.m; scheduleDraw(); }
  if(!drag) return;
  const r=R();
  if(drag.type==='pan'){ viewTouched=true; const k=upp(); view.x=drag.view.x-(evt.clientX-drag.sx)*k; view.y=drag.view.y-(evt.clientY-drag.sy)*k; if(Math.hypot(evt.clientX-drag.sx,evt.clientY-drag.sy)>3) drag.moved=true; applyView(); return; }
  if(drag.type==='move'&&drag.orig){
    const dx=p.m[0]-drag.start[0], dy=p.m[1]-drag.start[1];
    if(!drag.moved&&Math.hypot(dx,dy)*100<px(4)) return;
    drag.moved=true;
    const snap=v=>Math.round(v*100)/100;
    if(drag.kind==='zone'){ const z=r.zones.find(q=>q.id===drag.id); if(z) z.points=drag.orig.map(([x,y])=>[snap(x+dx),snap(y+dy)]); }
    if(drag.kind==='object'){ const o=r.objects.find(q=>q.id===drag.id); if(o){ o.x=snap(drag.orig.x+dx); o.y=snap(drag.orig.y+dy); } }
    if(drag.kind==='phone'){ const c=r.cameras[drag.id]; c.x=snap(drag.orig.x+dx); c.y=snap(drag.orig.y+dy); }
    if(drag.kind==='drone'){ const d=r.drones[drag.id]; if(d){ d.x=snap(drag.orig.x+dx); d.y=snap(drag.orig.y+dy); } }
    scheduleDraw(); return;
  }
  if(drag.type==='rotate'){
    const at=posOf(drag.kind,drag.id); if(!at) return;
    let a=Math.atan2(p.m[1]-at.y,p.m[0]-at.x)*180/Math.PI; if(!evt.shiftKey) a=Math.round(a/5)*5; a=Math.round(a);
    drag.moved=true;
    if(drag.kind==='drone') r.drones[drag.id].heading=a; else if(drag.kind==='phone') r.cameras[drag.id].heading=a; else { const o=r.objects.find(q=>q.id===drag.id); if(o) o.rotation=a; }
    hint(`${a}°`); scheduleDraw(); return;
  }
  if(drag.type==='vertex'){ const z=r.zones.find(q=>q.id===drag.id); if(z){ z.points[drag.index]=p.m; drag.moved=true; scheduleDraw(); } }
});
mapSvg.addEventListener?.('pointerup',async()=>{
  const d=drag; drag=null; if(!d) return;
  if(d.type==='pan'){ if(!d.moved&&!mode) select(null); return; }
  if(!d.moved) return;
  inspectorKey='';
  if(d.kind==='zone'||d.type==='vertex') await saveZones();
  else if(d.kind==='object') await saveObjects();
  else if(d.kind==='phone') await savePhone(d.id);
  else if(d.kind==='drone') await saveDrone(d.id,d.type==='rotate'||Boolean(R().drones[d.id]?.facingConfirmed));
});
mapSvg.addEventListener?.('pointerleave',()=>{ $('#roomCursor').textContent=''; hidePhoneHover(); });
// Hover a phone on the plan: its picture right there.
mapSvg.addEventListener?.('pointerover',evt=>{ const hit=itemAt(evt); if(hit?.kind==='phone'&&!drag) showPhoneHover(hit.id,evt); });
mapSvg.addEventListener?.('pointerout',evt=>{ const hit=itemAt(evt); if(hit?.kind==='phone') hidePhoneHover(); });
function showPhoneHover(slot,evt){
  const box=$('#phoneHover'), s=slotOf(slot), wrap=$('#mapWrap').getBoundingClientRect();
  box.querySelector('img').src=s?.online&&s.hasPreview?`/cameras/${slot}.jpg?t=${Date.now()}`:'';
  box.querySelector('img').hidden=!(s?.online&&s.hasPreview);
  box.querySelector('p').textContent=`Phone ${slot} · ${phoneDetail(slot)}`;
  box.style.left=`${Math.min(wrap.width-250,Math.max(8,evt.clientX-wrap.left+14))}px`; box.style.top=`${Math.max(8,evt.clientY-wrap.top-170)}px`;
  box.hidden=false;
}
function hidePhoneHover(){ $('#phoneHover').hidden=true; }

// ---- drawing ----
function scheduleDraw(){ if(rafPending) return; rafPending=true; (globalThis.requestAnimationFrame||(f=>setTimeout(f,16)))(()=>{ rafPending=false; draw(); }); }
function rotated(x,y,w,d,deg){ const a=deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a); return [[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]].map(([u,v])=>[x+u*c-v*s,y+u*s+v*c]); }
const pts=list=>list.map(([x,y])=>`${x*100},${-y*100}`).join(' ');
function handle(kind,id,x,y,heading,dist){
  const a=heading*Math.PI/180, hx=x*100+Math.cos(a)*dist, hy=-y*100-Math.sin(a)*dist;
  return [svgEl('line',{x1:x*100,y1:-y*100,x2:hx,y2:hy,class:'sel-line','stroke-width':px(1)}),svgEl('circle',{cx:hx,cy:hy,r:px(7),class:'handle','stroke-width':px(1.5),'data-kind':kind,'data-id':id,'data-handle':'rotate'})];
}
function draw(){
  if(!view) return;
  const svg=mapSvg, r=R(), plan=roomData?.plan, u=upp();
  svg.replaceChildren();
  const vx0=view.x, vx1=view.x+view.w, vy0=view.y, vy1=view.y+view.h;
  // Grid: every metre, stronger every 5 m; finer 10 cm lines when zoomed in.
  const step=u<0.6?10:100;
  for(let g=Math.ceil(vx0/step)*step; g<=vx1; g+=step) svg.append(svgEl('line',{x1:g,y1:vy0,x2:g,y2:vy1,class:g%500===0?'grid5':g%100===0?'grid1':'grid0','stroke-width':px(1)}));
  for(let g=Math.ceil(vy0/step)*step; g<=vy1; g+=step) svg.append(svgEl('line',{x1:vx0,y1:g,x2:vx1,y2:g,class:g%500===0?'grid5':g%100===0?'grid1':'grid0','stroke-width':px(1)}));
  for(const a of plan?.above||[]){ if(['Corpo4','Corpo16','Corpo17'].includes(a.solid)) continue; svg.append(svgEl('rect',{x:a.min[0]*100,y:-a.max[1]*100,width:(a.max[0]-a.min[0])*100,height:(a.max[1]-a.min[1])*100,class:'mezzanine','stroke-width':px(1),'stroke-dasharray':`${px(6)} ${px(5)}`})); }
  for(const w of plan?.walls||[]) svg.append(svgEl('line',{x1:w.a[0]*100,y1:-w.a[1]*100,x2:w.b[0]*100,y2:-w.b[1]*100,class:'wall','stroke-width':Math.max(px(2.5),6)}));
  // Tables and objects, at real size.
  for(const o of r.objects){
    const isSel=sel?.kind==='object'&&sel.id===o.id;
    const g=svgEl('g',{'data-kind':'object','data-id':o.id,class:'obj'+(isSel?' selected':'')});
    g.append(svgEl('polygon',{points:pts(rotated(o.x,o.y,o.w,o.d,o.rotation||0)),'stroke-width':px(isSel?2:1)}));
    if(o.w*100/u>40) g.append(svgEl('text',{x:o.x*100,y:-o.y*100+(o.pad?px(20):px(4)),'font-size':px(11),'text-anchor':'middle'},o.name));
    if(o.pad){ g.append(svgEl('rect',{x:o.x*100-10,y:-o.y*100-10,width:20,height:20,rx:2,class:'pad'})); g.append(svgEl('text',{x:o.x*100,y:-o.y*100+px(3.5),'font-size':px(9),'text-anchor':'middle',class:'pad-label'},`m${o.pad}`)); }
    svg.append(g);
    if(isSel) svg.append(...handle('object',o.id,o.x,o.y,o.rotation||0,Math.max(o.w,o.d)*50+px(22)));
  }
  // Red zones.
  for(const z of r.zones){
    const occ=mapLive?.zones?.find(q=>q.id===z.id)?.occupied, isSel=sel?.kind==='zone'&&sel.id===z.id;
    const g=svgEl('g',{'data-kind':'zone','data-id':z.id,class:'zone'+(occ?' occupied':'')+(isSel?' selected':'')});
    g.append(svgEl('polygon',{points:pts(z.points),'stroke-width':px(isSel?2:1.5)}));
    const cx=z.points.reduce((s,q)=>s+q[0],0)/z.points.length, cy=z.points.reduce((s,q)=>s+q[1],0)/z.points.length;
    g.append(svgEl('text',{x:cx*100,y:-cy*100,'font-size':px(11),'text-anchor':'middle'},`${z.name}${occ?' · person':''}`));
    svg.append(g);
    if(isSel) z.points.forEach((q,i)=>svg.append(svgEl('rect',{x:q[0]*100-px(5),y:-q[1]*100-px(5),width:px(10),height:px(10),class:'handle','stroke-width':px(1.5),'data-kind':'zone','data-id':z.id,'data-handle':'vertex','data-index':i})));
  }
  if(mode?.kind==='zone'&&mode.points.length){
    const line=[...mode.points,...(mode.cursor?[mode.cursor]:[])];
    svg.append(svgEl('polyline',{points:pts(line),class:'zone-draft','stroke-width':px(1.5),'stroke-dasharray':`${px(5)} ${px(4)}`}));
    mode.points.forEach((q,i)=>svg.append(svgEl('circle',{cx:q[0]*100,cy:-q[1]*100,r:px(i===0?7:4),class:'zone-corner','stroke-width':px(1.5)})));
  }
  // Phones: real size, what they look at, and whether they are on.
  for(const [slot,c] of Object.entries(r.cameras)){
    if(typeof c.x!=='number') continue;
    const s=slotOf(slot), on=Boolean(s?.online), isSel=sel?.kind==='phone'&&sel.id===slot;
    const fov=(LENS_FOV[s?.lens]||LENS_FOV.normal)*Math.PI/180, h=(c.heading||0)*Math.PI/180, x=c.x*100, y=-c.y*100;
    const g=svgEl('g',{'data-kind':'phone','data-id':slot,class:'phone'+(on?' on':' off')+(s?.watching?' watching':'')+(isSel?' selected':'')});
    const arc=[]; for(let k=0;k<=12;k++){ const a=h-fov/2+fov*k/12; arc.push(`${x+Math.cos(a)*VIEW_RANGE_CM},${y-Math.sin(a)*VIEW_RANGE_CM}`); }
    g.append(svgEl('path',{d:`M${x},${y} L${arc.join(' L')} Z`,class:'cone','stroke-width':px(1),...(on?{}:{'stroke-dasharray':`${px(4)} ${px(4)}`})}));
    g.append(svgEl('polygon',{points:pts(rotated(c.x,c.y,PHONE_SIZE_CM[1]/100,PHONE_SIZE_CM[0]/100,c.heading||0)),class:'body'}));
    g.append(svgEl('circle',{cx:x,cy:y,r:px(7),class:'marker','stroke-width':px(1.5)}));
    g.append(svgEl('text',{x:x+px(11),y:y-px(10),'font-size':px(11),class:'label'},`Phone ${slot} · ${on?`${s.watching?'watching':'idle'} · ${s.lens||'normal'}`:'offline'}`));
    svg.append(g);
    if(isSel) svg.append(...handle('phone',slot,c.x,c.y,c.heading||0,px(40)));
  }
  if(mode?.kind==='calibrate') mode.plan.forEach((q,i)=>{ svg.append(svgEl('circle',{cx:q[0]*100,cy:-q[1]*100,r:px(6),class:'cal-point','stroke-width':px(1.5)})); svg.append(svgEl('text',{x:q[0]*100+px(9),y:-q[1]*100-px(7),'font-size':px(12)},String(i+1))); });
  // People seen by the phones right now (not stored: people move).
  for(const p of mapLive?.people||[]){
    const g=svgEl('g',{'data-kind':'person','data-id':p.slot,class:'person'+(p.approx?' approx':'')});
    if(p.approx) g.append(svgEl('circle',{cx:p.x*100,cy:-p.y*100,r:100,class:'spread','stroke-width':px(1),'stroke-dasharray':`${px(3)} ${px(3)}`}));
    g.append(svgEl('circle',{cx:p.x*100,cy:-p.y*100,r:Math.max(px(6),20),class:'dot','stroke-width':px(2)}));
    svg.append(g);
  }
  if(routePreview?.to&&sel?.kind==='object'){
    const line=[routePreview.from,...routePreview.via,routePreview.to].map(([x,y])=>`${x},${-y}`).join(' ');
    svg.append(svgEl('polyline',{points:line,class:'route','stroke-width':px(2),'stroke-dasharray':`${px(6)} ${px(5)}`}));
    for(const [x,y] of routePreview.via) svg.append(svgEl('circle',{cx:x,cy:-y,r:px(3.5),class:'route-dot'}));
  }
  // The real track of the last flight: live points, or the server's when the page was reloaded.
  const tracks={...Object.fromEntries((mapLive?.drones||[]).filter(d=>d.path?.length>1).map(d=>[d.id,d.path.map(q=>[q.x,q.y])])),...Object.fromEntries(Object.entries(trails).filter(([,t])=>t.length>1))};
  for(const [id,t] of Object.entries(tracks)) if(t.length>1) svg.append(svgEl('polyline',{points:t.map(([x,y])=>`${x},${-y}`).join(' '),class:'trail','stroke-width':px(2),stroke:DRONE_COLOUR[id]||'#555'}));
  // Drones: real size, plus a marker that stays visible when zoomed out.
  for(const id of ['tello','rmtt']){
    const at=drag?.kind==='drone'&&drag.id===id||drag?.type==='rotate'&&drag.id===id?r.drones[id]:posOf('drone',id);
    if(!at||!r.drones[id]&&droneById(id)?.flight!=='flying') continue;
    const isSel=sel?.kind==='drone'&&sel.id===id, col=DRONE_COLOUR[id];
    const g=svgEl('g',{'data-kind':'drone','data-id':id,class:'drone'+(isSel?' selected':'')});
    const [w,d]=DRONE_SIZE_CM[id]; const a=(at.heading||0)*Math.PI/180, x=at.x*100, y=-at.y*100;
    g.append(svgEl('circle',{cx:x,cy:y,r:px(9),fill:'#fff',stroke:col,'stroke-width':px(2)}));
    g.append(svgEl('polygon',{points:pts(rotated(at.x,at.y,w/100,d/100,at.heading||0)),fill:col}));
    for(const [u2,v2] of [[1,1],[1,-1],[-1,1],[-1,-1]]){ const ox=(u2*w/2)*Math.cos(a)-(v2*d/2)*Math.sin(a), oy=(u2*w/2)*Math.sin(a)+(v2*d/2)*Math.cos(a); g.append(svgEl('circle',{cx:x+ox,cy:y-oy,r:2.4,fill:'none',stroke:col,'stroke-width':0.6})); }
    // The camera direction: an arrow; dashed with a ? until a person confirmed it.
    const ok=Boolean(r.drones[id]?.facingConfirmed), L=Math.max(px(30),20), ax=x+Math.cos(a)*L, ay=y-Math.sin(a)*L, hw=px(6);
    g.append(svgEl('line',{x1:x,y1:y,x2:ax,y2:ay,stroke:col,'stroke-width':px(2.5),'stroke-linecap':'round',...(ok?{}:{'stroke-dasharray':`${px(4)} ${px(4)}`})}));
    g.append(svgEl('polygon',{points:`${ax+Math.cos(a)*hw},${ay-Math.sin(a)*hw} ${ax+Math.cos(a+2.4)*hw},${ay-Math.sin(a+2.4)*hw} ${ax+Math.cos(a-2.4)*hw},${ay-Math.sin(a-2.4)*hw}`,fill:col}));
    if(!ok) g.append(svgEl('text',{x:ax+px(6),y:ay-px(6),'font-size':px(13),'font-weight':700,fill:col},'?'));
    g.append(svgEl('text',{x:x+px(12),y:y+px(16),'font-size':px(12),'font-weight':600,fill:col},`${DRONE_LABEL[id]}${liveDrones[id]&&!liveDrones[id].connected?' · not connected':(liveDrones[id]?.flying??droneById(id)?.flight==='flying')?' · flying':''}`));
    svg.append(g);
    if(isSel&&droneById(id)?.flight!=='flying') svg.append(...handle('drone',id,at.x,at.y,at.heading||0,px(40)));
  }
}

// 3D: the same room at real height, to see where the phones are above the floor. Editing stays in
// the list and inspector (and in 2D); the 3D view follows every change.
let view3d=null;
async function setView3d(on){
  $('#view2d').classList.toggle('active',!on); $('#view3d').classList.toggle('active',on);
  $('#view2d').setAttribute('aria-pressed',String(!on)); $('#view3d').setAttribute('aria-pressed',String(on));
  $('#map3d').hidden=!on; mapSvg.style.visibility=on?'hidden':''; $('#mapWrap').classList.toggle('is3d',on);
  if(on&&!view3d){ try { const m=await import('/room3d.js'); view3d=m.mount($('#map3d')); update3d(); } catch(e){ hint('3D view unavailable in this browser'); $('#map3d').hidden=true; mapSvg.style.visibility=''; } }
  if(!on&&view3d){ view3d.dispose(); view3d=null; }
}
function update3d(){ if(!view3d) return; const live=mapLive?{...mapLive,drones:(mapLive.drones||[]).map(d=>({...d,pose:liveDrones[d.id]?.pose?{...d.pose,...liveDrones[d.id].pose}:d.pose}))}:null; view3d.update({plan:roomData?.plan,room:R(),live,slots:redzone?.slots||[],drones}); }
$('#view2d').addEventListener?.('click',()=>void setView3d(false));
$('#view3d').addEventListener?.('click',()=>void setView3d(true));

// The way a drone would take to the selected table (dashed on the plan), from the first placed drone.
let routePreview=null, routeKey='';
async function refreshRoute(){
  const o=sel?.kind==='object'?R().objects.find(q=>q.id===sel.id):null;
  const id=['tello','rmtt'].find(d=>R().drones[d]);
  const key=o&&id?JSON.stringify([o,id,R().drones[id],livePose(id)]):'';
  if(key===routeKey) return; routeKey=key;
  if(!key){ routePreview=null; return; }
  try { const j=await (await fetch(`/api/route?drone=${id}&place=${encodeURIComponent(o.name)}`,{cache:'no-store'})).json(); routePreview=j.ok?{...j,drone:id}:null; if(!j.ok) hint(j.error); } catch { routePreview=null; }
  scheduleDraw();
}

async function renderMap(){
  if(!roomData){ await loadRoom(); }
  if(!view&&roomData) fitView();
  try { const r=await fetch('/api/map',{cache:'no-store'}); const data=await r.json(); if(r.ok&&Array.isArray(data.drones)) mapLive=data; } catch {}
  // Keep local edits while dragging; otherwise take the server's room (another page may edit it too).
  if(!drag&&!mode) { try { const r=await fetch('/api/room',{cache:'no-store'}); if(r.ok){ const fresh=await r.json(); fresh.room.objects??=[]; roomData=fresh; } } catch {} }
  renderSide(); void refreshRoute(); scheduleDraw(); update3d();
  const people=mapLive?.people?.length||0;
  $('#mapNote').textContent=`${people?`${people} ${people===1?'person':'people'} seen by the phones · `:''}grid 1 m · scroll to zoom`;
}

if (storedName()) rememberName(storedName());
refreshDrone();
setInterval(refreshDrone, 1500);
// The map refreshes on its own timer, registered after the drone poll.
setInterval(()=>{if(mapDialog.open) void renderMap()},1500);
showPanel('mapDialog');
startLive();
