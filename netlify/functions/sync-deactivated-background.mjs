// ============================================================================
// sync-deactivated-background
// Builds the set of clients DEACTIVATED in Trainerize (so the Follow-Up page
// can drop them). Excludes anyone who also has an ACTIVE Trainerize account
// (duplicate accounts) so currently-coached members are never removed.
// Writes Supabase invoices blob source='tz-deactivated' { emails:[...] }.
// Env: TRAINERIZE_GROUP_ID, TRAINERIZE_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
const GROUP_ID = process.env.TRAINERIZE_GROUP_ID;
const TOKEN    = process.env.TRAINERIZE_API_TOKEN;
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE='https://api.trainerize.com/v03';
const AUTH='Basic '+Buffer.from(`${GROUP_ID}:${TOKEN}`).toString('base64');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body,retries=3){
  for(let a=0;a<=retries;a++){
    try{
      const r=await fetch(`${BASE}${path}`,{method:'POST',headers:{Authorization:AUTH,'Content-Type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json().catch(()=>null);
      if(j&&r.status<500&&r.status!==429)return j;
      if(a===retries)return j||{};
      await sleep((r.status===429?1500:500)*(a+1));
    }catch(e){if(a===retries)return{};}
  }
}
const emailsFrom=arr=>(arr||[]).map(u=>String(u.email||'').toLowerCase().trim()).filter(e=>e.includes('@'));
// A failed page used to yield [] and break the loop early, silently truncating the
// list -- which would misclassify active clients as deactivated. Abort instead:
// leaving last week's data in place is far safer than publishing a partial list.
async function getActiveEmails(){const all=[];for(let start=0;;start+=200){const d=await api('/user/getList',{start,count:200});
  if(!d||!Array.isArray(d.users)) throw new Error(`getList failed at start=${start} — aborting rather than publishing a truncated active list`);
  const u=d.users;all.push(...u);if(u.length<200)break;}return new Set(emailsFrom(all));}
async function getDeactivatedEmails(){const all=[];for(const start of[0,1000,2000,3000]){const d=await api('/user/getClientList',{view:'deactivatedClient',start,count:1000,verbose:true});
  if(!d||!Array.isArray(d.users)) throw new Error(`getClientList failed at start=${start} — aborting rather than publishing a truncated deactivated list`);
  const u=d.users;all.push(...u);if(u.length<1000)break;}return emailsFrom(all);}
async function sbWriteBlob(source,dataStr){
  const H={apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json'};
  const today=new Date().toISOString().slice(0,10);
  await fetch(`${SB_URL}/rest/v1/invoices?source=eq.${source}`,{method:'DELETE',headers:{...H,Prefer:'return=minimal'}});
  await fetch(`${SB_URL}/rest/v1/invoices`,{method:'POST',headers:{...H,Prefer:'return=minimal'},body:JSON.stringify({trainer_name:'__'+source+'__',period_start:today,period_end:today,source,status:'data',raw_text:dataStr,created_by:'weekly-sync'})});
}
export default async()=>{
  if(!GROUP_ID||!TOKEN||!SB_URL||!SB_KEY) return new Response(JSON.stringify({ok:false,error:'missing env'}),{status:500});
  try{
    const active=await getActiveEmails();
    const deact=await getDeactivatedEmails();
    const exclude=[...new Set(deact.filter(e=>!active.has(e)))];
    await sbWriteBlob('tz-deactivated',JSON.stringify({updated:new Date().toISOString(),emails:exclude}));
    return new Response(JSON.stringify({ok:true,active:active.size,deactivated:deact.length,excluded:exclude.length}),{headers:{'content-type':'application/json'}});
  }catch(e){return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500});}
};
