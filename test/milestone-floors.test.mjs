// Guards for the Milestone Clubs. Two real incidents motivated these:
//  1. Trainerize throttles getClientSummary -> members silently kept 0 workouts
//     and every club emptied.
//  2. Trainerize's own badge (1000) can exceed the API's workoutsTotal (977),
//     so club membership built on workoutsTotal alone under-reports.
let pass=0,fail=0;
const ok=(n,c)=>{c?pass++:(fail++,console.error('FAIL:',n));};
const eq=(n,a,b)=>ok(`${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,JSON.stringify(a)===JSON.stringify(b));

// --- replica of the badge extraction ---
function badgeOf(stats){
  let milMax=0;
  for(const s of stats||[]){
    const dd=s.data||{};
    if(s.category!=='workoutMilestone') continue;
    for(const cand of [dd.data,dd.milestone,dd.count,dd.value,dd.number,dd.total,s.total]){
      const n=Number(cand); if(Number.isFinite(n)&&n>=50&&n<=100000) milMax=Math.max(milMax,n);
    }
  }
  return milMax;
}
// --- replica of the floor logic ---
function applyFloor(a,prev){
  const p=prev||{};
  const lifeFloor=Math.max(Number(a.mil_badge)||0,Number(p.lifetime)||0);
  const lifetime=Math.max(a.lifetime||0,lifeFloor);
  const activities=Math.max(a.activities||0,Number(p.activities)||0);
  return {lifetime,activities,combined:lifetime+activities};
}

// badge is read from whichever field Trainerize uses
eq('badge from data',      badgeOf([{category:'workoutMilestone',data:{data:1000}}]), 1000);
eq('badge from milestone', badgeOf([{category:'workoutMilestone',data:{milestone:1000}}]), 1000);
eq('badge from count',     badgeOf([{category:'workoutMilestone',data:{count:900}}]), 900);
eq('badge from total',     badgeOf([{category:'workoutMilestone',total:800}]), 800);
eq('highest badge wins',   badgeOf([{category:'workoutMilestone',data:{data:500}},{category:'workoutMilestone',data:{data:1000}}]), 1000);
eq('ignores other stats',  badgeOf([{category:'workoutBrokenRecord',data:{data:9999}}]), 0);
eq('ignores junk values',  badgeOf([{category:'workoutMilestone',data:{data:3}}]), 0);
eq('no stats -> 0',        badgeOf([]), 0);

// Desley: badge 1000 but API says 977 -> must land in the 1000 club
{
  const r=applyFloor({lifetime:977,activities:2119,mil_badge:1000},null);
  eq('badge lifts 977 to 1000', r.lifetime, 1000);
  ok('Desley qualifies for 1000 club', r.lifetime>=1000);
  eq('activities untouched', r.activities, 2119);
  eq('combined recomputed', r.combined, 3119);
}
// A throttled run returns 0 -> previous snapshot holds the line
{
  const r=applyFloor({lifetime:0,activities:0,mil_badge:0},{lifetime:1240,activities:300});
  eq('throttled run keeps prev lifetime', r.lifetime, 1240);
  eq('throttled run keeps prev activities', r.activities, 300);
  ok('club membership survives a throttled sync', r.lifetime>=1000);
}
// Genuine growth is never held back by the floor
{
  const r=applyFloor({lifetime:1300,activities:400,mil_badge:1000},{lifetime:1240,activities:300});
  eq('real growth wins over floors', r.lifetime, 1300);
  eq('activities grow', r.activities, 400);
}
// Partial throttle: count short but badge proves the milestone
{
  const r=applyFloor({lifetime:12,activities:0,mil_badge:1000},{lifetime:0,activities:0});
  eq('badge rescues a badly short count', r.lifetime, 1000);
}
// No history, no badge, genuine new member -> stays honest (no invented numbers)
{
  const r=applyFloor({lifetime:37,activities:5,mil_badge:0},null);
  eq('new member unchanged', r.lifetime, 37);
  ok('no phantom club entry', r.lifetime<100);
}


// --- bodystat failure semantics -------------------------------------------
// A throttled /bodystats/get used to return null, identical to "no measurements".
// That wiped the all-time baseline and let the short recent window be published as
// the all-time loss (April Van Berkum: 20.9kg -> 3.8kg). Failure must be explicit.
function bodystatResult(apiResp){
  if(apiResp&&apiResp.code===200){const bm=apiResp.bodyMeasures||{};return{bw_lb:bm.bodyWeight??null};}
  return {_failed:true};
}
function collect(resp){ const r=bodystatResult(resp); return r&&r._failed ? {value:null,failed:true} : {value:r.bw_lb,failed:false}; }

eq('429 is a failure, not empty data', collect({_http:429}), {value:null,failed:true});
eq('network error is a failure',       collect({_err:'boom'}),  {value:null,failed:true});
eq('null response is a failure',       collect(null),           {value:null,failed:true});
eq('genuine empty reading is NOT a failure', collect({code:200,bodyMeasures:{}}), {value:null,failed:false});
eq('real reading passes through',      collect({code:200,bodyMeasures:{bodyWeight:210}}), {value:210,failed:false});

// The all-time figure must never be replaced by a smaller recent-window number
// when a real all-time baseline exists.
function chooseLoss(appLoss,calLoss){
  return (appLoss!=null&&appLoss>0&&(calLoss==null||appLoss>calLoss)) ? appLoss : calLoss;
}
eq('keeps larger all-time over recent window', chooseLoss(3.8,20.9), 20.9);
eq('recent window wins only when genuinely bigger', chooseLoss(16.9,12.0), 16.9);
eq('recent used when no all-time pair exists', chooseLoss(3.8,null), 3.8);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
