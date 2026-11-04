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
// Every voice action goes to the real Tello through the local server.
const actionLabels={takeoff:'Takeoff',land:'Landing',move:'Move',rotate:'Rotation',flip:'Flip',speed:'Speed',stop:'Stop',status:'Status',test_flight:'Test flight'};
async function command(name,args){
  try {
    // droneId and action go last so the model's arguments cannot override them.
    const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...args,droneId:'tello',action:name})});
    const result=await response.json();
    if(!response.ok) return {ok:false,mode:'real',error:serverMessage(result.error)||'Server unavailable'};
    log(`Tello · ${actionLabels[name] || name}`,result.ok?'Done':`Rejected · ${serverMessage(result.error)}`);
    await refreshDrone();
    return result;
  } catch { return {ok:false,mode:'real',error:'Server unreachable'}; }
}

async function finishCalls(){
  const run=generation;
  const calls=pending;
  pending=[];
  let stopped=false;
  for(const event of calls){
    if(run!==generation) return;
    let result;
    // After a failure the rest of the sequence is skipped, except stop and land.
    if(stopped && !['stop','land'].includes(event.name)) result={ok:false,mode:'real',error:'Skipped because an earlier command failed'};
    else {
      try {result=await command(event.name,JSON.parse(event.arguments||'{}'));}
      catch {result={ok:false,mode:'real',error:'Invalid arguments'};}
    }
    if(run!==generation) return;
    if(!result.ok) stopped=true;
    send({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.call_id,output:JSON.stringify(result)}});
  }
  if(calls.length)send({type:'response.create'});
}
const tool=(name,description,properties={},required=[])=>({type:'function',name,description,parameters:{type:'object',properties,required,additionalProperties:false}});
const INSTRUCTIONS='You are Grok, the voice pilot of one real Tello EDU drone for Metoera. Every tool call physically moves the drone, so do exactly what the person says: no extra steps, no skipped steps, no changed values. Speak concisely. If a value you need is missing or unclear (distance, angle, direction), ask for it; never guess. Convert units yourself: 1 meter = 100 centimeters, half a meter = 50. Turn right means clockwise, turn left means counterclockwise. For a sequence, call one tool at a time in the order given and wait for each result; if one fails, stop and say why. If the person says stop, wait, hold or freeze, call stop at once. If they say land, or sound alarmed, call land at once. If they just say fly or test flight, call test_flight. Only say the drone did something when the result is ok, and report rejections in plain words, including limits such as the maximum distance.';
const dir=(values)=>({type:'string',enum:values});
const TOOLS=[
  tool('takeoff','Take off and hover at about 80 cm'),
  tool('land','Land now'),
  tool('stop','Hover in place immediately, interrupting a move in progress'),
  tool('move','Move in a straight line',{direction:dir(['forward','back','left','right','up','down']),centimeters:{type:'integer',minimum:20,maximum:500}},['direction','centimeters']),
  tool('rotate','Turn in place',{direction:dir(['clockwise','counterclockwise']),degrees:{type:'integer',minimum:1,maximum:360}},['direction','degrees']),
  tool('flip','Flip in a direction; needs at least 50% battery',{direction:dir(['left','right','forward','back'])},['direction']),
  tool('speed','Set the speed used by later moves',{cmPerSecond:{type:'integer',minimum:10,maximum:100}},['cmPerSecond']),
  tool('status','Read battery, height, heading and whether the drone is flying'),
  tool('test_flight','Take off, hover 5 seconds, then land'),
];
async function start(){const run=++generation;state('CONNECTING…','Connecting voice session.');$('#startVoice').disabled=true;stopping=false;try{const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});if(run!==generation){acquired.getTracks().forEach(t=>t.stop());return}stream=acquired;context=new AudioContext({sampleRate:24000});await context.resume();if(run!==generation)return;const tokenResponse=await fetch('/session',{method:'POST'});const token=await tokenResponse.json();if(run!==generation)return;if(!tokenResponse.ok)throw Error(serverMessage(token.error)||'Token unavailable');if(!token.value)throw Error('Invalid token response');socket=new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest',[`xai-client-secret.${token.value}`]);socket.onopen=()=>{if(run!==generation)return;send({type:'session.update',session:{voice:'eve',instructions:INSTRUCTIONS,turn_detection:{type:'server_vad'},audio:{input:{format:{type:'audio/pcm',rate:context.sampleRate},transcription:{language_hint:'en'}},output:{format:{type:'audio/pcm',rate:24000}}},tools:TOOLS}});source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);animatePattern();processor=context.createScriptProcessor(4096,1,1);processor.onaudioprocess=e=>{if(socket?.readyState!==WebSocket.OPEN)return;const input=e.inputBuffer.getChannelData(0);const pcm=new Int16Array(input.length);for(let i=0;i<input.length;i++)pcm[i]=Math.max(-1,Math.min(1,input[i]))*32767;let str='';const bytes=new Uint8Array(pcm.buffer);for(let i=0;i<bytes.length;i++)str+=String.fromCharCode(bytes[i]);send({type:'input_audio_buffer.append',audio:btoa(str)})};source.connect(processor);processor.connect(context.destination);state('LISTENING','Speak to Grok',true);$('#headline').textContent='Grok';$('#transcript').textContent="I am listening.";if ($('#settingsDialog').open) $('#settingsDialog').close();$('#startVoice').disabled=false};socket.onmessage=async message=>{if(run!==generation)return;const e=JSON.parse(message.data);if(e.type==='input_audio_buffer.speech_started')stopAudio();if(e.type==='response.output_audio.delta'||e.type==='response.audio.delta')playback(e.delta);if(e.type==='conversation.item.input_audio_transcription.completed'){$('#transcript').textContent=`“${e.transcript}”`;$('#headline').textContent='You'}if(e.type==='response.output_audio_transcript.delta'||e.type==='response.audio_transcript.delta'){if($('#headline').textContent!=='Grok'){$('#headline').textContent='Grok';$('#transcript').textContent=''}$('#transcript').textContent+=e.delta}if(e.type==='response.function_call_arguments.done')pending.push(e);if(e.type==='response.done'&&pending.length)await finishCalls();if(e.type==='error'){$('#hint').textContent=e.error?.message||'Session error'}};socket.onerror=()=>{if(run===generation)$('#hint').textContent='Voice connection failed.'};socket.onclose=()=>{if(run===generation&&!stopping){disconnect();state('CONNECTION LOST','Try starting the session again')}}}catch(error){if(run!==generation)return;disconnect();state('NOT CONNECTED',error.message||'Could not start the session')}}
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

// The real Tello as reported by the server; null when it is not configured or unreachable.
let drone = null;
const droneDialog = $('#dronesDialog');
function renderDrone() {
  const grid = $('#droneGrid');
  grid.replaceChildren();
  const card = document.createElement('article');
  card.className = 'drone-card';
  card.innerHTML = '<div class="drone-card-head"><h3>Tello EDU</h3><span class="drone-availability"></span></div><p class="drone-position">TELEMETRY</p><div class="drone-coordinates"></div><div class="drone-motion"><span>State</span><strong></strong></div>';
  card.querySelector('.drone-availability').textContent = !drone ? 'Not configured' : drone.connected ? (drone.verified ? 'Connected · serial verified' : 'Telemetry received') : 'Waiting for first command';
  card.querySelector('.drone-coordinates').textContent = drone?.connected ? `Battery ${drone.battery ?? '–'}% · Height ${drone.heightCm ?? '–'} cm` : 'Unavailable';
  card.querySelector('.drone-motion strong').textContent = drone ? `${drone.flight === 'flying' ? 'Flying' : 'On the ground'}${Number.isFinite(drone.heading) ? ` · ${drone.heading}°` : ''}${drone.lastError ? ` · ${drone.lastError}` : ''}` : 'Unavailable';
  grid.append(card);
  $('#telemetryNote').textContent = !drone ? 'Set TELLO_IP in .env.tello and restart the server.' : drone.connected ? 'Live telemetry from the drone.' : 'Telemetry starts after the first command.';
}
$('#dronesButton').addEventListener('click', () => { renderDrone(); droneDialog.showModal(); });
droneDialog.querySelector('.dismiss').addEventListener('click', () => droneDialog.close());

async function refreshDrone() {
  try {
    const response = await fetch('/api/drones', {cache:'no-store'});
    const data = await response.json();
    if (!response.ok || !('drone' in data)) throw new Error('Invalid status');
    drone = data.drone && data.drone.id === 'tello' ? data.drone : null;
    $('#droneState').textContent = !drone ? 'Not configured' : drone.connected ? `Connected · ${drone.battery ?? '–'}%` : 'Waiting for first command';
  } catch {
    drone = null;
    $('#droneState').textContent = 'Server unreachable';
  }
  if (droneDialog.open) renderDrone();
}
refreshDrone();
setInterval(refreshDrone, 1500);
