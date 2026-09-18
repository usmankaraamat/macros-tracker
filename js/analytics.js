// analytics.js -- Small first-party usage counts and voluntary feedback.
// No meal names, nutrition values, API keys, or free-form app data are sent.

const PRODUCT_ANALYTICS_KEY = 'eatify.analytics.enabled';
const PRODUCT_INSTALL_KEY = 'eatify.analytics.installId';
const PRODUCT_PING_KEY = 'eatify.analytics.lastPing';
const PRODUCT_ACTIVATED_KEY = 'eatify.analytics.activatedDay';

function productAnalyticsEnabled(){
  try { return localStorage.getItem(PRODUCT_ANALYTICS_KEY) !== 'false'; } catch(e){ return true; }
}
function setProductAnalyticsEnabled(enabled){
  try { localStorage.setItem(PRODUCT_ANALYTICS_KEY, enabled ? 'true' : 'false'); } catch(e){}
}
function productInstallId(){
  try {
    let id = localStorage.getItem(PRODUCT_INSTALL_KEY);
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) {
      id = crypto.randomUUID();
      localStorage.setItem(PRODUCT_INSTALL_KEY, id);
    }
    return id;
  } catch(e){ return crypto.randomUUID(); }
}
function productDay(){ return new Date().toISOString().slice(0,10); }
function productActivated(){
  try {
    for (let i=0; i<localStorage.length; i++){
      const key=localStorage.key(i);
      if (!/^ledger_\d{4}-\d{2}-\d{2}$/.test(key || '')) continue;
      const rows=JSON.parse(localStorage.getItem(key)||'[]');
      if (Array.isArray(rows) && rows.length) return true;
    }
  } catch(e){}
  return false;
}
async function productRequest(body){
  const session = supaUrl() === SUPA_DEFAULT_URL ? await hostedSession().catch(()=>null) : null;
  const token = session?.access_token || SUPA_DEFAULT_KEY;
  const response = await fetch(SUPA_DEFAULT_URL + '/functions/v1/product-data', {
    method:'POST',
    headers:{apikey:SUPA_DEFAULT_KEY, Authorization:'Bearer '+token, 'Content-Type':'application/json'},
    body:JSON.stringify({...body, app:'eatify', installId:productInstallId()})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error || 'Could not reach Eatify.');
  return data;
}
async function productHeartbeat({force=false}={}){
  if(!productAnalyticsEnabled() || !navigator.onLine) return {skipped:true};
  const day=productDay();
  try {
    if(!force && localStorage.getItem(PRODUCT_PING_KEY)===day) return {skipped:true};
    const activated=productActivated();
    const data=await productRequest({
      kind:'activity',
      activated,
      usesByok:hasPersonalUSDA() || hasPersonalAI(),
      usesHosted:hostedAccountConfigured()
    });
    localStorage.setItem(PRODUCT_PING_KEY,day);
    if(activated) localStorage.setItem(PRODUCT_ACTIVATED_KEY,day);
    return data;
  } catch(e){ return {error:e}; }
}
function noteProductUse(){
  if(!productAnalyticsEnabled()) return;
  const day=productDay();
  try { if(localStorage.getItem(PRODUCT_ACTIVATED_KEY)===day) return; } catch(e){}
  productHeartbeat({force:true});
}
async function submitProductFeedback({message,rating,replyEmail}){
  return productRequest({kind:'feedback', message, rating, replyEmail});
}
window.addEventListener('online',()=>productHeartbeat());
setTimeout(()=>productHeartbeat(),1200);
