const compact=matchMedia('(max-width: 700px)');
function sidebar(){
 const bar=document.querySelector<HTMLElement>('.sidebar');if(!bar||bar.querySelector('.sidebar-toggle'))return;
 for(const button of bar.querySelectorAll<HTMLButtonElement>('button')){
  const label=button.textContent?.trim()||'';button.setAttribute('aria-label',label);button.title=label;
  for(const node of Array.from(button.childNodes))if(node.nodeType===Node.TEXT_NODE){const span=document.createElement('span');span.className='nav-label';span.textContent=node.textContent;node.replaceWith(span);}
 }
 const toggle=document.createElement('button');toggle.className='sidebar-toggle';toggle.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
 const update=()=>{const collapsed=compact.matches&&localStorage.getItem('nen-sidebar')!=='expanded';document.documentElement.classList.toggle('sidebar-collapsed',collapsed);toggle.setAttribute('aria-expanded',String(!collapsed));toggle.setAttribute('aria-label',collapsed?'Expand sidebar':'Collapse sidebar');};
 toggle.onclick=()=>{localStorage.setItem('nen-sidebar',document.documentElement.classList.contains('sidebar-collapsed')?'expanded':'collapsed');update();};bar.prepend(toggle);update();
 compact.addEventListener('change',()=>{if(compact.matches)localStorage.setItem('nen-sidebar','collapsed');update();});
}
new MutationObserver(sidebar).observe(document.querySelector('#app')!,{childList:true});sidebar();

function downloadButton() {
 const actions=document.querySelector('.sidebar-bottom');
 const home=document.querySelector('#page-title h1')?.textContent==='Home';
 const windows=/Windows NT/.test(navigator.userAgent);
 const existing=document.querySelector('#windows-download');
 if(!home||!windows){existing?.remove();return;}
 if(!actions||existing)return;
 const button=document.createElement('button');button.id='windows-download';button.type='button';button.setAttribute('aria-label','Download');button.title='Download';
 button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg><span class="nav-label">Download</span>';
 button.onclick=()=>{location.href='/win-download';};actions.prepend(button);
}
new MutationObserver(downloadButton).observe(document.querySelector('#app')!,{childList:true,subtree:true});downloadButton();
