const $ = (s) => document.querySelector(s);
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
let socket,stream,context,processor,source,playAt=0,playing=[], pending=[],activity=0, flying=false, stopping=false;
const button=$('#voiceButton');
function state(label, hint, connected=false){$('#connection').textContent=label;$('#hint').textContent=hint; $('#voiceHint').textContent=hint;$('#buttonLabel').textContent=connected?'Termina conversazione':'Avvia conversazione';$('.voice').classList.toggle('listening',connected); $('#textHint').textContent=connected?'Il messaggio verrà inviato a Grok.':'Avvia prima la conversazione dalle impostazioni.'; button.setAttribute('aria-pressed',String(connected))}
function log(name,detail){if(!activity)$('#activity').textContent='';activity++;$('#count').textContent=String(activity).padStart(2,'0');const row=document.createElement('div');row.className='entry';const icon=document.createElement('span');icon.className='icon';icon.textContent='↗';const body=document.createElement('div');body.textContent=name;const sub=document.createElement('small');sub.textContent=detail;body.append(sub);row.append(icon,body);$('#activity').prepend(row)}
function send(obj){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(obj))}
function stopAudio(){for(const node of playing){try{node.stop()}catch{}}playing=[];playAt=0}
function disconnect(){stopping=true;cancelAnimationFrame(frame);analyser=null;stopAudio();processor?.disconnect();source?.disconnect();stream?.getTracks().forEach(t=>t.stop());context?.close();socket?.close();socket=stream=context=processor=source=null;pending=[];button.disabled=false;state('SESSIONE TERMINATA','Avvia la voce per ricominciare')}
function playback(base64){if(!context)return;const raw=atob(base64);const len=Math.floor(raw.length/2);const buf=context.createBuffer(1,len,24000);const data=buf.getChannelData(0);for(let i=0;i<len;i++){let n=raw.charCodeAt(i*2)|(raw.charCodeAt(i*2+1)<<8);if(n>=32768)n-=65536;data[i]=n/32768}const node=context.createBufferSource();node.buffer=buf;node.connect(context.destination);playAt=Math.max(context.currentTime,playAt);node.start(playAt);playAt+=buf.duration;playing.push(node);node.onended=()=>{playing=playing.filter(n=>n!==node)}}
// The simulation deliberately has no connection to a physical drone.
async function simulate(name,args){const labels={takeoff:'Decollo',land:'Atterraggio',move:'Spostamento',rotate:'Rotazione'};if(!labels[name])return {ok:false,mode:'simulation',error:'Azione non disponibile'};if(name==='takeoff'&&flying)return {ok:false,mode:'simulation',error:'Il drone simulato è già in volo'};if(name!=='takeoff'&&!flying)return {ok:false,mode:'simulation',error:'Il drone simulato è a terra'};if(name==='takeoff')flying=true;if(name==='land')flying=false;$('#droneState').textContent=flying?'In volo':'A terra';log(labels[name],`Simulato${Object.keys(args).length?' · '+Object.values(args).join(' '):''}`);return {ok:true,mode:'simulation',action:name,state:flying?'flying':'landed',message:'Azione simulata, nessun drone fisico controllato'} }
async function finishCalls(){const calls=pending;pending=[];for(const event of calls){let result;try{result=await simulate(event.name,JSON.parse(event.arguments||'{}'))}catch{result={ok:false,mode:'simulation',error:'Argomenti non validi'}}send({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.call_id,output:JSON.stringify(result)}})}if(calls.length)send({type:'response.create'})}
const tool=(name,description,properties={},required=[])=>({type:'function',name,description,parameters:{type:'object',properties,required,additionalProperties:false}});
async function start(){state('CONNESSIONE…','Connessione vocale in corso.');button.disabled=true;stopping=false;try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});context=new AudioContext({sampleRate:24000});await context.resume();const tokenResponse=await fetch('/session',{method:'POST'});const token=await tokenResponse.json();if(!tokenResponse.ok)throw Error(token.error||'Token non disponibile');if(!token.value)throw Error('Risposta token non valida');socket=new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest',[`xai-client-secret.${token.value}`]);socket.onopen=()=>{send({type:'session.update',session:{voice:'eve',instructions:'Sei Grok, assistente vocale di Metoera. Parla in italiano in modo conciso. Il controller è esclusivamente simulato: specifica sempre che ogni azione è simulata. Non affermare mai che un drone reale si è mosso. Esegui una sola azione per volta, attendi il risultato prima della successiva. Se una azione fallisce interrompi la sequenza.',turn_detection:{type:'server_vad'},audio:{input:{format:{type:'audio/pcm',rate:context.sampleRate},transcription:{language_hint:'it'}},output:{format:{type:'audio/pcm',rate:24000}}},tools:[tool('takeoff','Simula il decollo'),tool('land','Simula atterraggio'),tool('move','Simula uno spostamento',{direction:{type:'string',enum:['forward','back','left','right','up','down']},centimeters:{type:'integer',minimum:20,maximum:500}},['direction','centimeters']),tool('rotate','Simula una rotazione',{direction:{type:'string',enum:['clockwise','counterclockwise']},degrees:{type:'integer',minimum:1,maximum:360}},['direction','degrees'])]}});source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);animatePattern();processor=context.createScriptProcessor(4096,1,1);processor.onaudioprocess=e=>{if(socket?.readyState!==WebSocket.OPEN)return;const input=e.inputBuffer.getChannelData(0);const pcm=new Int16Array(input.length);for(let i=0;i<input.length;i++)pcm[i]=Math.max(-1,Math.min(1,input[i]))*32767;let str='';const bytes=new Uint8Array(pcm.buffer);for(let i=0;i<bytes.length;i++)str+=String.fromCharCode(bytes[i]);send({type:'input_audio_buffer.append',audio:btoa(str)})};source.connect(processor);processor.connect(context.destination);state('IN ASCOLTO','Parla con Grok',true);$('#settingsDialog').close();button.disabled=false};socket.onmessage=async message=>{const e=JSON.parse(message.data);if(e.type==='input_audio_buffer.speech_started')stopAudio();if(e.type==='response.output_audio.delta'||e.type==='response.audio.delta')playback(e.delta);if(e.type==='conversation.item.input_audio_transcription.completed'){$('#transcript').textContent=`“${e.transcript}”`;$('#headline').textContent='Tu'}if(e.type==='response.output_audio_transcript.delta'||e.type==='response.audio_transcript.delta'){if($('#headline').textContent!=='Grok'){$('#headline').textContent='Grok';$('#transcript').textContent=''}$('#transcript').textContent+=e.delta}if(e.type==='response.function_call_arguments.done')pending.push(e);if(e.type==='response.done'&&pending.length)await finishCalls();if(e.type==='error'){$('#hint').textContent=e.error?.message||'Errore nella sessione'}};socket.onerror=()=>{$('#hint').textContent='Connessione vocale non riuscita.'};socket.onclose=()=>{if(!stopping){disconnect();state('CONNESSIONE INTERROTTA','Riprova ad avviare la sessione')}}}catch(error){disconnect();state('NON CONNESSO',error.message||'Impossibile avviare la sessione')}}
button.addEventListener('click',()=>socket?disconnect():start());

const settings = $('#settingsDialog');
const keyboard = $('#keyboardDialog');
$('#settingsButton').addEventListener('click', () => settings.showModal());
$('#keyboardButton').addEventListener('click', () => keyboard.showModal());
$('#closeButton').addEventListener('click', disconnect);
for (const dialog of [settings, keyboard]) {
  dialog.querySelector('.dismiss').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if(event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }});
}
$('#messageForm').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#message').value.trim();
  if (!text) return;
  if (socket?.readyState !== WebSocket.OPEN) { $('#textHint').textContent='La voce non è connessa. Avvia la conversazione dalle impostazioni.'; return; }
  stopAudio();
  send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}});
  send({type:'response.create'});
  $('#headline').textContent='Tu';
  $('#transcript').textContent=`“${text}”`;
  $('#message').value='';
  keyboard.close();
});
window.addEventListener('pagehide', disconnect);
