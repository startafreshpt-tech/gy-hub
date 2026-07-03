const LB2KG=0.45359237, round1=x=>x==null?null:Math.round(x*10)/10, KG2LB=1/LB2KG;
const realW=w=>Number.isFinite(w)&&w>=35&&w<=250;
// Exact replica of the sync's decision: given app bodystats + walkback + existing calendar, produce final wt_loss_kg (or null)
function decide({bodystats=[], walkbackFirst=null, cal=null}){
  let a = cal ? {first_bw_lb:cal.first*KG2LB, bw_now_lb:cal.now*KG2LB, first_date:cal.fd, bs_date_now:cal.nd, wt_loss_kg:round1(cal.first-cal.now)} : {first_bw_lb:null,bw_now_lb:null,first_date:null,bs_date_now:null,wt_loss_kg:null};
  const bsA=bodystats.filter(x=>x&&!x.isProjected&&realW(Number(x.weight)));
  if(bsA.length){
    const curW=Number(bsA[bsA.length-1].weight), curD=bsA[bsA.length-1].date;
    let firstW=Number(bsA[0].weight), firstD=bsA[0].date;
    if(walkbackFirst && realW(walkbackFirst.w)){ firstW=walkbackFirst.w; firstD=walkbackFirst.date; }
    const appLoss=(firstD!==curD && realW(firstW) && realW(curW))?round1(firstW-curW):null;
    const calLoss=(a.first_bw_lb!=null&&a.bw_now_lb!=null&&a.first_date&&a.bs_date_now&&a.first_date!==a.bs_date_now)?round1((a.first_bw_lb-a.bw_now_lb)*LB2KG):null;
    if(appLoss!=null&&appLoss>0&&(calLoss==null||appLoss>calLoss)){ a.first_bw_lb=firstW*KG2LB;a.bw_now_lb=curW*KG2LB;a.first_date=firstD;a.bs_date_now=curD;a.wt_loss_kg=appLoss; }
  }
  const lo=35/LB2KG,hi=250/LB2KG,bad=x=>x!=null&&(x<lo||x>hi);
  if(bad(a.first_bw_lb)||bad(a.bw_now_lb)){a.first_bw_lb=null;a.bw_now_lb=null;a.wt_loss_kg=null;}
  if(a.first_bw_lb!=null&&a.bw_now_lb!=null){const ch=Math.abs((a.first_bw_lb-a.bw_now_lb)*LB2KG);if(ch>60){a.first_bw_lb=null;a.bw_now_lb=null;a.wt_loss_kg=null;}}
  // members.map alltime uses first_bw_lb/bw_now_lb the same way:
  const alltime=(a.first_bw_lb!=null&&a.bw_now_lb!=null&&a.first_date&&a.first_date!==a.bs_date_now)?round1((a.first_bw_lb-a.bw_now_lb)*LB2KG):null;
  return alltime;
}
const T=(name,got,exp)=>console.log((got===exp?'PASS':'*** FAIL')+' | '+name+' => '+got+' (expected '+exp+')');

// LEISA: projected-only app + garbage near-zero calendar first
T('Leisa: projected-only + garbage calendar (was +117)', decide({bodystats:[{date:'2026-05-11',weight:117.4,isProjected:true}], cal:{first:0.2,now:117.4,fd:'2024-09-26',nd:'2026-05-11'}}), null);
// near-zero first weight
T('near-zero first (garbage)', decide({bodystats:[{date:'2026-01-01',weight:0.5},{date:'2026-06-01',weight:70}]}), null);
// huge 180kg change
T('impossible 180kg change', decide({bodystats:[{date:'2026-01-01',weight:250},{date:'2026-06-01',weight:70}]}), null);
// single measurement
T('single measurement only', decide({bodystats:[{date:'2026-05-11',weight:80}]}), null);
// a GAIN (should not show as a loss)
T('weight gain (first<now)', decide({bodystats:[{date:'2026-01-01',weight:70},{date:'2026-06-01',weight:78}]}), null);
// borderline 60kg change -> allowed, >60 -> null
T('exactly 61kg change -> null', decide({bodystats:[{date:'2026-01-01',weight:150},{date:'2026-06-01',weight:89}]}), null);
T('55kg change -> allowed', decide({bodystats:[{date:'2026-01-01',weight:150},{date:'2026-06-01',weight:95}]}), 55);
// NON-REGRESSION: calendar 22.2 + tiny app loss -> keep 22.2
T('calendar 22.2 vs app 1.4 -> keep 22.2', decide({bodystats:[{date:'2026-05-12',weight:72.3},{date:'2026-06-25',weight:70.9}], cal:{first:94.5,now:72.3,fd:'2024-01-01',nd:'2026-06-25'}}), 22.2);
// RHONDA improvement: calendar 6.1 + app walkback 10.3 -> use 10.3
T('Rhonda: calendar 6.1 vs app 10.3 -> use 10.3', decide({bodystats:[{date:'2026-05-11',weight:78.8},{date:'2026-07-02',weight:77.6}], walkbackFirst:{w:87.9,date:'2025-11-30'}, cal:{first:83.7,now:77.6,fd:'2026-02-01',nd:'2026-07-02'}}), 10.3);
// normal self-tracker (Mark)
T('Mark: app 152.7->140.7 = 12', decide({bodystats:[{date:'2026-05-11',weight:145.7},{date:'2026-07-03',weight:140.7}], walkbackFirst:{w:152.7,date:'2026-02-01'}}), 12);
// no data at all
T('no bodystats, no calendar', decide({}), null);
