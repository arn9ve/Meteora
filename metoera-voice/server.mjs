import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const port = 18787;
http.createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  if (req.url === '/session' && req.method === 'POST') {
    if (req.headers.origin !== `http://localhost:${port}` && req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    if (!process.env.XAI_API_KEY) { res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Imposta XAI_API_KEY nel terminale.'})); return; }
    try {
      const response=await fetch('https://api.x.ai/v1/realtime/client_secrets',{method:'POST',headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({expires_after:{seconds:300}})});
      const body=await response.text(); res.writeHead(response.ok?200:502,{'Content-Type':'application/json'}).end(response.ok?body:JSON.stringify({error:'Impossibile ottenere il token xAI. Verifica chiave e account.'}));
    } catch { res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Connessione a xAI non disponibile.'})); } return;
  }
  const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
  if(req.method!=='GET'||!files[req.url]) {res.writeHead(404).end();return;}
  try {const file=files[req.url];res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(file)]}).end(await readFile(join('public',file)));} catch {res.writeHead(500).end();}
}).listen(port,'127.0.0.1',()=>console.log(`Metoera: http://localhost:${port}`));
