// The guard is the reason a throttled sync can no longer publish bad data.
// Every real incident is replayed here as a permanent regression test.
import { mergeSnapshot, topTransformations, auditSnapshot } from '../netlify/functions/_snapshot-guard.mjs';

let pass=0,fail=0;
const ok=(n,c)=>{c?pass++:(fail++,console.error('FAIL:',n));};
const eq=(n,a,b)=>ok(`${n} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,JSON.stringify(a)===JSON.stringify(b));
const M=(o)=>Object.assign({id:1,name:'X',lifetime:0,activities:0,combined:0,alltime_loss_kg:null,last_workout:null},o);

// ---------- INCIDENT 1: the 1000 Club emptied ----------
{
  const prev={members:[M({id:1,name:'Desley Minahan',lifetime:1065,activities:2171})]};
  const next={members:[M({id:1,name:'Desley Minahan',lifetime:0,activities:0})]};   // throttled run
  const {members,carried}=mergeSnapshot(next,prev);
  eq('throttled zero restored to 1065',members[0].lifetime,1065);
  eq('activities restored',members[0].activities,2171);
  eq('combined recomputed',members[0].combined,3236);
  ok('still qualifies for the 1000 Club',members[0].lifetime>=1000);
  eq('carry-forward is reported',carried[0].fields.includes('lifetime'),true);
}
// A partial undercount (977 vs 1065) is just as dangerous as a zero.
{
  const prev={members:[M({id:1,lifetime:1065})]};
  const next={members:[M({id:1,lifetime:977})]};
  const {members}=mergeSnapshot(next,prev);
  eq('partial undercount corrected',members[0].lifetime,1065);
}

// ---------- INCIDENT 2: Sharron Booth blanked ----------
{
  const prev={members:[M({id:7,name:'Sharron Booth',lifetime:568,activities:173,alltime_loss_kg:22.7,last_workout:'2026-07-22'})]};
  const next={members:[M({id:7,name:'Sharron Booth',lifetime:0,activities:0,alltime_loss_kg:null,last_workout:null})]};
  const {members,carried}=mergeSnapshot(next,prev);
  eq('workouts restored',members[0].lifetime,568);
  eq('transformation restored',members[0].alltime_loss_kg,22.7);
  eq('last workout restored',members[0].last_workout,'2026-07-22');
  eq('all three flagged',carried[0].fields.length,4);
  eq('stays top of the board',topTransformations(members)[0].name,'Sharron Booth');
}

// ---------- INCIDENT 3: transformations collapsed to the recent window ----------
{
  const prev={members:[
    M({id:1,name:'April Van Berkum',alltime_loss_kg:20.9}),
    M({id:2,name:'Ian Newson',alltime_loss_kg:15.2}),
    M({id:3,name:'Ayleen De Vilder',alltime_loss_kg:16.3}),
  ]};
  const next={members:[
    M({id:1,name:'April Van Berkum',alltime_loss_kg:3.8}),
    M({id:2,name:'Ian Newson',alltime_loss_kg:1.1}),
    M({id:3,name:'Ayleen De Vilder',alltime_loss_kg:8.5}),
  ]};
  const {members}=mergeSnapshot(next,prev);
  eq('April restored',members[0].alltime_loss_kg,20.9);
  eq('Ian restored',members[1].alltime_loss_kg,15.2);
  eq('Ayleen restored',members[2].alltime_loss_kg,16.3);
  const board=topTransformations(members);
  eq('board order rebuilt',board.map(b=>b.name),['April Van Berkum','Ayleen De Vilder','Ian Newson']);
}

// ---------- Real change must still get through ----------
{
  const prev={members:[M({id:1,lifetime:1000,activities:100,alltime_loss_kg:10,last_workout:'2026-07-01'})]};
  const next={members:[M({id:1,lifetime:1010,activities:110,alltime_loss_kg:12,last_workout:'2026-07-20'})]};
  const {members,carried}=mergeSnapshot(next,prev);
  eq('growth passes through',members[0].lifetime,1010);
  eq('activity growth passes',members[0].activities,110);
  eq('bigger loss passes',members[0].alltime_loss_kg,12);
  eq('newer workout date passes',members[0].last_workout,'2026-07-20');
  eq('nothing carried',carried.length,0);
}
// A genuine, modest regain is respected (not treated as a failure).
{
  const prev={members:[M({id:1,alltime_loss_kg:10})]};
  const next={members:[M({id:1,alltime_loss_kg:8})]};       // 80% — plausible regain
  eq('real regain respected',mergeSnapshot(next,prev).members[0].alltime_loss_kg,8);
}
// Small losses aren't protected (noise, not transformations).
{
  const prev={members:[M({id:1,alltime_loss_kg:2})]};
  const next={members:[M({id:1,alltime_loss_kg:null})]};
  eq('sub-3kg not carried',mergeSnapshot(next,prev).members[0].alltime_loss_kg,null);
}
// New members and first-ever run behave sanely.
{
  const {members,carried}=mergeSnapshot({members:[M({id:99,lifetime:5})]},{members:[]});
  eq('no previous snapshot passes through',members[0].lifetime,5);
  eq('nothing carried on first run',carried.length,0);
}
{
  const prev={members:[M({id:1,lifetime:900})]};
  const next={members:[M({id:1,lifetime:910}),M({id:2,name:'New Joiner',lifetime:3})]};
  const {members}=mergeSnapshot(next,prev);
  eq('new joiner untouched',members[1].lifetime,3);
  ok('new joiner not invented into a club',members[1].lifetime<100);
}
// A departed member in prev must not be resurrected into the new snapshot.
{
  const prev={members:[M({id:1,lifetime:900}),M({id:2,name:'Left Studio',lifetime:800})]};
  const next={members:[M({id:1,lifetime:905})]};
  eq('departed member not resurrected',mergeSnapshot(next,prev).members.length,1);
}

// ---------- Degraded runs are visible, not silent ----------
{
  const prev={members:Array.from({length:263},(_,i)=>M({id:i,lifetime:100}))};
  const next={members:Array.from({length:263},(_,i)=>M({id:i,lifetime:i<120?0:100}))};
  const alerts=auditSnapshot(next,prev,{});
  ok('zero-workout spike raises an alert',alerts.some(a=>/no workouts/i.test(a)));
}
{
  const alerts=auditSnapshot({members:[]},{members:[]},{calendar_still_failed:4,weak_baseline:2});
  ok('unresolved failures alert',alerts.some(a=>/still failing/i.test(a)));
  ok('weak baseline alerts',alerts.some(a=>/unreliable weight/i.test(a)));
}
{
  eq('clean run raises nothing',auditSnapshot({members:[M({})]},{members:[M({})]},{}),[]);
}
eq('board ignores null and zero losses',topTransformations([M({name:'a',alltime_loss_kg:null}),M({name:'b',alltime_loss_kg:0}),M({name:'c',alltime_loss_kg:5})]),[{name:'c',kg:5}]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
