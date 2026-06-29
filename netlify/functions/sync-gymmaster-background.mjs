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
const COACH_NAMES = ['Gavyn','Scott','Caron','Ethan','Laura','Natalie','Kerry','Ross','Emma'];
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
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  try {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - Number(SYNC_LOOKBACK_DAYS));

    const membersResp = await gmGet(`/portal/api/v1/members?api_key=${GYMMASTER_API_KEY}&companyid=${GYMMASTER_COMPANY_ID}`);
    const members = (membersResp.result || []).filter(m => ACTIVE_STATUSES.includes(m.status));

    for (const m of members) {
      scanned++;
      try {
        const login = await gmPost('/portal/api/v1/login', { api_key: GYMMASTER_API_KEY, memberid: m.id });
        const token = login?.result?.token;
        if (!token) continue;
        const pastResp = await gmGet(`/portal/api/v2/member/bookings/past?api_key=${GYMMASTER_API_KEY}&token=${encodeURIComponent(token)}`);
        const past = pastResp.result || [];
        const msResp = await gmGet(`/portal/api/v1/member/memberships?api_key=${GYMMASTER_API_KEY}&token=${encodeURIComponent(token)}`);
        const ms = msResp.result || [];
        collectHolds(holdsOut, m, ms);
        // Upcoming bookings (all trainers) — for next-appointment dates.
        let upcoming = [];
        try { const upResp = await gmGet(`/portal/api/v2/member/bookings?api_key=${GYMMASTER_API_KEY}&token=${encodeURIComponent(token)}`); upcoming = upResp.servicebookings || []; } catch (e) { upcoming = []; }
        // Coach assignment: read the trainer out of the booking resource for every
        // 1-on-1 coaching / PT booking (this is where "Laura Coaching Session" lives).
        for (const b of [...past, ...upcoming]) {
          const blob = `${b.name || ''} ${b.type || ''}`;
          if (/squad|\bpod/i.test(blob)) continue;
          if (!/coaching|^\s*PT\b|PT\s/i.test(blob)) continue;
          const tr = coachFromResource(b.name) || parseTrainer(b.type) || coachFromResource(b.type);
          if (!tr) continue;
          const v = (coachVotes[m.id] = coachVotes[m.id] || { _email: m.email });
          v[tr] = (v[tr] || 0) + 1;
        }
        // Next upcoming 1-on-1 appointment (any trainer).
        let nb = null;
        for (const b of upcoming) {
          const blob = `${b.name || ''} ${b.type || ''}`;
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
        const rows = [];
        for (const b of past) {
          const type = b.type || '';
          if (!/^\s*PT\b/i.test(type)) continue; // pods & squads come from schedule
          if (!b.day || new Date(b.day) < cutoff) continue;
          const { kind, billable_minutes } = classify(type);
          rows.push({
            gm_booking_id: b.id, gm_member_id: m.id,
            client_name: `${m.firstname || ''} ${m.surname || ''}`.trim(),
            trainer_name: parseTrainer(type) || parseTrainer(b.name),
            trainer_full: b.name || b.location || null,
            service_type: type, session_kind: kind, billable_minutes,
            session_date: b.day, start_time: b.start_str || b.starttime || null,
            attended: !!b.attended, result_text: b.resulttext || null,
            duration_label: (type.match(/\d+\s*min[s]?/i) || [null])[0],
          });
        }
        await sbUpsert('clients', [{
          gm_member_id: m.id, first_name: m.firstname, surname: m.surname,
          full_name: `${m.firstname || ''} ${m.surname || ''}`.trim(),
          email: m.email, status: m.status,
          membership: active ? active.name : null,
          coach_weeks: cz ? cz.weeks : null, coach_minutes: cz ? cz.minutes : null, coach_count: cz ? cz.count : null,
          last_synced: new Date().toISOString(),
        }], 'gm_member_id');
        if (rows.length) { await sbUpsert('sessions', rows, 'gm_booking_id'); upserted += rows.length; }
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
    // Coach assignment from booking resources (covers coaching + PT, every trainer).
    const coachById = {}, coachByEmail = {};
    for (const id of Object.keys(coachVotes)) {
      const v = coachVotes[id];
      const ranked = Object.entries(v).filter(([k]) => k !== '_email').sort((a, b) => b[1] - a[1]);
      if (ranked.length) { coachById[id] = ranked[0][0]; if (v._email) coachByEmail[String(v._email).toLowerCase()] = ranked[0][0]; }
    }
    if (Object.keys(coachById).length) await sbWriteBlob('member-coaches', JSON.stringify({ updated: new Date().toISOString(), byId: coachById, byEmail: coachByEmail }));
    if (Object.keys(nextBooking).length) await sbWriteBlob('pt-bookings', JSON.stringify({ updated: new Date().toISOString(), bookings: nextBooking, byId: nextBookingById }));
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
