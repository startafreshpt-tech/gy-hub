// Guards for the GymMaster appointment scan (standard report #9), which is the
// source of truth for 1-on-1 sessions on the invoice. A silent regression here
// under- or over-bills a trainer, so every branch is pinned.
import { apptRows, isCheckedIn, synthId, flipName, apptDate } from '../netlify/functions/sync-gymmaster-background.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));

// ---- check-in interpretation -------------------------------------------------
eq('showed late counts as checked in', isCheckedIn('Showed late'), true);
eq('attended counts', isCheckedIn('Attended'), true);
eq('arrived counts', isCheckedIn('Arrived'), true);
eq('checked in counts', isCheckedIn('Checked In'), true);
eq('no show does not count', isCheckedIn('No Show'), false);
eq('no-show hyphen does not count', isCheckedIn('no-show'), false);
eq('noshow does not count', isCheckedIn('Noshow'), false);
eq('cancelled does not count', isCheckedIn('Cancelled'), false);
eq('empty does not count', isCheckedIn(''), false);
eq('null does not count', isCheckedIn(null), false);

// ---- name + date parsing -----------------------------------------------------
eq('flips surname-first', flipName('Wickes, Adam'), 'Adam Wickes');
eq('leaves normal names alone', flipName('Adam Wickes'), 'Adam Wickes');
eq('handles stray spaces', flipName('Trent,  Matt '), 'Matt Trent');
eq('parses GM date', apptDate({ 'Booking Date': '6 Jul 2026' }), '2026-07-06');
eq('parses single-digit month day', apptDate({ 'Booking Date': '3 Jun 2026' }), '2026-06-03');
eq('falls back to epoch', apptDate({ 'Booking Date': 'garbage', 'sorted_Booking Date': 1783296000 }), '2026-07-06');
eq('null when unparseable', apptDate({ 'Booking Date': 'garbage' }), null);

// ---- synthetic ids -----------------------------------------------------------
const id1 = synthId(799387, '2026-07-06', 65400);
eq('id is deterministic', synthId(799387, '2026-07-06', 65400), id1);
ok('id never collides with real GM booking ids (~4e5)', id1 > 1e8);
ok('id sits above the synthetic/real boundary (1e8)', id1 > 1e8);
ok('id stays inside safe integer range', id1 < Number.MAX_SAFE_INTEGER);
ok('different start times differ', synthId(799387, '2026-07-06', 65400) !== synthId(799387, '2026-07-06', 69000));
ok('different members differ', synthId(799387, '2026-07-06', 65400) !== synthId(799392, '2026-07-06', 65400));
ok('different days differ', synthId(799387, '2026-07-06', 65400) !== synthId(799387, '2026-07-07', 65400));

// ---- row building ------------------------------------------------------------
const row = (o) => Object.assign({
  'Member ID': 799387, Name: 'Wickes, Adam', 'Booking Date': '6 Jul 2026',
  Duration: '0:45:00', 'Booking Start Time': '6:10:00 pm', 'sorted_Booking Start Time': 65400,
  'Booking Result': 'Showed late', 'Resource Name': 'Natalie  Blyth ', 'Class Name': null,
  Service: 'PT Natalie 45min',
}, o);
const CUT = '2025-12-01';

{
  const { rows } = apptRows([row({})], CUT);
  eq('one PT row captured', rows.length, 1);
  const r = rows[0];
  eq('trainer from service', r.trainer_name, 'Natalie');
  eq('resource collapsed', r.trainer_full, 'Natalie Blyth');
  eq('client name flipped', r.client_name, 'Adam Wickes');
  eq('kind individual', r.session_kind, 'individual');
  eq('minutes parsed', r.billable_minutes, 45);
  eq('date parsed', r.session_date, '2026-07-06');
  eq('attended true', r.attended, true);
  eq('result kept', r.result_text, 'Showed late');
}

// Expired members are exactly why this feed exists — Matt Trent must come through.
{
  const { rows } = apptRows([row({ 'Member ID': 700001, Name: 'Trent, Matt', 'Booking Date': '3 Jun 2026', Service: 'PT Gavyn 45 Mins', 'Booking Result': 'Attended' })], CUT);
  eq('expired member captured', rows.length, 1);
  eq('expired member attended', rows[0].attended, true);
  eq('expired member name', rows[0].client_name, 'Matt Trent');
  eq('expired member trainer', rows[0].trainer_name, 'Gavyn');
}

// Pods & squads come from the class schedule; taking them here would double-bill.
{
  const { rows } = apptRows([row({ 'Class Name': 'Squad 6am', Service: 'Squad' })], CUT);
  eq('class rows skipped', rows.length, 0);
}
{
  const { rows } = apptRows([row({ 'Class Name': 'Pods 9am', Service: 'PODS Gavyn' })], CUT);
  eq('pod rows skipped', rows.length, 0);
}

// Coaching sessions are billable 1-on-1s booked under a different naming scheme.
{
  const { rows } = apptRows([row({ Service: 'Laura Coaching Session 45min', 'Resource Name': 'Laura Roukema' })], CUT);
  eq('coaching captured', rows.length, 1);
  eq('coaching trainer', rows[0].trainer_name, 'Laura');
  eq('coaching kind', rows[0].session_kind, 'individual');
  eq('coaching minutes', rows[0].billable_minutes, 45);
}
{
  const { rows } = apptRows([row({ Service: 'Discovery Meeting Alex', 'Resource Name': 'Alex' })], CUT);
  eq('discovery captured', rows.length, 1);
  eq('discovery kind', rows[0].session_kind, 'sales');
  eq('discovery trainer', rows[0].trainer_name, 'Alex');
}
{
  const { rows } = apptRows([row({ Service: 'Physio Discovery' })], CUT);
  eq('physio excluded from sales', rows.length, 0);
}
{
  const { rows } = apptRows([row({ Service: 'Gym Induction' })], CUT);
  eq('unrelated services skipped', rows.length, 0);
}

// Not-checked-in bookings are still captured (the invoice greys them out).
{
  const { rows } = apptRows([row({ 'Booking Result': 'No Show' })], CUT);
  eq('no-show still captured', rows.length, 1);
  eq('no-show not attended', rows[0].attended, false);
}
{
  const { rows } = apptRows([row({ 'Booking Result': null })], CUT);
  eq('unmarked booking captured', rows.length, 1);
  eq('unmarked booking not attended', rows[0].attended, false);
}

// Duplicates would double-bill.
{
  const { rows } = apptRows([row({}), row({})], CUT);
  eq('identical bookings deduped', rows.length, 1);
}
// Same member, same day, different time = two real sessions.
{
  const { rows } = apptRows([row({}), row({ 'sorted_Booking Start Time': 69000 })], CUT);
  eq('same-day different-time kept separate', rows.length, 2);
}
// Nothing before the cutoff, nothing without a member.
{
  const { rows } = apptRows([row({ 'Booking Date': '1 Nov 2025' })], CUT);
  eq('pre-cutoff dropped', rows.length, 0);
}
{
  const { rows } = apptRows([row({ 'Member ID': null })], CUT);
  eq('memberless row dropped', rows.length, 0);
}
// No phantom rows from junk input.
{
  const { rows } = apptRows([{}, null && {}].filter(Boolean), CUT);
  eq('empty row produces nothing', rows.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
