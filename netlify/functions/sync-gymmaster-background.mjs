// ============================================================================
// sync-gymmaster-background  (Netlify background function, up to 15 min)
// Dependency-free: talks to Supabase via its REST API with plain fetch.
// Pulls 1-on-1 PT + pods (per member) and squads (class schedule) into Supabase.
// Secrets come from Netlify env vars (never in the browser).
// ============================================================================
const {
  GYMMASTER_API_KEY,
  GYMMASTER_BASE_URL = 'https://growingyounger.gymmasteronline.com',
  GYMMASTER_COMPANY_ID = '2',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SYNC_LOOKBACK_DAYS = '180',
} = process.env;

const ACTIVE_STATUSES = ['Current', 'Hold', 'Recently Expired', 'Concession Pack'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseTrainer(s) {
  if (!s) return null;
  const m = s.match(/^\s*(?:PT|PODS?)\s+([A-Za-z'’\-]+)/i);
  return m ? m[1] : null;
}
// Known coach first names — used to read the trainer out of a GymMaster booking
// resource like "Laura Roukema (Laura Coaching Session 45min)" or "PT Gavyn".
const COACH_NAMES = ['Gavyn','Scott','Caron','Ethan','Laura','Natalie','Kerry','Ross','Emma','Alex','Louise'];
function coachFromResource(s) {
  if (!s) return null;
  const t = String(s).toLowerCase();
  for (const n of COACH_NAMES) { if (new RegExp('\\b' + n.toLowerCase() + '\\b').test(t)) return n; }
  return null;
}
function classify(type) {
  const t = (type || '').toLowerCase();
  let kind = 'individual';
  if (/squad/.test(t)) kind = 'squad';
  else if (/\bpods?\b/.test(t)) kind = 'pod';
  else if (/on\s?board|on\s?ramp|onramp/.test(t)) kind = 'onboard';
  else if (/couple|2 people|2people/.test(t)) kind = 'couple';
  let mins = null;
  const m = t.match(/(\d+)\s*min/);
  if (m) mins = Number(m[1]);
  if (kind === 'onboard' || kind === 'squad') mins = 60;
  return { kind, billable_minutes: mins };
}

// ---- GymMaster ----
// Parse coaching entitlement from a GymMaster membership name.
// Returns {weeks, minutes, count} or null if no 1-on-1 coaching entitlement.
function parseCoaching(name){
  if(!name) return null;
  const t=name.toLowerCase();
  if(/squad/.test(t) && !/coaching/.test(t)) return null;     // squad-only membership
  if(/gym only/.test(t)) return null;
  if(/\bbronze\b/.test(t)) return {weeks:12,minutes:45,count:1};
  if(/\bcore\b/.test(t)) return {weeks:4,minutes:45,count:1};
  if(/\bessential\b/.test(t)) return {weeks:2,minutes:30,count:1};
  if(/\bpremium\b/.test(t)) return {weeks:1,minutes:30,count:1};
  if(/\belite\b/.test(t)) return {weeks:1,minutes:30,count:2};
  let m=t.match(/every\s+(\d+)\s*week/);
  if(m) return {weeks:+m[1],minutes:(+m[1]===12?45:30),count:1};
  m=t.match(/(\d+)\s*week(?:ly)?\s*coaching/);
  if(m) return {weeks:+m[1],minutes:(+m[1]===12?45:30),count:1};
  if(/bi[\s-]?weekly|fortnight/.test(t)) return {weeks:2,minutes:30,count:1};
  if(/weekly\s*(coaching|pt|hybrid)|coaching\s*(week|weekly)|1\s*x\s*coaching/.test(t)) return {weeks:1,minutes:30,count:1};
  if(/monthly/.test(t) && /coaching/.test(t)) return {weeks:4,minutes:30,count:1};
  return null;
}
async function gmGet(path) { return (await fetch(`${GYMMASTER_BASE_URL}${path}`)).json(); }
// ---- Appointment scan (staff Reporting API) --------------------------------
// GymMaster standard report #9 = every booking in a date range, for EVERY member
// regardless of membership status, with the check-in outcome ("Booking Result").
// This is the source of truth for 1-on-1 sessions. The member-portal API can't
// see expired members at all (login fails), which is why people like Matt Trent
// and Paul Tranter went missing from the invoice. One call per month, not per member.
const APPT_REPORT_ID = 9;
const HISTORY_START = '2025-12-01';
const SYNTH_FLOOR = 100000000;   // 1e8: real GM booking ids are ~4e5; synthetic ids start ~7e14

async function gmStdReport(reportId, startDate, endDate) {
  const r = await fetch(`${GYMMASTER_BASE_URL}/api/v2/report/standard_report`, {
    method: 'POST',
    headers: { 'X-GM-API-KEY': GYMMASTER_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ report_id: reportId, start_date: startDate, end_date: endDate }),
  });
  let j = null; try { j = await r.json(); } catch { return []; }
  let rows = Array.isArray(j) ? j : (j && j.result !== undefined ? j.result : j);
  if (rows && !Array.isArray(rows) && typeof rows === 'object') rows = Object.values(rows);
  return Array.isArray(rows) ? rows : [];
}

// "Wickes, Adam" -> "Adam Wickes"
function flipName(n) {
  const s = String(n || '').trim();
  if (!s.includes(',')) return s.replace(/\s+/g, ' ');
  const [sur, first] = s.split(',');
  return `${(first || '').trim()} ${(sur || '').trim()}`.replace(/\s+/g, ' ').trim();
}
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
// "6 Jul 2026" -> "2026-07-06"; falls back to the report's epoch column.
function apptDate(row) {
  const m = String(row['Booking Date'] || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const d = new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const ep = Number(row['sorted_Booking Date']);
  if (ep > 0) return new Date(ep * 1000).toISOString().slice(0, 10);
  return null;
}
// Deterministic, collision-free id: member + day + start-minute. Report 9 has no booking id.
function synthId(memberId, dateStr, startSec) {
  const dayNum = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86400000); // < 2.1e4
  const startMin = Math.floor(Number(startSec || 0) / 60) % 1440;           // < 1e4
  // memberId*1e9 gives every member a decade-wide slot (day*1e4 + startMin < 1e9),
  // so ids never collide across members and stay < MAX_SAFE_INTEGER for 6-7 digit ids.
  return Number(memberId) * 1000000000 + dayNum * 10000 + startMin;
}
// Per the studio's billing rule, ONLY "Showed" and "Showed late" count as a
// delivered/billable session. Everything else -- "Booking" (never marked),
// "No show", "Cancelled no Charge", blank -- does not bill.
function isCheckedIn(result) {
  return /^\s*showed\b/i.test(String(result || ''));
}
function durMins(d) {
  const m = String(d || '').match(/^(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Pull one month at a time so a long history never blows up a single request.
async function fetchAppointments(startDate, endDate) {
  const out = [];
  let cur = new Date(`${startDate}T00:00:00Z`);
  const stop = new Date(`${endDate}T00:00:00Z`);
  while (cur <= stop) {
    const chunkStart = cur.toISOString().slice(0, 10);
    const nxt = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const chunkEnd = (nxt > stop ? stop : new Date(nxt - 86400000)).toISOString().slice(0, 10);
    try { out.push(...await gmStdReport(APPT_REPORT_ID, chunkStart, chunkEnd)); }
    catch (e) { console.log('appt chunk failed', chunkStart, String(e).slice(0, 80)); }
    cur = nxt;
    await sleep(150);
  }
  return out;
}

// Build 1-on-1 session rows (PT / coaching / discovery) from the appointment feed.
// Class Name is set for pods & squads — those keep coming from the class schedule.
// When a slot has been cancelled then re-booked/checked-in, GymMaster keeps BOTH
// booking records, so report #9 returns two rows for the same member+date+time.
// Rank results so we always keep the one that reflects reality: a "Showed" beats a
// bare "Booking", which beats a "No show"/"Cancelled".
function resultRank(result) {
  const t = String(result || '').toLowerCase();
  if (/^\s*showed/.test(t)) return 3;      // Showed / Showed late -> attended
  if (/no[\s-]?show|cancel/.test(t)) return 0;
  return 1;                                // "Booking" (unmarked) and anything else
}
function apptRows(raw, cutoffISO) {
  const byId = new Map(); const resultTally = {}; const skipped = {};
  for (const r of raw) {
    const service = String(r.Service || '').trim();
    const className = r['Class Name'];
    resultTally[String(r['Booking Result'] || '(none)')] = (resultTally[String(r['Booking Result'] || '(none)')] || 0) + 1;
    if (className) { skipped.class = (skipped.class || 0) + 1; continue; }
    const isSales = /discovery|sales\s*(call|meeting)/i.test(service) && !/physio/i.test(service);
    const isPT = /^\s*PT\b/i.test(service);
    const isCoaching = /coaching\s*session/i.test(service) && !/squad|\bpod/i.test(service);
    if (!isPT && !isCoaching && !isSales) { skipped.other = (skipped.other || 0) + 1; continue; }
    const date = apptDate(r);
    if (!date || date < cutoffISO) { skipped.old = (skipped.old || 0) + 1; continue; }
    const memberId = Number(r['Member ID']);
    if (!memberId) { skipped.nomember = (skipped.nomember || 0) + 1; continue; }
    const id = synthId(memberId, date, r['sorted_Booking Start Time']);
    const existing = byId.get(id);
    if (existing && resultRank(existing.result_text) >= resultRank(r['Booking Result'])) { skipped.dupe = (skipped.dupe || 0) + 1; continue; }
    if (existing) skipped.dupe = (skipped.dupe || 0) + 1;   // replacing a weaker duplicate
    let kind, billable_minutes;
    if (isSales) { kind = 'sales'; billable_minutes = classify(service).billable_minutes || 30; }
    else if (isCoaching) { kind = 'individual'; const mm = service.match(/(\d+)\s*min/i); billable_minutes = mm ? Number(mm[1]) : (classify(service).billable_minutes || 30); }
    else { ({ kind, billable_minutes } = classify(service)); }
    if (billable_minutes == null) billable_minutes = durMins(r.Duration);
    const resource = String(r['Resource Name'] || '').replace(/\s+/g, ' ').trim();
    byId.set(id, {
      gm_booking_id: id, gm_member_id: memberId,
      client_name: flipName(r.Name),
      trainer_name: parseTrainer(service) || coachFromResource(resource) || coachFromResource(service),
      trainer_full: resource || null,
      service_type: service, session_kind: kind, billable_minutes,
      session_date: date, start_time: r['Booking Start Time'] || null,
      attended: isCheckedIn(r['Booking Result']), result_text: r['Booking Result'] || null,
      duration_label: (service.match(/\d+\s*min[s]?/i) || [null])[0] || r.Duration || null,
    });
  }
  const rows = [...byId.values()];
  return { rows, resultTally, skipped };
}

async function syncAppointments() {
  const endDate = new Date().toISOString().slice(0, 10);
  const raw = await fetchAppointments(HISTORY_START, endDate);
  const { rows, resultTally, skipped } = apptRows(raw, HISTORY_START);
  // Upsert in batches, capturing any PostgREST error text (a single bad row rejects
  // the whole batch, so silent failures here must never go unnoticed again).
  const upsertErrors = [];
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const resp = await fetch(`${SB}/sessions?on_conflict=gm_booking_id`, {
      method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(batch),
    });
    if (!resp.ok) upsertErrors.push({ at: i, status: resp.status, body: (await resp.text().catch(() => '')).slice(0, 300) });
  }
  // Retire the old per-member rows for this window now the appointment feed owns them,
  // otherwise the same session appears twice (real booking id + synthetic id).
  if (rows.length) {
    const q = `session_date=gte.${HISTORY_START}&session_date=lte.${endDate}` +
      `&gm_booking_id=lt.${SYNTH_FLOOR}&session_kind=in.(individual,sales,couple,onboard)`;
    await fetch(`${SB}/sessions?${q}`, { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
  }
  await sbWriteBlob('debug-appointments', JSON.stringify({
    updated: new Date().toISOString(), range: [HISTORY_START, endDate],
    raw_rows: raw.length, session_rows: rows.length, booking_results: resultTally, skipped,
    checked_in: rows.filter(r => r.attended).length,
    upsert_errors: upsertErrors,
    inserted: rows.length - upsertErrors.reduce((n, e) => n + 500, 0),
  }));
  return rows.length;
}
async function gmPost(path, body) {
  return (await fetch(`${GYMMASTER_BASE_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })).json();
}

// ---- Supabase REST helpers ----
const SB = `${SUPABASE_URL}/rest/v1`;
const sbHeaders = (extra = {}) => ({
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});
async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  const url = `${SB}/${table}?on_conflict=${onConflict}`;
  await fetch(url, { method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) });
}
async function sbInsertReturn(table, row) {
  const r = await fetch(`${SB}/${table}`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(row) });
  const j = await r.json(); return Array.isArray(j) ? j[0] : j;
}
async function sbPatch(table, match, patch) {
  await fetch(`${SB}/${table}?${match}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) });
}
async function sbSelect(table, query = '') {
  const r = await fetch(`${SB}/${table}?${query}`, { headers: sbHeaders() });
  const j = await r.json().catch(() => null);
  return Array.isArray(j) ? j : [];
}

// ---- Holds capture (defensive: GymMaster suspension shapes vary) ----
function normHoldDate(v){
  if(!v) return null; const s=String(v).slice(0,10);
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  return null;
}
function collectHolds(out, m, ms){
  const pick=(o,keys)=>{for(const k of keys){if(o&&o[k]!=null&&o[k]!=='')return o[k];}return null;};
  const name=`${m.surname||''}, ${m.firstname||''}`.trim();
  const last=String(m.surname||'').toLowerCase(); const first=String(m.firstname||'').toLowerCase();
  const consider=(start,end,reason)=>{const s=normHoldDate(start),e=normHoldDate(end);if(s&&e)out.push({member_name:name,last,first,hold_start:s,hold_end:e,reason:String(reason||'')});};
  for(const x of (ms||[])){
    consider(pick(x,['suspend_start','suspendfrom','suspend_from','hold_start','holdstart','freeze_start','suspendstart','datehold','date_hold']),
             pick(x,['suspend_end','suspendto','suspend_to','hold_end','holdend','freeze_end','suspendend','holduntil','hold_until']),
             pick(x,['suspend_reason','hold_reason','reason','holdreason']));
    const arr=x.suspensions||x.holds||x.freezes;
    if(Array.isArray(arr))for(const h of arr)
      consider(pick(h,['startdate','start','from','suspend_start','hold_start','datehold']),
               pick(h,['enddate','end','to','suspend_end','hold_end','holduntil']),
               pick(h,['reason','note','holdreason']));
  }
}
async function sbWriteBlob(source, dataStr){
  const today=new Date().toISOString().slice(0,10);
  await fetch(`${SB}/invoices?source=eq.${source}`,{method:'DELETE',headers:sbHeaders({Prefer:'return=minimal'})});
  await fetch(`${SB}/invoices`,{method:'POST',headers:sbHeaders({Prefer:'return=minimal'}),body:JSON.stringify({trainer_name:'__'+source+'__',period_start:today,period_end:today,source,status:'data',raw_text:dataStr,created_by:'weekly-sync'})});
}

function staffToTrainer(c, byStaffId, names) {
  if (c.staffid && byStaffId[c.staffid]) return byStaffId[c.staffid];
  const blob = ((c.staffname || '') + ' ' + (c.location || '')).toLowerCase();
  for (const n of names) { if (n && blob.includes(n.toLowerCase())) return n; }
  return null;
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GYMMASTER_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing env vars' }), { status: 500 });
  }
  const log = await sbInsertReturn('sync_log', { status: 'running' });
  const logId = log?.id;


  const trainers = await sbSelect('trainers', 'select=name,gm_staffid');
  const byStaffId = {}; const names = (trainers || []).map(t => t.name);
  (trainers || []).forEach(t => { if (t.gm_staffid) byStaffId[t.gm_staffid] = t.name; });

  let scanned = 0, upserted = 0;
  const holdsOut = [];
  const coachVotes = {};            // memberId -> { TrainerName: count, _email }
  const nextBooking = {};           // surnameKey -> { label, date }
  const nextBookingById = {};        // memberId -> { label, date }
  let dbgClass = 0, dbgService = 0, dbgSample = null, dbgRaw = null;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  try {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - Number(SYNC_LOOKBACK_DAYS));

    const membersResp = await gmGet(`/portal/api/v1/members?api_key=${GYMMASTER_API_KEY}&companyid=${GYMMASTER_COMPANY_ID}`);
    const allMembers = membersResp.result || [];
    // Active statuses only. /members returns ~1,993 (1,752 Expired); scanning all
    // took 43min AND can't fetch Expired members' bookings anyway (member-portal
    // login fails for expired accounts). Expired-but-training clients (Matt Trent)
    // are handled by manual add instead.
    const members = allMembers.filter(m => ACTIVE_STATUSES.includes(m.status));
    const _statusTally = {}; for (const mm of allMembers) _statusTally[mm.status || '(none)'] = (_statusTally[mm.status || '(none)'] || 0) + 1;
    const _flagged = allMembers.filter(mm => /trent|tranter/i.test(`${mm.firstname} ${mm.surname}`)).map(mm => `${mm.firstname} ${mm.surname} [${mm.status}]`);

    // One call per month across ALL members (incl. expired) — the appointment scan.
    try { upserted += await syncAppointments(); } catch (e) { console.log('appointment scan failed:', e); }

    for (const m of members) {
      scanned++;
      try {
        const login = await gmPost('/portal/api/v1/login', { api_key: GYMMASTER_API_KEY, memberid: m.id });
        const token = login?.result?.token;
        if (!token) continue;
        let leadSource = null;
        try { const prof = await gmGet(`/portal/api/v1/member/profile?api_key=${GYMMASTER_API_KEY}&token=${encodeURIComponent(token)}`); const pr = prof?.result || prof || {}; leadSource = pr.sourcepromotion || pr.source || null; } catch (e) {}
        const pastResp = await gmGet(`/portal/api/v2/member/bookings/past?api_key=${GYMMASTER_API_KEY}&token=${encodeURIComponent(token)}`);
        const past = pastResp.result || [];
        const msResp = await gmGet(`/portal/api/v1/member/memberships?api_key=${GYMMASTER_API_KEY}&token=${encodeURIComponent(token)}`);
        const ms = msResp.result || [];
        collectHolds(holdsOut, m, ms);
        // Upcoming bookings (all trainers) — for next-appointment dates.
        let upcoming = [];
        try {
          const upResp = await gmGet(`/portal/api/v2/member/bookings?api_key=${GYMMASTER_API_KEY}&token=${encodeURIComponent(token)}`);
          if (!dbgRaw) dbgRaw = { keys: Object.keys(upResp || {}), snippet: JSON.stringify(upResp).slice(0, 600) };
          const R = (upResp && upResp.result) || upResp || {};
          const cb = R.classbookings || [], sv = R.servicebookings || [];
          dbgClass += cb.length; dbgService += sv.length;
          if (!dbgSample && (cb.length || sv.length)) dbgSample = cb[0] || sv[0];
          upcoming = [...cb, ...sv];   // PT/coaching are class-type bookings (trainer in staffname)
        } catch (e) { upcoming = []; }
        // Coach assignment: read the trainer out of the booking resource for every
        // 1-on-1 coaching / PT booking (this is where "Laura Coaching Session" lives).
        for (const b of [...past, ...upcoming]) {
          const blob = `${b.name || ''} ${b.type || ''} ${b.staffname || ''} ${b.location || ''}`;
          if (/squad|\bpod/i.test(blob)) continue;
          if (!/coaching|^\s*PT\b|PT\s/i.test(blob)) continue;
          const tr = coachFromResource(b.name) || coachFromResource(b.staffname) || parseTrainer(b.type) || coachFromResource(b.type) || coachFromResource(b.location);
          if (!tr) continue;
          const v = (coachVotes[m.id] = coachVotes[m.id] || { _email: m.email });
          v[tr] = (v[tr] || 0) + 1;
        }
        // Next upcoming 1-on-1 appointment (any trainer).
        let nb = null;
        for (const b of upcoming) {
          const blob = `${b.name || ''} ${b.type || ''} ${b.staffname || ''}`;
          if (/squad|\bpod/i.test(blob)) continue;
          if (!/coaching|^\s*PT\b|PT\s/i.test(blob)) continue;
          if (!b.day) continue;
          const d = new Date(b.day); if (isNaN(d) || d < today0) continue;
          if (!nb || new Date(b.day) < new Date(nb.day)) nb = { day: b.day };
        }
        if (nb) {
          const lk = String(m.surname || '').toLowerCase().replace(/['\-\s]/g, '');
          const label = new Date(nb.day).toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
          if (lk) nextBooking[lk] = { label, date: nb.day };
          nextBookingById[m.id] = { label, date: nb.day };
        }
        const active = ms.find(x => !x.enddate) || ms[0];
        const cz = parseCoaching(active && active.name);
        // Initial sign-up cash (the 6-week PIF / onramp), separate from the ongoing membership.
        const pifM = (ms || []).find(x => /\bpif\b|onramp|on.?ramp|paid.?in.?full|kick.?start/i.test(x.name || ''));
        let signupCash = null;
        if (pifM) { const mm = String(pifM.name || '').match(/\$([\d,]+(?:\.\d+)?)/); signupCash = mm ? mm[1].replace(/,/g, '') : (pifM.price != null ? String(pifM.price).replace(/[^0-9.]/g, '') : null); }
        // Sessions now come from the appointment feed (report #9) — see syncAppointments().
        if (ACTIVE_STATUSES.includes(m.status)) await sbUpsert('clients', [{
          gm_member_id: m.id, first_name: m.firstname, surname: m.surname,
          full_name: `${m.firstname || ''} ${m.surname || ''}`.trim(),
          email: m.email, status: m.status,
          membership: active ? active.name : null,
          membership_start: active ? String(active.startdate || active.start || active.begindate || active.datestart || '').slice(0,10) || null : null,
          coach_weeks: cz ? cz.weeks : null, coach_minutes: cz ? cz.minutes : null, coach_count: cz ? cz.count : null,
          lead_source: leadSource || m.sourcepromotion || null,
          signup_cash: signupCash,
          last_synced: new Date().toISOString(),
        }], 'gm_member_id');
        await sleep(40);
      } catch (e) { /* skip member */ }
    }

    // Squads from class schedule (paid regardless of attendance)
    const weeks = Math.ceil(Number(SYNC_LOOKBACK_DAYS) / 7);
    for (let w = 0; w <= weeks; w++) {
      const d = new Date(); d.setDate(d.getDate() - w * 7);
      const wk = d.toISOString().slice(0, 10);
      try {
        const sched = await gmGet(`/portal/api/v1/booking/classes/schedule?api_key=${GYMMASTER_API_KEY}&week=${wk}`);
        const rows = (sched.result || []).filter(c => /squad/i.test(c.classname || '') || /\bpod/i.test(c.classname || '')).map(c => {
          const isPod = /\bpod/i.test(c.classname || '');
          return {
            gm_booking_id: c.id, gm_member_id: null, client_name: null,
            trainer_name: staffToTrainer(c, byStaffId, names) || (/early bird/i.test(c.classname || '') ? 'Kerry' : null),
            trainer_full: c.location || c.staffname || null, service_type: (c.classname || '').trim(),
            session_kind: isPod ? 'pod' : 'squad', billable_minutes: isPod ? 30 : 60, session_date: c.arrival,
            start_time: c.start_str || null, attended: true,
            result_text: `booked:${c.num_students}`, duration_label: isPod ? '30 mins' : '60 mins',
          };
        });
        if (rows.length) { await sbUpsert('sessions', rows, 'gm_booking_id'); upserted += rows.length; }
        await sleep(30);
      } catch (e) { /* skip week */ }
    }

    await sbWriteBlob('holds-snapshot', JSON.stringify({ updated: new Date().toISOString(), holds: holdsOut }));
    await sbWriteBlob('debug-members', JSON.stringify({ updated: new Date().toISOString(), total: allMembers.length, statuses: _statusTally, flagged: _flagged }));
    // Coach assignment from booking resources (covers coaching + PT, every trainer).
    const coachById = {}, coachByEmail = {};
    for (const id of Object.keys(coachVotes)) {
      const v = coachVotes[id];
      const ranked = Object.entries(v).filter(([k]) => k !== '_email').sort((a, b) => b[1] - a[1]);
      if (ranked.length) { coachById[id] = ranked[0][0]; if (v._email) coachByEmail[String(v._email).toLowerCase()] = ranked[0][0]; }
    }
    if (Object.keys(coachById).length) await sbWriteBlob('member-coaches', JSON.stringify({ updated: new Date().toISOString(), byId: coachById, byEmail: coachByEmail }));
    if (Object.keys(nextBooking).length) await sbWriteBlob('pt-bookings', JSON.stringify({ updated: new Date().toISOString(), bookings: nextBooking, byId: nextBookingById }));
    await sbWriteBlob('debug-bookings', JSON.stringify({ updated: new Date().toISOString(), classbookings_seen: dbgClass, servicebookings_seen: dbgService, next_found: Object.keys(nextBooking).length, sample: dbgSample, raw: dbgRaw }));
    await sbPatch('sync_log', `id=eq.${logId}`, {
      finished_at: new Date().toISOString(), members_scanned: scanned,
      sessions_upserted: upserted, status: 'ok',
      message: `Synced ${upserted} sessions (1-on-1 + pods + squads) across ${scanned} members`,
    });
    return new Response(JSON.stringify({ ok: true, scanned, upserted }), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    await sbPatch('sync_log', `id=eq.${logId}`, {
      finished_at: new Date().toISOString(), members_scanned: scanned,
      sessions_upserted: upserted, status: 'error', message: String(e),
    });
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
};

// Exported for regression tests (test/appointments.test.mjs).
export { apptRows, isCheckedIn, synthId, flipName, apptDate, durMins };
