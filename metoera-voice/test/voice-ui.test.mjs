import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

// `drones()` makes /api/drones answer with those drones (as this laptop sees them).
function setup({ drones, pilot, names } = {}) {
  const elements = new Map();
  const created = [];
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.open = false; this.textContent = ''; this.clientWidth = 0; this.clientHeight = 0; this.handlers = {}; this.style = {setProperty(){}}; this.classList = {toggle(){},add(){}}; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    click() { return this.handlers.click?.({target:this}); }
    querySelector(selector) { if (!this.children) this.children = new Map(); if (!this.children.has(selector)) this.children.set(selector,new Element()); return this.children.get(selector); }
    setAttribute() {} append() {} prepend() {} replaceChildren() {} showModal() { this.open = true; } close() { this.open = false; }
    getBoundingClientRect() { return {left:0,right:10,top:0,bottom:10}; }
  }
  const element = selector => {if(!elements.has(selector)) elements.set(selector,new Element());return elements.get(selector)};
  let resolveMedia;
  const media = new Promise(resolve => {resolveMedia=resolve});
  let stopped = 0;
  const fetches = [];
  const track = {stop(){stopped++}};
  class AudioContext {
    constructor(){this.sampleRate=24000;this.destination={}}
    async resume(){} close(){} createMediaStreamSource(){return {connect(){},disconnect(){}}} createAnalyser(){return {fftSize:0,getByteTimeDomainData(){}}} createScriptProcessor(){return {connect(){},disconnect(){}}}
  }
  class WebSocket {
    static OPEN = 1;
    constructor(){this.readyState=0;WebSocket.last=this}
    send(message){(this.sent ??= []).push(JSON.parse(message))} close(){this.readyState=3} open(){this.readyState=1;this.onopen()}
  }
  const store = names ?? new Map();
  const globals = {
    document:{querySelector:element,createElement:()=>{const e=new Element();created.push(e);return e}},
    window:{addEventListener(){},dispatchEvent(){}},
    navigator:{mediaDevices:{getUserMedia:()=>media}}, AudioContext, WebSocket,
    localStorage:{getItem(key){ return store.has(key) ? store.get(key) : null; }, setItem(key, value){ store.set(key, String(value)); }},
    ResizeObserver:class{observe(){}}, CustomEvent:class{},
    fetch:async (url, options) => {
      fetches.push({url, body:options?.body});
      if (url==='/session') return {ok:true,json:async()=>({value:'test-token'})};
      if (url==='/api/drones' && drones) return {ok:true,json:async()=>({drones:drones(), me:'Barry', clients:[{name:'Arnove',lastSeen:0}], claimsError:null, ...(pilot !== undefined ? {pilot:{name:pilot}} : {})})};
      if (url==='/api/pilot') return {ok:true,json:async()=>({ok:true, name:JSON.parse(options.body).name})};
      if (url==='/api/command' && drones) return {ok:true,json:async()=>({ok:true,mode:'real',action:JSON.parse(options.body).action})};
      return {ok:false,json:async()=>({})};
    },
    innerWidth:390, performance:{now:()=>0},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval(){},setTimeout:()=>0,console,Date,Math,Number,Array,Map,Uint8Array,Int16Array,Promise,Error,
  };
  vm.runInNewContext(source,globals);
  return {element,resolveMedia,track,get stopped(){return stopped},WebSocket,fetches,created,names:store};
}

const MINE = {state:'mine', conflict:null};
const blackMine = {id:'tello', mode:'real', connected:true, verified:true, battery:80, heightCm:0, heading:0, flight:'landed', lastError:null, linkError:null, owner:MINE};
const redOther = {id:'rmtt', mode:'real', connected:true, verified:false, battery:64, heightCm:null, heading:null, flight:'flying', lastError:null, linkError:null, owner:{state:'other', name:'Arnove', pilot:'Amir', locked:true}};
// On the ground and linked to Arnove's laptop: a takeoff from here moves it to this laptop.
const redTakeable = {...redOther, flight:'landed', owner:{state:'other', name:'Arnove', pilot:null, locked:false}};
// On this laptop, flown by another person on the link.
const blackFlownByMarco = {...blackMine, flight:'flying', heightCm:80, pilot:{name:'Marco', me:false}};
const cardOf = (app, colour) => app.created.filter(e => e.className?.includes(`drone-${colour}`)).at(-1);
async function openVoice(app) {
  app.element('#startVoice').click();
  app.resolveMedia({getTracks:()=>[app.track]});
  await tick(); await tick();
  app.WebSocket.last.open();
  return app.WebSocket.last;
}

test('a drone flown from another laptop is greyed, says who flies it, and has no video here', async () => {
  const app = setup({drones:()=>[blackMine, redOther]});
  await tick(); await tick(); // first /api/drones
  app.element('#dronesButton').click();
  const red = cardOf(app, 'red');
  const black = cardOf(app, 'black');
  assert.match(red.className, /drone-other/);
  assert.equal(red.querySelector('.drone-availability').textContent, "Flown by Amir · Arnove's laptop");
  assert.equal(red.querySelector('.drone-video img').src, undefined);
  assert.equal(red.querySelector('.drone-video span').textContent, "Camera on Arnove's laptop");
  assert.equal(red.querySelector('.drone-motion strong').textContent, 'Flying');
  assert.doesNotMatch(black.className, /drone-other/);
  assert.equal(black.querySelector('.drone-availability').textContent, 'Connected · free');
  assert.equal(black.querySelector('.drone-video img').src, '/video/tello');
  assert.equal(app.element('#clientsLine').textContent, 'Laptops on this network: you (Barry), Arnove');
});

test('Grok only gets the drones this person may fly, and is told who flies the others', async () => {
  const app = setup({drones:()=>[blackMine, redOther]});
  await tick(); await tick();
  const ws = await openVoice(app);
  const session = ws.sent.find(m => m.type === 'session.update').session;
  assert.deepEqual(session.tools.find(t => t.name === 'takeoff').parameters.properties.drone.enum, ['black']);
  assert.equal(session.tools.some(t => t.name === 'release'), false); // only landing frees a drone
  assert.match(session.instructions, /Free to fly: black\./);
  assert.match(session.instructions, /red is flown by Amir on Arnove's laptop: you cannot command it at all, not even land, stop or emergency/);
});

test('a landed drone on another laptop can be taken off from here', async () => {
  const app = setup({drones:()=>[blackMine, redTakeable]});
  await tick(); await tick();
  app.element('#dronesButton').click();
  const red = cardOf(app, 'red');
  assert.doesNotMatch(red.className, /drone-other/);
  assert.equal(red.querySelector('.drone-availability').textContent, "On the ground · on Arnove's laptop · say take off to fly it here");
  const ws = await openVoice(app);
  const session = ws.sent.find(m => m.type === 'session.update').session;
  assert.deepEqual(session.tools.find(t => t.name === 'takeoff').parameters.properties.drone.enum, ['black', 'red']);
  assert.match(session.instructions, /red is on the ground, linked to Arnove's laptop: only takeoff, test_flight and status work on it/);
  // land with no drone named stays on this laptop
  ws.onmessage({data:JSON.stringify({type:'response.function_call_arguments.done',name:'land',call_id:'l1',arguments:'{}'})});
  await ws.onmessage({data:JSON.stringify({type:'response.done'})});
  await tick(); await tick();
  const lands = app.fetches.filter(f => f.url === '/api/command').map(f => JSON.parse(f.body));
  assert.deepEqual(lands.map(b => [b.droneId, b.action]), [['tello', 'land']]);
});

test('a drone another person here flies: greyed with its video, left out of Grok and of land with no drone', async () => {
  const app = setup({drones:()=>[blackFlownByMarco, redTakeable]});
  await tick(); await tick();
  app.element('#dronesButton').click();
  const black = cardOf(app, 'black');
  assert.match(black.className, /drone-other/);
  assert.equal(black.querySelector('.drone-availability').textContent, 'Connected · flown by Marco');
  assert.equal(black.querySelector('.drone-video img').src, '/video/tello'); // same laptop: the camera is here
  const ws = await openVoice(app);
  const session = ws.sent.find(m => m.type === 'session.update').session;
  assert.deepEqual(session.tools.find(t => t.name === 'land').parameters.properties.drone.enum, ['red']);
  assert.match(session.instructions, /black is flown by Marco, another person on this laptop: you cannot command it at all/);
  ws.onmessage({data:JSON.stringify({type:'response.function_call_arguments.done',name:'stop',call_id:'s1',arguments:'{}'})});
  await ws.onmessage({data:JSON.stringify({type:'response.done'})});
  assert.equal(app.fetches.filter(f => f.url === '/api/command').length, 0);
  const output = ws.sent.find(m => m.item?.type === 'function_call_output');
  assert.match(output.item.output, /You fly no drone right now/);
});

test('changing your name while you fly warns that the drone will be landed', async () => {
  const app = setup({drones:()=>[{...blackMine, flight:'flying', pilot:{name:'Amir', me:true}}, redTakeable]});
  await tick(); await tick();
  app.element('#pilotLine').click();
  assert.equal(app.element('#nameWarning').hidden, false);
  assert.equal(app.element('#nameWarning').textContent, "You fly Black. With another name you can't command it, and the server lands it after 15 s.");
});

test('when a drone changes hands during a session, Grok gets the new list of drones', async () => {
  let red = redOther;
  const app = setup({drones:()=>[blackMine, red]});
  await tick(); await tick();
  const ws = await openVoice(app);
  red = {...redOther, verified:true, owner:MINE}; // Arnove's laptop let Red go and this laptop took it
  ws.onmessage({data:JSON.stringify({type:'response.function_call_arguments.done',name:'status',call_id:'s1',arguments:'{"drone":"black"}'})});
  await ws.onmessage({data:JSON.stringify({type:'response.done'})});
  for (let i = 0; i < 6; i += 1) await tick(); // the command runs, then /api/drones is read again
  const updates = ws.sent.filter(m => m.type === 'session.update');
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1].session.tools.find(t => t.name === 'takeoff').parameters.properties.drone.enum, ['black', 'red']);
  assert.match(updates[1].session.instructions, /Free to fly: black and red\./);
});

test('land with no drone named goes to every drone that is not another laptop\'s', async () => {
  const app = setup({drones:()=>[blackMine, redOther]});
  await tick(); await tick();
  const ws = await openVoice(app);
  ws.onmessage({data:JSON.stringify({type:'response.function_call_arguments.done',name:'land',call_id:'l1',arguments:'{}'})});
  await ws.onmessage({data:JSON.stringify({type:'response.done'})});
  await tick(); await tick();
  const lands = app.fetches.filter(f => f.url === '/api/command').map(f => JSON.parse(f.body));
  assert.deepEqual(lands.map(b => [b.droneId, b.action]), [['tello', 'land']]);
});

test('cancelling during microphone permission returns to idle and releases late stream', async () => {
  const app=setup();
  app.element('#startVoice').click();
  assert.equal(app.element('#emptyState').hidden,true);
  assert.equal(app.element('#closeButton').hidden,false);
  app.element('#closeButton').click();
  assert.equal(app.element('#emptyState').hidden,false);
  assert.equal(app.element('#closeButton').hidden,true);
  app.resolveMedia({getTracks:()=>[app.track]});
  await tick();
  assert.equal(app.stopped,1);
  assert.equal(app.WebSocket.last,undefined);
});

test('opening and closing voice switches controls and releases microphone', async () => {
  const app=setup();
  app.element('#startVoice').click();
  app.resolveMedia({getTracks:()=>[app.track]});
  await tick(); await tick();
  assert.ok(app.WebSocket.last);
  app.WebSocket.last.open();
  assert.equal(app.element('#startVoice').hidden,true);
  assert.equal(app.element('#closeButton').hidden,false);
  assert.equal(app.element('#conversation').hidden,false);
  app.element('#closeButton').click();
  assert.equal(app.element('#startVoice').hidden,false);
  assert.equal(app.element('#closeButton').hidden,true);
  assert.equal(app.element('#conversation').hidden,true);
  assert.equal(app.stopped,1);
});

test('microphone off clears Grok input and ignores later commands except safety ones', async () => {
  const app=setup();
  app.element('#startVoice').click();
  app.resolveMedia({getTracks:()=>[app.track]});
  await tick(); await tick();
  const ws=app.WebSocket.last;
  ws.open();
  assert.equal(app.element('#muteButton').hidden,false);
  app.element('#muteButton').click();
  const types=ws.sent.map(m=>m.type);
  assert.ok(types.includes('input_audio_buffer.clear'));
  assert.ok(types.includes('response.cancel'));
  // A move that Grok was already producing must not reach the drone.
  ws.onmessage({data:JSON.stringify({type:'response.function_call_arguments.done',name:'move',call_id:'a',arguments:'{"direction":"up","centimeters":50}'})});
  await ws.onmessage({data:JSON.stringify({type:'response.done'})});
  await tick();
  assert.equal(app.fetches.some(f=>f.url==='/api/command'),false);
  const output=ws.sent.find(m=>m.type==='conversation.item.create');
  assert.match(JSON.parse(output.item.output).error,/Microphone is off/);
  // Land still goes through while muted.
  ws.onmessage({data:JSON.stringify({type:'response.function_call_arguments.done',name:'land',call_id:'b',arguments:'{}'})});
  await ws.onmessage({data:JSON.stringify({type:'response.done'})});
  await tick();
  // land without a named drone goes to both drones, even while muted.
  const lands=app.fetches.filter(f=>f.url==='/api/command').map(f=>JSON.parse(f.body));
  assert.deepEqual(lands.map(b=>[b.droneId,b.action]),[['tello','land'],['rmtt','land']]);
});

test('switch off ends the voice session and calls the emergency endpoint', async () => {
  const app=setup();
  app.element('#startVoice').click();
  app.resolveMedia({getTracks:()=>[app.track]});
  await tick(); await tick();
  app.WebSocket.last.open();
  await app.element('#switchOff').click();
  assert.equal(app.element('#startVoice').hidden,false);
  const call=app.fetches.find(f=>f.url==='/api/emergency');
  assert.ok(call);
  assert.deepEqual(JSON.parse(call.body),{kind:'land'});
});

test('cut motors needs a second tap', async () => {
  const app=setup();
  await app.element('#killMotors').click();
  assert.equal(app.fetches.some(f=>f.url==='/api/emergency'),false);
  await app.element('#killMotors').click();
  assert.deepEqual(JSON.parse(app.fetches.find(f=>f.url==='/api/emergency').body),{kind:'motors'});
});

test('a name saved in this browser is reused and the dialog stays closed', async () => {
  const app = setup({drones:()=>[], names:new Map([['metoera_name','Amir']])});
  await tick(); await tick();
  assert.equal(app.element('#nameDialog').open, false);
  assert.equal(JSON.parse(app.fetches.find(f=>f.url==='/api/pilot').body).name, 'Amir');
});

test('a name already on this browser cookie is kept without asking', async () => {
  const app = setup({drones:()=>[], pilot:'Marco'});
  await tick(); await tick();
  assert.equal(app.element('#nameDialog').open, false);
  assert.equal(app.names.get('metoera_name'), 'Marco');
  assert.equal(app.fetches.some(f=>f.url==='/api/pilot'), false);
});

test('a first visit asks for a name', async () => {
  const app = setup({drones:()=>[], pilot:''});
  await tick(); await tick();
  assert.equal(app.element('#nameDialog').open, true);
  assert.equal(app.names.has('metoera_name'), false);
});
