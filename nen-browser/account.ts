import { readRemote, preview, apply, syncFavorites, setRemoteWatch, setRemoteFavorite } from '../app/electron/anilist';
import type { State, SyncChange, WatchEntry } from '../app/src/shared';

export function connectAccount(getState:()=>State, save:()=>void) {
 let token=sessionStorage.getItem('nen-anilist-token')||'';
 let review: {remote:Awaited<ReturnType<typeof readRemote>>['entries'];changes:SyncChange[]}|undefined;
 let busy=false;
 getState().anilist.connected=!!token;
 const sync=async()=>{
  const state=getState();if(busy||review||!token||!state.anilist.lastSync)return;
  busy=true;
  try {await syncFavorites(token,state.favorites,state.favoriteChanges);const remote=await readRemote(token);const changes=preview(state.watch,remote.entries,state.anilist).changes;await apply(token,state.watch,remote.entries,state.anilist,changes.filter(row=>!row.conflict));if(changes.some(row=>row.conflict))state.anilist.error='Some AniList changes need review. Open Sync now.';}
  catch(e){state.anilist.error=String(e);}finally{busy=false;save();}
 };
 setInterval(()=>void sync(),12000);
 return {
  remoteWatch:async(id:number,entry?:WatchEntry)=>{if(busy)throw Error('AniList sync is running.');if(token){busy=true;try{await setRemoteWatch(token,id,entry);if(entry)getState().anilist.baseline[String(id)]={status:entry.status,count:entry.count,repeat:entry.repeat};}finally{busy=false;}}review=undefined;},
  remoteFavorite:async(id:number,favorite:boolean)=>{if(busy)throw Error('AniList sync is running.');if(token){busy=true;try{await setRemoteFavorite(token,id,favorite);delete getState().favoriteChanges[String(id)];}finally{busy=false;}}else getState().favoriteChanges[String(id)]=favorite;},
  anilistConnect:async()=>{
   const local=location.hostname==='127.0.0.1';
   if(!local&&location.protocol!=='https:')throw Error('AniList sign-in requires HTTPS.');
   const popup=window.open('about:blank','_blank');if(!popup)throw Error('Allow popups to connect AniList.');
   const nonce=crypto.randomUUID();
   try {
    let clientId='51914';
    if(local){const response=await fetch('/nen-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce})});if(!response.ok)throw Error(await response.text());}
    else{const config=await fetch('/nen-config').then(r=>r.json());clientId=config.anilistClientId;if(!/^\d+$/.test(clientId))throw Error('AniList sign-in is not configured yet.');popup.sessionStorage.setItem('nen-oauth-nonce',nonce);}
    const value=await new Promise<string>((resolve,reject)=>{
     const finish=(error?:Error,value?:string)=>{clearTimeout(timer);clearInterval(closed);window.removeEventListener('message',receive);error?reject(error):resolve(value!);};
     const receive=(event:MessageEvent)=>{if(event.origin!==(local?'http://127.0.0.1:43187':location.origin)||event.source!==popup||event.data?.nonce!==nonce)return;if(typeof event.data.token!=='string'||! /^[\w.-]{20,5000}$/.test(event.data.token))return;finish(undefined,event.data.token);};
     const timer=setTimeout(()=>finish(Error('AniList sign-in timed out.')),180000);
     const closed=setInterval(()=>{if(popup.closed)finish(Error('AniList sign-in was closed.'));},1000);
     window.addEventListener('message',receive);popup.location.href='https://anilist.co/api/v2/oauth/authorize?client_id='+encodeURIComponent(clientId)+'&response_type=token&state='+encodeURIComponent(nonce);
    });
    const remote=await readRemote(value);token=value;sessionStorage.setItem('nen-anilist-token',token);getState().anilist={connected:true,user:remote.user,baseline:{}};review=undefined;save();
   }finally{popup.close();}
  },
  anilistDisconnect:async()=>{if(busy)throw Error('Wait for AniList sync to finish.');token='';sessionStorage.removeItem('nen-anilist-token');getState().anilist={connected:false,baseline:{}};review=undefined;save();return structuredClone(getState());},
  anilistPreview:async()=>{if(busy)throw Error('AniList sync is running. Try again shortly.');if(!token)throw Error('Connect AniList first.');busy=true;try{const state=getState();await syncFavorites(token,state.favorites,state.favoriteChanges);const remote=await readRemote(token);state.anilist.user=remote.user;const result=preview(state.watch,remote.entries,state.anilist);review={remote:remote.entries,changes:result.changes};save();return result;}finally{busy=false;}},
  anilistApply:async(choices:SyncChange[])=>{if(busy)throw Error('AniList sync is running.');if(!review||choices.length!==review.changes.length||choices.some((r,i)=>r.mediaId!==review!.changes[i].mediaId||r.field!==review!.changes[i].field||!['local','remote',undefined].includes(r.choice)))throw Error('Review AniList changes again.');busy=true;try{const state=getState();await apply(token,state.watch,review.remote,state.anilist,review.changes.map((row,i)=>({...row,choice:choices[i].choice})));review=undefined;save();return structuredClone(state);}finally{busy=false;}},
 };
}
