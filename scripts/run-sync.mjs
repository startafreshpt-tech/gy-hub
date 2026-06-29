// Runs the weekly data syncs on GitHub Actions (free compute) instead of Netlify.
// Reuses the exact sync code from netlify/functions — just invokes the handlers.
import gm from '../netlify/functions/sync-gymmaster-background.mjs';
import ms from '../netlify/functions/sync-milestones-background.mjs';
import bk from '../netlify/functions/sync-bookings-background.mjs';
async function run(name, fn){
  console.log(`\n=== ${name} — start ${new Date().toISOString()} ===`);
  try { const r = await fn(); const body = await r.text().catch(()=> ''); console.log(name, 'result:', body || '(no body)'); }
  catch (e) { console.error(name, 'FAILED:', e); process.exitCode = 1; }
}
await run('GymMaster sessions/pods/squads sync', gm);
await run('Trainerize milestones sync', ms);
await run('GymMaster bookings (iCal) sync', bk);
console.log('\nAll syncs complete', new Date().toISOString());
