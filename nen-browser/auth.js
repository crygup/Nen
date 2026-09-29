import { createServer } from 'node:http';
let callback;
export async function prepareSignIn(nonce) {
 if(!/^[a-f0-9-]{36}$/.test(nonce))throw Error('Invalid sign-in request.');
 if(callback)throw Error('A sign-in is already in progress. Try again in three minutes.');
 const server=createServer((req,res)=>{
  if(req.url!=='/callback'){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'"});
  res.end(`<!doctype html><title>Nen AniList</title><p>Connecting AniList to Nen.</p><script>const params=new URLSearchParams(location.hash.slice(1));const token=params.get('access_token');history.replaceState(null,'','/callback');if(token&&params.get('state')===${JSON.stringify(nonce)}&&opener){opener.postMessage({token,nonce:${JSON.stringify(nonce)}},'http://127.0.0.1:5174');document.querySelector('p').textContent='You can close this tab.';}else document.querySelector('p').textContent='Sign-in failed. Close this tab and try again.';</script>`);
  clearTimeout(timer);server.close();callback=undefined;
 });
 callback=server;const timer=setTimeout(()=>{server.close();callback=undefined;},180000);
 await new Promise((resolve,reject)=>{server.once('error',error=>{clearTimeout(timer);callback=undefined;reject(error);});server.listen(43187,'127.0.0.1',resolve);});
}
