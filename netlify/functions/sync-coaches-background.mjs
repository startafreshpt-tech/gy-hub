// ============================================================================
// sync-coaches-background
// Derives each client's PRIMARY coach from their GymMaster 1-on-1 sessions
// (individual / couple / onboard) — the real "who belongs to who", since
// Trainerize lumps every client under the one master account. Writes a blob
// to Supabase (invoices, source='client-coaches') for the Follow-up page.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' });

async function fetchAllSessions() {
  const out = []; let from = 0;
  for (;;) {
    const r = await fetch(`${SB_URL}/rest/v1/sessions?select=trainer_name,gm_member_id,session_date&session_kind=in.(individual,couple,onboard)&gm_member_id=not.is.null&order=session_date.desc`,
      { headers: { ...H(), Range: `${from}-${from + 999}` } });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return out;
}

function dominantCoachByMember(sessions) {
  const per = {}; // id -> { counts, recentDate, recentTrainer }
  for (const s of sessions) {
    const id = String(s.gm_member_id);
    const t = s.trainer_name;
    if (!t) continue;
    const rec = per[id] || (per[id] = { counts: {}, recentDate: '', recentTrainer: null });
    rec.counts[t] = (rec.counts[t] || 0) + 1;
    if ((s.session_date || '') > rec.recentDate) { rec.recentDate = s.session_date || ''; rec.recentTrainer = t; }
  }
  const byId = {};
  for (const id of Object.keys(per)) {
    const c = per[id];
    const ranked = Object.entries(c.counts).sort((a, b) => b[1] - a[1]);
    const topCount = ranked[0][1];
    const tied = ranked.filter(([, n]) => n === topCount).map(([t]) => t);
    // tie-break: whoever they saw most recently
    byId[id] = (tied.length > 1 && tied.includes(c.recentTrainer)) ? c.recentTrainer : ranked[0][0];
  }
  return byId;
}

async function sbWriteBlob(source, dataStr) {
  const today = new Date().toISOString().slice(0, 10);
  await fetch(`${SB_URL}/rest/v1/invoices?source=eq.${source}`, { method: 'DELETE', headers: { ...H(), Prefer: 'return=minimal' } });
  await fetch(`${SB_URL}/rest/v1/invoices`, { method: 'POST', headers: { ...H(), Prefer: 'return=minimal' },
    body: JSON.stringify({ trainer_name: '__' + source + '__', period_start: today, period_end: today, source, status: 'data', raw_text: dataStr, created_by: 'weekly-sync' }) });
}

export default async () => {
  if (!SB_URL || !SB_KEY) return new Response(JSON.stringify({ ok: false, error: 'missing env' }), { status: 500 });
  try {
    const sessions = await fetchAllSessions();
    const gmById = dominantCoachByMember(sessions);   // GymMaster session-derived (fallback)

    // Trainerize assignment overrides (the source of truth), if provided.
    let ov = { byEmail: {}, byName: {} };
    try {
      const or = await fetch(`${SB_URL}/rest/v1/invoices?select=raw_text&source=eq.coach-overrides&order=created_at.desc&limit=1`, { headers: H() });
      const oj = await or.json();
      if (Array.isArray(oj) && oj[0]) { const d = JSON.parse(oj[0].raw_text); ov.byEmail = d.byEmail || {}; ov.byName = d.byName || {}; }
    } catch (e) { /* no overrides yet */ }
    // Automatic GymMaster coach assignment read from booking resources
    // ("Laura Coaching Session" etc.) — covers online coaches too.
    let mc = { byId: {}, byEmail: {} };
    try {
      const mr = await fetch(`${SB_URL}/rest/v1/invoices?select=raw_text&source=eq.member-coaches&order=created_at.desc&limit=1`, { headers: H() });
      const mj = await mr.json();
      if (Array.isArray(mj) && mj[0]) { const d = JSON.parse(mj[0].raw_text); mc.byId = d.byId || {}; mc.byEmail = d.byEmail || {}; }
    } catch (e) { /* none yet */ }
    const normName = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();

    const cr = await fetch(`${SB_URL}/rest/v1/clients?select=gm_member_id,email,full_name`, { headers: H() });
    const clients = await cr.json();
    const byId = {}, byEmail = {};
    let overridden = 0, fromGm = 0;
    for (const c of (Array.isArray(clients) ? clients : [])) {
      const em = String(c.email || '').toLowerCase();
      const nm = normName(c.full_name);
      // Trainerize override wins; else GymMaster session coach; else nothing.
      let coach = ov.byEmail[em] || ov.byName[nm] || null;
      if (coach) overridden++;
      if (!coach) { coach = mc.byId[String(c.gm_member_id)] || mc.byEmail[em] || null; if (coach) fromGm++; }
      if (!coach) { coach = gmById[String(c.gm_member_id)] || null; if (coach) fromGm++; }
      if (coach) {
        byId[String(c.gm_member_id)] = coach;
        if (em) byEmail[em] = coach;
      }
    }
    await sbWriteBlob('client-coaches', JSON.stringify({ updated: new Date().toISOString(), byId, byEmail, source: { trainerize: overridden, gymmaster: fromGm } }));
    return new Response(JSON.stringify({ ok: true, trainerize: overridden, gymmaster: fromGm, total: Object.keys(byId).length }), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
};
