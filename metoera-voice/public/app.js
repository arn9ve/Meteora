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
function state(label, hint, connected=false) {
  const active = connected || label === 'CONNECTING…';
  $('#connection').textContent = label;
  $('#hint').textContent = hint;
  $('#voiceHint').textContent = hint;
  $('#startVoice').hidden = active;
  $('#closeButton').hidden = !active;
  $('#emptyState').hidden = active;
  $('#conversation').hidden = !active;
  $('.voice').classList.toggle('live', active);
  $('.voice').classList.toggle('listening', connected);
  if (active && !connected) { $('#headline').textContent = 'Grok'; $('#transcript').textContent = 'Connecting…'; }
}

function log(name,detail){if(!activity)$('#activity').textContent='';activity++;$('#count').textContent=String(activity).padStart(2,'0');const row=document.createElement('div');row.className='entry';const icon=document.createElement('span');icon.className='icon';icon.textContent='↗';const body=document.createElement('div');body.textContent=name;const sub=document.createElement('small');sub.textContent=detail;body.append(sub);row.append(icon,body);$('#activity').prepend(row)}
function send(obj){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(obj))}
function stopAudio(){for(const node of playing){try{node.stop()}catch{}}playing=[];playAt=0}
function disconnect(){generation++;stopping=true;cancelAnimationFrame(frame);analyser=null;stopAudio();processor?.disconnect();source?.disconnect();stream?.getTracks().forEach(t=>t.stop());context?.close();socket?.close();socket=stream=context=processor=source=null;pending=[];$('#startVoice').disabled=false;state('READY TO CONNECT','What would you like to do?');drawPattern()}
function playback(base64){if(!context)return;const raw=atob(base64);const len=Math.floor(raw.length/2);const buf=context.createBuffer(1,len,24000);const data=buf.getChannelData(0);for(let i=0;i<len;i++){let n=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);if(n>=32768)n-=65536;data[i]=n/32768}const node=context.createBufferSource();node.buffer=buf;node.connect(context.destination);playAt=Math.max(context.currentTime,playAt);node.start(playAt);playAt+=buf.duration;playing.push(node);node.onended=()=>{playing=playing.filter(n=>n!==node)}}
// Drone commands go to the local server: drone-1/drone-2 to the simulator, tello to the real drone.
async function simulate(name,args){
  try {
    const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...args,action:name})});
    const result=await response.json();
    if(!response.ok) return {ok:false,mode:'simulation',error:serverMessage(result.error)||'Simulator unavailable'};
    const labels={takeoff:'Takeoff',land:'Landing',move:'Movement',rotate:'Rotation',test_flight:'Test flight'};
    const names={'drone-1':'Drone 1','drone-2':'Drone 2',tello:'Tello (real)'};
    log(`${names[args.droneId] || args.droneId} · ${labels[name] || name}`,result.ok?(result.mode==='real'?'Completed on the real drone':'Completed in simulation'):`Rejected · ${serverMessage(result.error)}`);
    await refreshDrones();
    return result;
  } catch { return {ok:false,mode:'simulation',error:'Simulator unreachable'}; }
}

async function finishCalls(){
  const run=generation;
  const calls=pending;
  pending=[];
  let stopped=false;
  for(const event of calls){
    if(run!==generation) return;
    let result;
    if(stopped) result={ok:false,mode:'simulation',error:'Sequence stopped after an earlier command failed'};
    else {
      try {result=await simulate(event.name,JSON.parse(event.arguments||'{}'));}
      catch {result={ok:false,mode:'simulation',error:'Invalid arguments'};}
    }
    if(run!==generation) return;
    if(!result.ok) stopped=true;
    send({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.call_id,output:JSON.stringify(result)}});
  }
  if(calls.length)send({type:'response.create'});
}
const tool=(name,description,properties={},required=[])=>({type:'function',name,description,parameters:{type:'object',properties,required,additionalProperties:false}});
async function start(){const run=++generation;state('CONNECTING…','Connecting voice session.');$('#startVoice').disabled=true;stopping=false;try{const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});if(run!==generation){acquired.getTracks().forEach(t=>t.stop());return}stream=acquired;context=new AudioContext({sampleRate:24000});await context.resume();if(run!==generation)return;const tokenResponse=await fetch('/session',{method:'POST'});const token=await tokenResponse.json();if(run!==generation)return;if(!tokenResponse.ok)throw Error(serverMessage(token.error)||'Token unavailable');if(!token.value)throw Error('Invalid token response');socket=new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest',[`xai-client-secret.${token.value}`]);socket.onopen=()=>{if(run!==generation)return;send({type:'session.update',session:{voice:'eve',instructions:'You are Grok, the voice assistant for Metoera. Speak concisely in English. There are two virtual drones, drone-1 (Drone 1) and drone-2 (Drone 2), and one real drone, tello (the Tello, also called the real drone). Actions on drone-1 and drone-2 are simulated: say so. Actions on tello move a physical drone. Before the first takeoff of tello in a conversation, ask the person to confirm the area around it is clear, and wait for a clear yes. If the person says stop, land, or sounds alarmed while tello is flying, call land on tello at once without asking. For tello, moves are limited to 20 to 100 centimeters. If the person just says fly, vola, or test flight for the real drone, use test_flight on tello: it takes off, hovers 5 seconds and lands by itself. Ask which drone to use if the person has not specified one; never choose on their behalf. Use the same drone for a sequence when the person has identified it. Only say the real drone moved when its result says ok. Execute one action at a time and wait for its result before the next. Stop the sequence if an action fails and say why.',turn_detection:{type:'server_vad'},audio:{input:{format:{type:'audio/pcm',rate:context.sampleRate},transcription:{language_hint:'en'}},output:{format:{type:'audio/pcm',rate:24000}}},tools:[tool('takeoff','Take off the specified drone (tello is the real drone)',{droneId:{type:'string',enum:['drone-1','drone-2','tello']}},['droneId']),tool('land','Land the specified drone (tello is the real drone)',{droneId:{type:'string',enum:['drone-1','drone-2','tello']}},['droneId']),tool('move','Move the specified drone; for tello 20 to 100 cm',{droneId:{type:'string',enum:['drone-1','drone-2','tello']},direction:{type:'string',enum:['forward','back','left','right','up','down']},centimeters:{type:'integer',minimum:20,maximum:500}},['droneId','direction','centimeters']),tool('test_flight','Real Tello only: take off, hover 5 seconds, then land',{droneId:{type:'string',enum:['tello']}},['droneId']),tool('rotate','Rotate the specified drone',{droneId:{type:'string',enum:['drone-1','drone-2','tello']},direction:{type:'string',enum:['clockwise','counterclockwise']},degrees:{type:'integer',minimum:1,maximum:360}},['droneId','direction','degrees'])]}});source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);animatePattern();processor=context.createScriptProcessor(4096,1,1);processor.onaudioprocess=e=>{if(socket?.readyState!==WebSocket.OPEN)return;const input=e.inputBuffer.getChannelData(0);const pcm=new Int16Array(input.length);for(let i=0;i<input.length;i++)pcm[i]=Math.max(-1,Math.min(1,input[i]))*32767;let str='';const bytes=new Uint8Array(pcm.buffer);for(let i=0;i<bytes.length;i++)str+=String.fromCharCode(bytes[i]);send({type:'input_audio_buffer.append',audio:btoa(str)})};source.connect(processor);processor.connect(context.destination);state('LISTENING','Speak to Grok',true);$('#headline').textContent='Grok';$('#transcript').textContent="I am listening.";if ($('#settingsDialog').open) $('#settingsDialog').close();$('#startVoice').disabled=false};socket.onmessage=async message=>{if(run!==generation)return;const e=JSON.parse(message.data);if(e.type==='input_audio_buffer.speech_started')stopAudio();if(e.type==='response.output_audio.delta'||e.type==='response.audio.delta')playback(e.delta);if(e.type==='conversation.item.input_audio_transcription.completed'){$('#transcript').textContent=`“${e.transcript}”`;$('#headline').textContent='You'}if(e.type==='response.output_audio_transcript.delta'||e.type==='response.audio_transcript.delta'){if($('#headline').textContent!=='Grok'){$('#headline').textContent='Grok';$('#transcript').textContent=''}$('#transcript').textContent+=e.delta}if(e.type==='response.function_call_arguments.done')pending.push(e);if(e.type==='response.done'&&pending.length)await finishCalls();if(e.type==='error'){$('#hint').textContent=e.error?.message||'Session error'}};socket.onerror=()=>{if(run===generation)$('#hint').textContent='Voice connection failed.'};socket.onclose=()=>{if(run===generation&&!stopping){disconnect();state('CONNECTION LOST','Try starting the session again')}}}catch(error){if(run!==generation)return;disconnect();state('NOT CONNECTED',error.message||'Could not start the session')}}
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

// The team controller can publish measured telemetry through this adapter.
// No received telemetry means no claim that a drone is present or moving.
const droneRecords = new Map();
let realTello = null; // snapshot of the real drone from /api/drones, null when not configured
const droneDialog = $('#dronesDialog');
const positionLabel = value => Number(value.toFixed(2)).toString();
function renderDrones() {
  const grid = $('#droneGrid');
  grid.replaceChildren();
  let recentCount = 0;
  for (const id of ['drone-1', 'drone-2']) {
    const record = droneRecords.get(id);
    const recent = record && Date.now() - record.receivedAt < 10000;
    if (recent) recentCount++;
    const card = document.createElement('article');
    card.className = 'drone-card';
    card.innerHTML = '<div class="drone-card-head"><h3></h3><span class="drone-availability"></span></div><p class="drone-position">POSITION</p><div class="drone-coordinates"></div><div class="drone-motion"><span>Movement</span><strong></strong></div>';
    card.querySelector('h3').textContent = id === 'drone-1' ? 'Drone 1' : 'Drone 2';
    card.querySelector('.drone-availability').textContent = recent ? 'Simulated · connected' : (record ? 'Data out of date' : 'Waiting');
    card.querySelector('.drone-coordinates').textContent = recent && record.position ? `X ${positionLabel(record.position.x)} · Y ${positionLabel(record.position.y)} · Z ${positionLabel(record.position.z)} m` : 'Unavailable';
    card.querySelector('.drone-position').textContent = recent && record.position ? `POSITION · ${record.position.frame}` : 'POSITION';
    const labels = {moving: 'Moving', stationary: 'Stationary', unknown: 'Unavailable'};
    const velocity = recent && record.velocity ? ` · ${['x','y','z'].map(axis => `${axis.toUpperCase()} ${positionLabel(record.velocity[axis])}`).join(' / ')} m/s` : '';
    card.querySelector('.drone-motion strong').textContent = recent ? `${record.flight === 'flying' ? 'Flying' : 'On the ground'} · ${labels[record.motion]}${Number.isFinite(record.heading) ? ` · ${record.heading}°` : ''}${velocity}` : 'Unavailable';
    grid.append(card);
  }
  if (realTello) {
    const card = document.createElement('article');
    card.className = 'drone-card drone-card-real';
    card.innerHTML = '<div class="drone-card-head"><h3>Tello · real</h3><span class="drone-availability"></span></div><p class="drone-position">TELEMETRY</p><div class="drone-coordinates"></div><div class="drone-motion"><span>State</span><strong></strong></div>';
    card.querySelector('.drone-availability').textContent = realTello.connected ? (realTello.verified ? 'Connected · serial verified' : 'Telemetry received') : 'Not connected';
    card.querySelector('.drone-coordinates').textContent = realTello.connected ? `Battery ${realTello.battery ?? '–'}% · Height ${realTello.heightCm ?? '–'} cm` : 'Unavailable';
    card.querySelector('.drone-motion strong').textContent = `${realTello.flight === 'flying' ? 'Flying' : 'On the ground'}${Number.isFinite(realTello.heading) ? ` · ${realTello.heading}°` : ''}${realTello.lastError ? ` · ${realTello.lastError}` : ''}`;
    grid.append(card);
  }
  $('#telemetryNote').textContent = recentCount ? 'Virtual positions in meters, calculated by the simulator. Out-of-date data is hidden.' : 'Waiting for controller data. Positions are not available yet.';
}
window.addEventListener('metoera:telemetry', event => {
  const data = event.detail;
  if (!data || !['drone-1', 'drone-2'].includes(data.id) || !['moving', 'stationary', 'unknown'].includes(data.motion)) return;
  const timestamp = Date.parse(data.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 5000 || Date.now() - timestamp >= 10000) return;
  let position = null;
  if (data.position != null) {
    const p = data.position;
    if (typeof p !== 'object' || !['x','y','z'].every(axis => typeof p[axis] === 'number' && Number.isFinite(p[axis])) || typeof p.frame !== 'string' || !p.frame.trim() || p.frame.length > 80) return;
    position = {x:p.x, y:p.y, z:p.z, frame:p.frame};
  }
  let velocity = null;
  if (data.velocity != null) {
    const v = data.velocity;
    if (typeof v !== 'object' || !['x','y','z'].every(axis => typeof v[axis] === 'number' && Number.isFinite(v[axis]))) return;
    velocity = {x:v.x, y:v.y, z:v.z};
  }
  const previous = droneRecords.get(data.id);
  if (previous && timestamp <= previous.timestamp) return;
  droneRecords.set(data.id, {position, velocity, motion:data.motion, flight:data.flight, heading:data.heading, timestamp, receivedAt:timestamp});
  renderDrones();
});
$('#dronesButton').addEventListener('click', () => { renderDrones(); droneDialog.showModal(); });
droneDialog.querySelector('.dismiss').addEventListener('click', () => droneDialog.close());
setInterval(() => { if (droneDialog.open) renderDrones(); }, 1000);
renderDrones();

async function refreshDrones() {
  try {
    const response = await fetch('/api/drones', {cache:'no-store'});
    const data = await response.json();
    if (!response.ok || data.mode !== 'simulation' || !Array.isArray(data.drones)) throw new Error('Invalid status');
    realTello = data.real && data.real.id === 'tello' ? data.real : null;
    $('.mode-label').textContent = realTello ? 'Simulation + real Tello' : 'Simulation';
    for (const drone of data.drones) {
      if (!drone.position) continue;
      window.dispatchEvent(new CustomEvent('metoera:telemetry', {detail:{
        id:drone.id, timestamp:drone.timestamp,
        position:{...drone.position, frame:'virtual origin'}, motion:drone.motion, flight:drone.flight, heading:drone.heading
      }}));
    }
    $('#droneState').textContent=realTello?'2 virtual drones + real Tello':'2 virtual drones';
  } catch {
    droneRecords.clear();
    $('#droneState').textContent='Simulator unavailable';
    renderDrones();
  }
}
refreshDrones();
setInterval(refreshDrones, 1500);
