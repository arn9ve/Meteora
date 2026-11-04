import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const elements = new Map();
  class Element {
    constructor() { this.hidden = false; this.disabled = false; this.open = false; this.textContent = ''; this.clientWidth = 0; this.clientHeight = 0; this.handlers = {}; this.style = {setProperty(){}}; this.classList = {toggle(){},add(){}}; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    click() { return this.handlers.click?.({target:this}); }
    querySelector(selector) { if (!this.children) this.children = new Map(); if (!this.children.has(selector)) this.children.set(selector,new Element()); return this.children.get(selector); }
    setAttribute() {} append() {} replaceChildren() {} showModal() { this.open = true; } close() { this.open = false; }
    getBoundingClientRect() { return {left:0,right:10,top:0,bottom:10}; }
  }
  const element = selector => {if(!elements.has(selector)) elements.set(selector,new Element());return elements.get(selector)};
  let resolveMedia;
  const media = new Promise(resolve => {resolveMedia=resolve});
  let stopped = 0;
  const track = {stop(){stopped++}};
  class AudioContext {
    constructor(){this.sampleRate=24000;this.destination={}}
    async resume(){} close(){} createMediaStreamSource(){return {connect(){},disconnect(){}}} createAnalyser(){return {fftSize:0,getByteTimeDomainData(){}}} createScriptProcessor(){return {connect(){},disconnect(){}}}
  }
  class WebSocket {
    static OPEN = 1;
    constructor(){this.readyState=0;WebSocket.last=this}
    send(){} close(){this.readyState=3} open(){this.readyState=1;this.onopen()}
  }
  const globals = {
    document:{querySelector:element,createElement:()=>new Element()},
    window:{addEventListener(){},dispatchEvent(){}},
    navigator:{mediaDevices:{getUserMedia:()=>media}}, AudioContext, WebSocket,
    ResizeObserver:class{observe(){}}, CustomEvent:class{},
    fetch:async url => url==='/session'?{ok:true,json:async()=>({value:'test-token'})}:{ok:false,json:async()=>({})},
    innerWidth:390, performance:{now:()=>0},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval(){},console,Date,Math,Number,Array,Map,Uint8Array,Int16Array,Promise,Error,
  };
  vm.runInNewContext(source,globals);
  return {element,resolveMedia,track,get stopped(){return stopped},WebSocket};
}

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
