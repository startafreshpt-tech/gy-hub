// ============================================================================
// sync-milestones-background  (Netlify background function, up to 15 min)
// Rebuilds the Trainerize Milestones DATA object live and stores it in Supabase
// (invoices table, source='milestones-snapshot'). Weekly via sync-cron.
// Secrets from Netlify env: TRAINERIZE_GROUP_ID, TRAINERIZE_API_TOKEN,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
const GROUP_ID = process.env.TRAINERIZE_GROUP_ID;
const TOKEN    = process.env.TRAINERIZE_API_TOKEN;
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE='https://api.trainerize.com/v03';
const AUTH='Basic '+Buffer.from(`${GROUP_ID}:${TOKEN}`).toString('base64');
const POOL=6, LB2KG=0.45359237, WIN=45;
const TODAY=new Date(); TODAY.setHours(0,0,0,0);
const iso=d=>d.toISOString().slice(0,10);
const today=iso(TODAY);
const monthStart=iso(new Date(TODAY.getFullYear(),TODAY.getMonth(),1));
const jan1=`${TODAY.getFullYear()}-01-01`;
const curMonth=today.slice(0,7);
const daysAgo=n=>{const d=new Date(TODAY);d.setDate(d.getDate()-n);return iso(d);};
const d30=daysAgo(30);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body,retries=3){
  for(let a=0;a<=retries;a++){
    try{
      const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),12000);
      const r=await fetch(`${BASE}${path}`,{method:'POST',headers:{Authorization:AUTH,'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctl.signal});
      clearTimeout(to);
      const txt=await r.text(); let j; try{j=JSON.parse(txt)}catch{j=null}
      if(j&&r.status<500&&r.status!==429)return j;   // 429 = rate limited -> retry
      if(a===retries)return j||{_http:r.status};
      await sleep((r.status===429?1500:500)*(a+1));
      continue;
    }catch(e){if(a===retries)return{_err:String(e)};}
    await sleep(500*(a+1));
  }
}
async function pool(items,worker,n=POOL){const out=new Array(items.length);let i=0;
  await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const idx=i++;out[idx]=await worker(items[idx],idx);}}));return out;}
const parseD=s=>{const t=Date.parse((s||'').slice(0,10));return Number.isNaN(t)?null:new Date(t);};
function chunks(startISO,endISO,maxDays=360){const out=[];let s=new Date(startISO);const end=new Date(endISO);
  while(s<=end){const e=new Date(s);e.setDate(e.getDate()+maxDays);if(e>end)e.setTime(end.getTime());out.push([iso(s),iso(e)]);s=new Date(e);s.setDate(s.getDate()+1);}return out;}
async function bodystat(uid,date){const r=await api('/bodystats/get',{userID:uid,date,unitBodystats:'cm',unitWeight:'lbs'});
  if(r&&r.code===200){const bm=r.bodyMeasures||{};return{bw_lb:bm.bodyWeight??null,bf:bm.bodyFatPercent??null,waist:bm.waist??null,date:(r.date||'').slice(0,10)};}return null;}
const round1=x=>x==null?null:Math.round(x*10)/10;
const num=x=>{const n=Number(x);return Number.isFinite(n)?n:null;};
const WT=new Set(['oneRepMax','threeRepMax','fiveRepMax','tenRepMax','maxWeight','maxLoad']);
function extractAccomplishments(stats){let pr=0,mil=0,habit_cnt=0,habit_tot=0,max_streak=0,rdg=false;const names=new Set();const srecs=[];
  for(const s of(stats||[])){const cat=s.category,type=s.type,dd=s.data||{};
    if(cat==='workoutBrokenRecord'){pr++;if(WT.has(type)&&dd.unit==='kg')srecs.push({ex:dd.exerciseName,type,val:dd.data,chg:dd.dataChange,date:(s.itemDate||'').slice(0,10)});}
    else if(cat==='workoutMilestone')mil++;
    else if(cat==='goalHabit'&&type==='habit'){habit_cnt++;habit_tot+=(s.total||0);max_streak=Math.max(max_streak,dd.streak||0);const nm=(dd.name||'').trim();names.add(nm);if(/read/i.test(nm)&&/goal/i.test(nm))rdg=true;}}
  return{pr,mil,srecs,habit:{habit_cnt,habit_tot,max_streak,n_habits:names.size,read_daily_goals:rdg}};}
async function getActive(){const all=[];for(let start=0;;start+=200){const d=await api('/user/getList',{start,count:200});const u=(d&&d.users)||[];all.push(...u);if(u.length<200)break;}return all;}
async function processActive(m){const uid=m.id;const created=parseD(m.created)||new Date('2016-01-01');
  const start=iso(created<new Date('2015-01-01')?new Date('2015-01-01'):created);
  const wDates=[],cDates=[],bDates=[];
  for(const[cs,ce]of chunks(start,today)){const d=await api('/calendar/getList',{userID:uid,startDate:cs,endDate:ce});
    for(const day of(d&&d.calendar)||[])for(const it of day.items||[]){if(it.type==='workoutRegular'&&it.status==='tracked')wDates.push(day.date);else if(it.type==='cardio'&&it.status==='tracked')cDates.push(day.date);else if(it.type==='bodyStat')bDates.push(day.date);}}
  const cntSince=(arr,c)=>arr.filter(x=>x>=c).length;
  const bs=[...new Set(bDates.filter(parseD))].sort();
  let bw_now=null,bf_now=null,bw_prev=null,dt_now=null,dt_prev=null,waist_now=null,waist_first=null;
  if(bs.length){dt_now=bs[bs.length-1];const last=await bodystat(uid,dt_now);if(last){bw_now=last.bw_lb;bf_now=last.bf;waist_now=last.waist;}
    const target=iso(new Date(parseD(dt_now).getTime()-28*864e5));const prior=bs.filter(x=>x<=target);const cand=prior.length?prior[prior.length-1]:(bs.length>1?bs[0]:null);
    if(cand&&cand!==dt_now){dt_prev=cand;const p=await bodystat(uid,dt_prev);if(p)bw_prev=p.bw_lb;}}
  let wt_loss=null,age=null;
  if(bw_now!=null&&bw_prev!=null&&dt_now&&dt_prev){wt_loss=round1((bw_prev-bw_now)*LB2KG);age=Math.round((TODAY-parseD(dt_now))/864e5);}
  let first_bw=null,first_date=null;
  if(bs.length){first_date=bs[0];if(first_date!==dt_now){const f=await bodystat(uid,first_date);if(f){first_bw=f.bw_lb;waist_first=f.waist;}}}
  async function baseline(cut){const pre=bs.filter(x=>x<cut);const post=bs.filter(x=>x>=cut&&x<dt_now);const base=pre.length?pre[pre.length-1]:(post.length?post[0]:null);if(!base)return null;const b=await bodystat(uid,base);return b?b.bw_lb:null;}
  let ytd=null,mtd=null;
  if(dt_now&&bw_now!=null){if(dt_now>=jan1){const b=await baseline(jan1);if(b!=null)ytd=round1((b-bw_now)*LB2KG);}if(dt_now>=monthStart){const b=await baseline(monthStart);if(b!=null)mtd=round1((b-bw_now)*LB2KG);}}
  const acc=await api('/accomplishment/getStatsList',{userID:uid,start:0,count:150});const ex=extractAccomplishments(acc&&acc.stats);const yA=parseD(m.created);
  return{id:uid,name:m.name,created:(m.created||'').slice(0,10),status:'active',lifetime:wDates.length,activities:cDates.length,combined:wDates.length+cDates.length,
    month:cntSince(wDates,monthStart),d30:cntSince(wDates,d30),act_month:cntSince(cDates,monthStart),act_30d:cntSince(cDates,d30),
    last_workout:wDates.length?wDates.sort().slice(-1)[0]:null,pr:ex.pr,mil:ex.mil,wt_loss_kg:wt_loss,measure_age:age,bf_now:num(bf_now),
    tenure_years:yA?Math.round((TODAY-yA)/864e5/365.25*10)/10:null,ytd_loss:ytd,mtd_loss:mtd,
    bw_now_lb:bw_now,bw_prev_lb:bw_prev,bs_date_now:dt_now,bs_date_prev:dt_prev,first_bw_lb:first_bw,first_date,
    waist_now:num(waist_now),waist_first:num(waist_first),_srecs:ex.srecs,_habit:ex.habit};}
async function getDeactivated(){const all=[];for(const start of[0,1000]){const d=await api('/user/getClientList',{view:'deactivatedClient',start,count:1000,verbose:true});for(const u of(d&&d.users)||[])all.push(u);}const seen=new Map();for(const u of all)seen.set(u.id,u);return[...seen.values()];}
async function processDeactivated(m){const uid=m.id;const name=`${m.firstName||''} ${m.lastName||''}`.trim();const last=await bodystat(uid,'last');
  if(!last||last.bw_lb==null)return{id:uid,name,data:false};
  let firstDate=null;for(const[cs,ce]of chunks('2015-01-01',last.date)){const d=await api('/calendar/getList',{userID:uid,startDate:cs,endDate:ce});const ds=[];for(const day of(d&&d.calendar)||[])for(const it of day.items||[])if(it.type==='bodyStat')ds.push(day.date);if(ds.length){firstDate=ds.sort()[0];break;}}
  if(!firstDate||firstDate===last.date)return{id:uid,name,data:true,last_kg:round1(last.bw_lb*LB2KG)};
  const f=await bodystat(uid,firstDate);if(!f||f.bw_lb==null)return{id:uid,name,data:true,last_kg:round1(last.bw_lb*LB2KG)};
  const acc=await api('/accomplishment/getStatsList',{userID:uid,start:0,count:150});const habit=extractAccomplishments(acc&&acc.stats).habit;
  return{id:uid,name,data:true,first_kg:round1(f.bw_lb*LB2KG),last_kg:round1(last.bw_lb*LB2KG),loss_kg:round1((f.bw_lb-last.bw_lb)*LB2KG),first:firstDate,last:last.date,_habit:habit};}
const saneWt=(f,l,loss)=>f!=null&&l!=null&&f>=35&&f<=250&&l>=35&&l<=250&&loss>0&&loss<=50;
function pearson(xs,ys){const n=xs.length;if(n<3)return null;const mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;let nu=0,dx=0,dy=0;for(let i=0;i<n;i++){nu+=(xs[i]-mx)*(ys[i]-my);dx+=(xs[i]-mx)**2;dy+=(ys[i]-my)**2;}const den=Math.sqrt(dx*dy);return den?Math.round(nu/den*100)/100:null;}
async function loadMembershipMap(){
  // Pull membership (plan + embedded price) per member from the clients table,
  // which the GymMaster sync populates earlier in the same weekly run. Returns
  // two lookups: exact full-name, and a first+last-initial fallback key.
  const map={exact:new Map(),key:new Map()};
  if(!SB_URL||!SB_KEY) return map;
  try{
    const H={apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`};
    const r=await fetch(`${SB_URL}/rest/v1/clients?select=full_name,membership&limit=2000`,{headers:H});
    const rows=await r.json();
    const mk=n=>{const p=String(n||'').trim().split(/\s+/).filter(Boolean);return p.length>=2?`${p[0].toLowerCase()}|${p[p.length-1][0].toUpperCase()}`:null;};
    for(const c of (Array.isArray(rows)?rows:[])){
      const nm=(c.full_name||'').trim(); const ms=c.membership||null;
      if(!nm||!ms) continue;
      map.exact.set(nm.toLowerCase(),ms);
      const k=mk(nm); if(k&&!map.key.has(k)) map.key.set(k,ms);
    }
  }catch(e){/* leave map empty -> cards show no plan, no crash */}
  return map;
}
function lookupMembership(name,map){
  const nm=String(name||'').trim(); if(!nm) return null;
  if(map.exact.has(nm.toLowerCase())) return map.exact.get(nm.toLowerCase());
  const p=nm.split(/\s+/).filter(Boolean);
  if(p.length>=2){const k=`${p[0].toLowerCase()}|${p[p.length-1][0].toUpperCase()}`;if(map.key.has(k))return map.key.get(k);}
  return null;
}
async function buildDATA(){
  const membershipMap=await loadMembershipMap();
  const activeRaw=await getActive();const active=await pool(activeRaw,processActive);
  // Authoritative lifetime/activity totals in a SEPARATE low-concurrency pass.
  // getClientSummary is reliable alone but Trainerize rate-limits (429) when it's
  // mixed into the heavy per-member pool — which had emptied the 1000 Club.
  await pool(active, async(a)=>{
    const summ=await api('/user/getClientSummary',{userID:a.id,unitWeight:'kg'});
    const sR=(summ&&summ.Response)||(summ&&summ.result)||summ||{};
    if(Number.isFinite(sR.workoutsTotal)) a.lifetime=Math.max(a.lifetime||0, sR.workoutsTotal);
    if(Number.isFinite(sR.cardioTotal)) a.activities=Math.max(a.activities||0, sR.cardioTotal);
    a.combined=(a.lifetime||0)+(a.activities||0);
    // Body weight from the app feed. The calendar only logs in-studio weigh-ins, so
    // app self-trackers (e.g. Mark Bavister) were missed entirely. getClientSummary
    // returns only a recent window, so we walk BACK month-by-month with /bodystats/get
    // (unitBodystats is REQUIRED or it 406s) to find the true starting weight.
    // Only REAL measurements: exclude projected values and implausible weights (35-250kg).
    const realW=w=>Number.isFinite(w)&&w>=35&&w<=250;
    const bsA=(sR.bodystats||[]).filter(x=>x&&!x.isProjected&&realW(Number(x.weight)));
    if(bsA.length){
      const KG2LB=1/LB2KG, U={unitBodystats:'cm',unitWeight:'kg'};
      const curW=Number(bsA[bsA.length-1].weight), curD=(bsA[bsA.length-1].date||'').slice(0,10);
      let firstW=Number(bsA[0].weight), firstD=(bsA[0].date||'').slice(0,10);
      const base=new Date(firstD); let empty=0;
      for(let mo=1; mo<=18 && empty<2; mo++){
        const d=new Date(base.getFullYear(), base.getMonth()-mo, 1);
        const ds=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
        const r=await api('/bodystats/get',{userID:a.id,date:ds,...U});
        const w=r&&r.code===200&&r.bodyMeasures?Number(r.bodyMeasures.bodyWeight):null;
        if(realW(w)){ firstW=w; firstD=ds; empty=0; } else empty++;
      }
      // App-based loss (walk-back). Compare to any existing calendar-based loss and
      // keep whichever is LARGER and sane — never REDUCE a good in-studio number.
      const appLoss = (firstD!==curD && realW(firstW) && realW(curW)) ? round1(firstW-curW) : null;
      const calLoss = (a.first_bw_lb!=null && a.bw_now_lb!=null && a.first_date && a.bs_date_now && a.first_date!==a.bs_date_now)
        ? round1((a.first_bw_lb-a.bw_now_lb)*LB2KG) : null;
      if(appLoss!=null && appLoss>0 && (calLoss==null || appLoss>calLoss)){
        a.first_bw_lb=firstW*KG2LB; a.bw_now_lb=curW*KG2LB;
        a.first_date=firstD; a.bs_date_now=curD;
        a.wt_loss_kg=appLoss; a.measure_age=0;
      }
    }
    // Sanity: clear any bogus weight figures (e.g. projected-only or near-zero calendar reads).
    { const lo=35/LB2KG, hi=250/LB2KG;
      const bad=x=>x!=null&&(x<lo||x>hi);
      if(bad(a.first_bw_lb)||bad(a.bw_now_lb)){ a.first_bw_lb=null; a.bw_now_lb=null; a.wt_loss_kg=null; }
      if(a.first_bw_lb!=null&&a.bw_now_lb!=null){ const ch=Math.abs((a.first_bw_lb-a.bw_now_lb)*LB2KG); if(ch>60){ a.first_bw_lb=null; a.bw_now_lb=null; a.wt_loss_kg=null; } }
    }
  }, 5);
  const deactRaw=await getDeactivated();const deact=await pool(deactRaw,processDeactivated);
  const members=active.map(a=>{let alltime=null;if(a.first_bw_lb!=null&&a.bw_now_lb!=null&&a.first_date&&a.first_date!==a.bs_date_now)alltime=round1((a.first_bw_lb-a.bw_now_lb)*LB2KG);
    return{id:a.id,name:a.name,created:a.created,lifetime:a.lifetime,activities:a.activities,combined:a.combined,month:a.month,d30:a.d30,act_month:a.act_month,act_30d:a.act_30d,last_workout:a.last_workout,pr:a.pr,mil:a.mil,wt_loss_kg:a.wt_loss_kg,measure_age:a.measure_age,bf_now:a.bf_now,tenure_years:a.tenure_years,ytd_loss:a.ytd_loss,mtd_loss:a.mtd_loss,alltime_loss_kg:alltime,plan:lookupMembership(a.name,membershipMap),price:lookupMembership(a.name,membershipMap),gm_status:null};});
  const allLoss=[];for(const a of active){if(a.first_bw_lb!=null&&a.bw_now_lb!=null&&a.first_date&&a.first_date!==a.bs_date_now){const kg=round1((a.first_bw_lb-a.bw_now_lb)*LB2KG);allLoss.push({name:a.name,kg,first:round1(a.first_bw_lb*LB2KG),last:round1(a.bw_now_lb*LB2KG)});}}
  const losers=allLoss.filter(r=>saneWt(r.first,r.last,r.kg));
  const waist=[];for(const a of active){if(a.waist_first!=null&&a.waist_now!=null&&a.waist_first>0&&a.waist_now>0)waist.push(round1(a.waist_first-a.waist_now));}const waist_lo=waist.filter(w=>w>0);
  const win=members.filter(m=>m.wt_loss_kg!=null&&m.measure_age!=null&&m.measure_age<=WIN);
  const order=[];const bc={};const bnames={};
  for(let mo=0;mo<12;mo++){const lab=`${mo}-${mo+1} mo`;order.push(lab);bc[lab]=0;bnames[lab]=[];}
  const maxY=Math.max(1,...members.filter(m=>m.tenure_years!=null).map(m=>m.tenure_years));
  for(let yr=1;yr<=Math.ceil(maxY);yr++){const lab=`${yr}-${yr+1} yr`;order.push(lab);bc[lab]=0;bnames[lab]=[];}
  for(const m of members){const d=parseD(m.created);if(!d)continue;const mo=(TODAY-d)/864e5/30.4375;const lab=mo<12?`${Math.min(Math.floor(mo),11)}-${Math.min(Math.floor(mo),11)+1} mo`:`${Math.floor(mo/12)}-${Math.floor(mo/12)+1} yr`;if(lab in bc){bc[lab]++;bnames[lab].push({name:m.name,plan:m.plan,price:m.price});}}
  const tenure_buckets=order.map(l=>({label:l,n:bc[l],names:bnames[l].sort((a,b)=>a.name.localeCompare(b.name))}));
  const agg=key=>{const v=members.map(m=>m[key]).filter(x=>x!=null);const lo=v.filter(x=>x>0);return[Math.round(lo.reduce((a,b)=>a+b,0)),lo.length,v.length];};
  const[yl,yn,ytn]=agg('ytd_loss');const[mlk,mn,mtn]=agg('mtd_loss');
  const MACHINE=/machine|cable|smith|plate|tutorial|plank|wall sit|bosu|balance|assisted|stack|lat pull|leg press|leg extension|pec|pulldown|rower|raise|mountain climber|pull up|push up/i;
  const FREE=/barbell|dumbbell|\bdb\b|kettlebell|goblet|squat|deadlift|bench press|romanian|hip thrust|thrust|lunge|\brow\b|curl|sumo|trap bar/i;
  const TLAB={oneRepMax:'1RM',threeRepMax:'3RM',fiveRepMax:'5RM',tenRepMax:'10RM',maxWeight:'Max weight',maxLoad:'Volume PR'};
  const clean=e=>(e||'').replace('Gavyn Berntsen','').replace('GY','').replace(/\s+/g,' ').trim();
  const free=r=>FREE.test(r.exc||'')&&!MACHINE.test(r.exc||'');
  const srecs=[];for(const a of active)for(const r of a._srecs||[])if(r.val!=null)srecs.push({...r,name:a.name,exc:clean(r.ex)});
  const period=recs=>{const pm={},bd={};for(const r of recs){pm[r.name]=(pm[r.name]||0)+1;bd[r.type]=(bd[r.type]||0)+1;}
    const heavy=recs.filter(r=>r.type==='maxWeight'&&free(r)&&r.val>0&&r.val<=80).sort((a,b)=>b.val-a.val).slice(0,8);
    const imp=recs.filter(r=>r.type==='maxWeight'&&free(r)&&r.chg>0&&r.chg<=25&&r.val>0&&r.val<=80).sort((a,b)=>b.chg-a.chg).slice(0,8);
    return{total:recs.length,setters:Object.entries(pm).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,prs])=>({name,prs})),heavy:heavy.map(r=>({name:r.name,ex:r.exc,val:r.val})),imp:imp.map(r=>({name:r.name,ex:r.exc,val:r.val,chg:r.chg})),breakdown:['maxWeight','maxLoad','tenRepMax','fiveRepMax','threeRepMax','oneRepMax'].filter(t=>bd[t]).map(t=>({lab:TLAB[t],n:bd[t]}))};};
  const monthRecs=srecs.filter(r=>(r.date||'').startsWith(curMonth));
  const dPairs=deact.filter(v=>v.loss_kg!=null);const dLosers=dPairs.filter(v=>saneWt(v.first_kg,v.last_kg,v.loss_kg)&&v.loss_kg>0);
  const dLost=Math.round(dLosers.reduce((a,b)=>a+b.loss_kg,0));const aLost=Math.round(losers.reduce((a,b)=>a+b.kg,0));
  const bizLost=aLost+dLost,bizLosers=losers.length+dLosers.length;
  const deactTop=[...dLosers].sort((a,b)=>b.loss_kg-a.loss_kg).slice(0,10).map(r=>({name:r.name,kg:r.loss_kg,from:r.first_kg,to:r.last_kg}));
  const lossById={};for(const m of members)if(m.alltime_loss_kg!=null&&m.alltime_loss_kg>0)lossById[String(m.id)]=m.alltime_loss_kg;
  for(const v of deact)if(v.loss_kg!=null&&v.loss_kg>0&&saneWt(v.first_kg,v.last_kg,v.loss_kg))lossById[String(v.id)]=v.loss_kg;
  const hr=[];for(const a of active)if(a._habit)hr.push({eng:a._habit.habit_tot,cnt:a._habit.habit_cnt,act:true,loss:lossById[String(a.id)]??null});
  for(const v of deact)if(v._habit)hr.push({eng:v._habit.habit_tot,cnt:v._habit.habit_cnt,act:false,loss:lossById[String(v.id)]??null});
  const tierOf=r=>r.cnt===0?'0|None':r.eng<=3?'1|Low':r.eng<=8?'2|Medium':'3|High';const tg={};for(const r of hr){(tg[tierOf(r)]=tg[tierOf(r)]||[]).push(r);}
  const tiers=Object.keys(tg).sort().map(t=>{const g=tg[t];const lg=g.map(r=>r.loss).filter(x=>x!=null);return{label:t.split('|')[1],n:g.length,active_pct:Math.round(100*g.filter(r=>r.act).length/g.length),avg_loss:lg.length?Math.round(lg.reduce((a,b)=>a+b,0)/lg.length*10)/10:null,loss_n:lg.length};});
  const pl=hr.filter(r=>r.loss!=null);
  const habit={tiers,r_loss:pearson(pl.map(r=>r.eng),pl.map(r=>r.loss)),n_loss:pl.length,uses_pct:hr.length?Math.round(100*hr.filter(r=>r.cnt>0).length/hr.length):0,total:hr.length,scatter:pl.map(r=>({x:Math.min(r.eng,40),y:r.loss,a:r.act}))};
  const sum=arr=>arr.reduce((a,b)=>a+b,0);
  const summary={generated:today,total_members:members.length,active_this_month:members.filter(m=>m.month>0).length,act_active_this_month:members.filter(m=>m.act_month>0).length,
    workouts_month:sum(members.map(m=>m.month)),workouts_month_target:600,workouts_30d:sum(members.map(m=>m.d30)),workouts_alltime:sum(members.map(m=>m.lifetime)),
    activities_month:sum(members.map(m=>m.act_month)),activities_30d:sum(members.map(m=>m.act_30d)),activities_alltime:sum(members.map(m=>m.activities)),
    total_pr:sum(members.map(m=>m.pr)),total_mil:sum(members.map(m=>m.mil)),bodyfat_target:700,window_days:WIN,
    wt_net_kg:Math.round(sum(win.map(m=>m.wt_loss_kg))*10)/10,wt_lossonly_kg:Math.round(sum(win.filter(m=>m.wt_loss_kg>0).map(m=>m.wt_loss_kg))*10)/10,wt_window_members:win.length,
    bf_net_kg:0.0,bf_logging_members:members.filter(m=>m.bf_now!=null).length,
    at_lost_kg:aLost,at_losers:losers.length,at_avg:Math.round(aLost/Math.max(1,losers.length)*10)/10,at_pair_members:allLoss.length,at_top:[...losers].sort((a,b)=>b.kg-a.kg).slice(0,10).map(r=>({name:r.name,kg:r.kg})),
    biz_lost:bizLost,biz_losers:bizLosers,biz_people:bizLosers,biz_avg:bizLosers?Math.round(bizLost/bizLosers*10)/10:null,
    deact_lost:dLost,deact_losers:dLosers.length,deact_top:deactTop,
    waist_lost_cm:Math.round(sum(waist_lo)),waist_losers:waist_lo.length,waist_pairs:waist.length,
    tenure_buckets,longest_members:[],ytd_lost_kg:yl,ytd_losers:yn,ytd_measured:ytn,mtd_lost_kg:mlk,mtd_losers:mn,mtd_measured:mtn,
    str:{ever:period(srecs),month:period(monthRecs)},str_weighted:srecs.length,habit};
  const leaderboard=[...members].sort((a,b)=>b.lifetime-a.lifetime);
  const clubs={club1000:members.filter(m=>m.lifetime>=1000).sort((a,b)=>b.lifetime-a.lifetime),club400:members.filter(m=>m.lifetime>=400&&m.lifetime<1000).sort((a,b)=>b.lifetime-a.lifetime),near1000:members.filter(m=>m.lifetime>=800&&m.lifetime<1000).sort((a,b)=>b.lifetime-a.lifetime),near400:members.filter(m=>m.lifetime>=300&&m.lifetime<400).sort((a,b)=>b.lifetime-a.lifetime)};
  return{summary,members,leaderboard,clubs};
}
async function sbWrite(dataStr){
  const H={apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json'};
  await fetch(`${SB_URL}/rest/v1/invoices?source=eq.milestones-snapshot`,{method:'DELETE',headers:{...H,Prefer:'return=minimal'}});
  await fetch(`${SB_URL}/rest/v1/invoices`,{method:'POST',headers:{...H,Prefer:'return=minimal'},body:JSON.stringify({trainer_name:'__milestones__',period_start:today,period_end:today,source:'milestones-snapshot',status:'data',raw_text:dataStr,created_by:'weekly-sync'})});
}
export default async()=>{
  if(!GROUP_ID||!TOKEN||!SB_URL||!SB_KEY) return new Response(JSON.stringify({ok:false,error:'missing env'}),{status:500});
  try{ const DATA=await buildDATA(); await sbWrite(JSON.stringify(DATA));
    try{ const today2=new Date().toISOString().slice(0,10); const H={apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Content-Type':'application/json'}; await fetch(`${SB_URL}/rest/v1/invoices?source=eq.debug-milestones`,{method:'DELETE',headers:{...H,Prefer:'return=minimal'}}); await fetch(`${SB_URL}/rest/v1/invoices`,{method:'POST',headers:{...H,Prefer:'return=minimal'},body:JSON.stringify({trainer_name:'__debug-milestones__',period_start:today2,period_end:today2,source:'debug-milestones',status:'data',raw_text:JSON.stringify(globalThis.__dbgSumm||{none:true}),created_by:'debug'})}); }catch(e){}
    return new Response(JSON.stringify({ok:true,members:DATA.members.length,generated:DATA.summary.generated}),{headers:{'content-type':'application/json'}});
  }catch(e){ return new Response(JSON.stringify({ok:false,error:String(e)}),{status:500}); }
};
