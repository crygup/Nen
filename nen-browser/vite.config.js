import { downloadInstaller } from './download.js';
import { prepareSignIn } from './auth.js';
import { defineConfig } from "vite";
import { handleApi } from "./api.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
const version = JSON.parse(readFileSync(new URL("../app/package.json", import.meta.url), "utf8")).version.replace(/-.*$/, "");
const commit = process.env.NEN_BUILD_COMMIT || process.env.GITHUB_SHA || "";
export default defineConfig({
  define: { NEN_BROWSER_VERSION: JSON.stringify(commit ? `${version}-build.${commit.slice(0,7)}` : `${version}-dev`) },
  build: { target: 'es2022' },
  plugins: [{
    name: "nen-browser-platform", enforce: "pre",
    generateBundle() { this.emitFile({type:"asset",fileName:"version.json",source:JSON.stringify({commit:commit || null})}); },
    transform(code,id) {
      if(id.replaceAll("\\", "/").endsWith("/electron/together.ts")) return code.replace('process.env.NEN_TOGETHER_URL || "wss://together.crygup.com/session"', '(location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/nen-session"');
      if(id.replaceAll("\\", "/").endsWith("/electron/anilist.ts")) return code.replace(/const endpoint = [\s\S]*?;\r?\n/, 'const endpoint = "https://graphql.anilist.co";\n');
      if (id.replaceAll("\\", "/").endsWith("/src/watch.ts")) {
        const start = code.indexOf('  const surface = el<HTMLCanvasElement>');
        const end = code.indexOf('  let latest: Playback;',start);
        if(start<0||end<0) throw Error("Nen player changed. Update the browser video binding.");
        return code.slice(0,start) + '  void api.startVideo().catch(actions.error);\n' + code.slice(end);
      }
      if (id.replaceAll("\\", "/").endsWith("/src/main.ts")) {
        return code.replace('await releasePicker(await api.media(p.mediaId), p.episode);','await api.control("sources");')
          .replace('Available sources may have no active seeders or no matching episode.','The streaming provider may not have this title or episode. Try again later.')
          .replace('Open Settings, then check for updates. You can also enable auto updates to install new builds on launch.','Reload this browser page to use the latest website build.');
      }
    },
    configureServer(server) {
      server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]==='/win-download')void downloadInstaller(req,res);else next();});
      server.middlewares.use('/nen-auth',async(req,res)=>{
        if(req.method!=='POST'||req.headers.origin!=='http://127.0.0.1:5174'){res.writeHead(403).end();return;}
        try{let body='';for await(const chunk of req){body+=chunk;if(body.length>1000)throw Error('Request too large.');}await prepareSignIn(JSON.parse(body).nonce);res.writeHead(204).end();}catch(e){res.writeHead(400,{'Content-Type':'text/plain'}).end(e.message);}
      });
      server.middlewares.use('/nen-api',(req,res)=>handleApi(req,res,true));
    }
  }],
  server:{host:'0.0.0.0',proxy:{'/nen-session':{target:'wss://together.crygup.com',ws:true,changeOrigin:true,rewrite:()=>'/session',configure:proxy=>proxy.on('proxyReqWs',req=>req.removeHeader('origin'))}},fs:{allow:[resolve('..')]},watch:{usePolling:true,interval:500,ignored:['**/test-results/**','**/*.log']}},
});
