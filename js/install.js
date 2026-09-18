// A discoverable PWA install path. Browsers require a click before showing
// their native prompt; iOS exposes installation through Safari's Share menu.
const INSTALL_DISMISSED_KEY = 'eatify.install.dismissedUntil';
let installPrompt = null;

function appInstalled(){
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function installDismissed(){
  try { return Number(localStorage.getItem(INSTALL_DISMISSED_KEY)||0) > Date.now(); }
  catch(e){ return false; }
}
function recordInstallEvent(event){
  if (typeof productEvent === 'function') productEvent(event);
}

async function requestEatifyInstall(){
  if(appInstalled()){ toast('Eatify is already installed.'); return {installed:true}; }
  if(installPrompt){
    installPrompt.prompt();
    const choice=await installPrompt.userChoice;
    installPrompt=null;
    recordInstallEvent(choice.outcome==='accepted'?'install_accepted':'install_prompt_dismissed');
    return choice;
  }
  const isiOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
  await alertSheet({
    title:'Install Eatify',
    body: isiOS
      ? 'Open Eatify in Safari, tap Share, choose Add to Home Screen, turn on Open as Web App, then tap Add.'
      : 'Open your browser menu and choose Install app or Add to Home screen. Eatify will then open on its own and stay easy to find.'
  });
  recordInstallEvent(isiOS?'install_ios_help':'install_help');
  return {instructions:true};
}

function dismissInstallInvite(){
  try { localStorage.setItem(INSTALL_DISMISSED_KEY,String(Date.now()+14*864e5)); }catch(e){}
  document.getElementById('installInvite')?.remove();
  recordInstallEvent('install_invite_dismissed');
}

function offerEatifyInstall(){
  if(appInstalled() || installDismissed() || document.getElementById('installInvite')) return;
  const anchor=document.getElementById('guideInvite');
  const host=anchor?.parentElement || document.getElementById('tabToday');
  if(!host) return;
  const invite=document.createElement('div');
  invite.className='read-item install-invite';
  invite.id='installInvite';
  invite.innerHTML=`<div class="grow"><b>Want Eatify to feel like an app?</b><span>Add it to your home screen. It opens on its own and keeps your offline meals close.</span></div><div class="install-invite-actions"><button type="button" data-install-now>Install</button><button type="button" class="ghost" data-install-later>Not now</button></div>`;
  anchor ? anchor.before(invite) : host.prepend(invite);
  invite.querySelector('[data-install-now]').onclick=requestEatifyInstall;
  invite.querySelector('[data-install-later]').onclick=dismissInstallInvite;
  recordInstallEvent('install_invite_shown');
}

window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  installPrompt=event;
});
window.addEventListener('appinstalled',()=>{
  installPrompt=null;
  document.getElementById('installInvite')?.remove();
  recordInstallEvent('installed');
});
