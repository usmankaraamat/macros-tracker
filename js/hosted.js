// hosted.js -- Supabase email auth plus calls to Eatify's quota-controlled backend.
// Provider credentials stay in Edge Function secrets; this file contains only the
// publishable Supabase key, which is already part of the public sync client.

const HOSTED_SESSION_KEY = 'eatify_account_session';

function hostedAuthHeaders(token){
  const key = supaAnonKey();
  return { apikey:key, Authorization:'Bearer '+(token || key), 'Content-Type':'application/json' };
}
function readHostedSession(){
  try { return JSON.parse(localStorage.getItem(HOSTED_SESSION_KEY)||'null'); } catch(e){ return null; }
}
function saveHostedSession(session){
  try { session ? localStorage.setItem(HOSTED_SESSION_KEY,JSON.stringify(session)) : localStorage.removeItem(HOSTED_SESSION_KEY); } catch(e){}
  window.dispatchEvent(new CustomEvent('eatify:auth', {detail:session?.user || null}));
}
function consumeHostedAuthRedirect(){
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const p = new URLSearchParams(raw);
  if (!p.get('access_token')) return;
  const session = {
    access_token:p.get('access_token'), refresh_token:p.get('refresh_token'),
    expires_at:Math.floor(Date.now()/1000) + Number(p.get('expires_in')||3600),
    user:null
  };
  saveHostedSession(session);
  history.replaceState(null,'',location.pathname+location.search);
}
consumeHostedAuthRedirect();

async function hostedSession(){
  let session = readHostedSession();
  if (!session?.access_token) return null;
  if (session.expires_at && session.expires_at > Math.floor(Date.now()/1000)+60 && session.user) return session;
  if (session.refresh_token && (!session.expires_at || session.expires_at <= Math.floor(Date.now()/1000)+60)) {
    const r = await fetch(supaUrl().replace(/\/+$/,'')+'/auth/v1/token?grant_type=refresh_token', {
      method:'POST', headers:hostedAuthHeaders(), body:JSON.stringify({refresh_token:session.refresh_token})
    });
    if (!r.ok){ saveHostedSession(null); return null; }
    session = await r.json(); saveHostedSession(session); return session;
  }
  const r = await fetch(supaUrl().replace(/\/+$/,'')+'/auth/v1/user', {headers:hostedAuthHeaders(session.access_token)});
  if (!r.ok){ saveHostedSession(null); return null; }
  session.user = await r.json(); saveHostedSession(session); return session;
}
function hostedAccountConfigured(){ return !!readHostedSession()?.access_token; }
async function hostedUser(){ return (await hostedSession())?.user || null; }

async function sendMagicLink(email){
  const redirect = location.origin + location.pathname;
  const r = await fetch(supaUrl().replace(/\/+$/,'')+'/auth/v1/otp?redirect_to='+encodeURIComponent(redirect), {
    method:'POST', headers:hostedAuthHeaders(), body:JSON.stringify({email,create_user:true})
  });
  if (!r.ok){ const d=await r.json().catch(()=>({})); throw new Error(d.msg||d.message||'Could not send the sign-in link.'); }
}
async function signOutHosted(){
  const session = await hostedSession();
  if (session) await fetch(supaUrl().replace(/\/+$/,'')+'/auth/v1/logout', {method:'POST',headers:hostedAuthHeaders(session.access_token)}).catch(()=>{});
  saveHostedSession(null);
}

class HostedError extends Error {
  constructor(message,status,body){ super(message); this.name='HostedError'; this.status=status; this.body=body||{}; }
}
async function hostedCall(name, body){
  const session = await hostedSession();
  if (!session) throw new HostedError('Sign in under Settings to use the hosted allowance and sync.',401,{error:'sign_in_required'});
  const r = await fetch(supaUrl().replace(/\/+$/,'')+'/functions/v1/'+name, {
    method:'POST', headers:hostedAuthHeaders(session.access_token), body:JSON.stringify(body)
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new HostedError(data.message||data.error||('Hosted service '+r.status),r.status,data);
  return data;
}
async function hostedAI(prompt,imageB64,personalKey){
  return hostedCall('eatify-ai',{prompt,image:imageB64||'',...(personalKey?{personalKey}:{})});
}
async function hostedUSDA(query,personalKey){
  return hostedCall('eatify-usda',{query,...(personalKey?{personalKey}:{})});
}
function showHostedQuota(quota,label){
  if (!quota) return;
  const el=document.getElementById('hostedStatus');
  if (!el) return;
  el.textContent=`${Math.max(0,quota.limit-quota.used)} hosted ${label} left today.`;
  el.className='tactical good';
}
