// ============================================================================
// sync-bookings-background
// Fetches the GymMaster iCal feed, extracts upcoming "PT Gavyn" sessions, and
// stores them in Supabase (invoices table, source='pt-bookings') for the
// Client Follow-up page. Dependency-free; reused by GitHub Actions weekly run.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (ICAL_URL optional override)
// ============================================================================
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ICAL_URL = process.env.GY_ICAL_URL ||
  'https://growingyounger.gymmasteronline.com/ical/20d763e2d518bc563ee9ffbb168f101ed9c7d831.ics';

function parseIcal(raw, now = new Date()) {
  now.setHours(0, 0, 0, 0);
  const cutoff = new Date(now); cutoff.setDate(now.getDate() + 112); // 16 weeks
  const bookings = {};
  for (const ev of String(raw).split('BEGIN:VEVENT')) {
    const sm = ev.match(/SUMMARY:(.+)/);
    const st = ev.match(/DTSTART[^:]*:(\d{8}T\d{6})/);
    if (!sm || !st) continue;
    const summary = sm[1].trim();
    const low = summary.toLowerCase();
    if (!low.includes('pt gavyn') && !low.includes('pt  gavyn')) continue;
    const ds = st[1];
    const date = new Date(+ds.slice(0,4), +ds.slice(4,6)-1, +ds.slice(6,8), +ds.slice(9,11), +ds.slice(11,13));
    if (date < now || date > cutoff) continue;
    const colon = summary.indexOf(':');
    const namePart = colon > -1 ? summary.slice(0, colon) : summary;
    const cleaned = namePart.replace(/\\/g, '');
    const comma = cleaned.indexOf(',');
    const lastName = comma > -1 ? cleaned.slice(0, comma).trim().toLowerCase() : cleaned.trim().toLowerCase();
    const firstName = comma > -1 ? cleaned.slice(comma+1).trim().toLowerCase() : '';
    if (!lastName) continue;
    const lastKey = lastName.replace(/['\-\s]/g, '');
    const label = date.toLocaleDateString('en-NZ', { weekday:'short', day:'numeric', month:'short' });
    const iso = date.toISOString().slice(0,10);
    if (!bookings[lastKey] || bookings[lastKey].date > iso) {
      bookings[lastKey] = { label, date: iso, firstName };
    }
  }
  return bookings;
}

async function sbWrite(source, dataStr) {
  const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
  const today = new Date().toISOString().slice(0,10);
  await fetch(`${SB_URL}/rest/v1/invoices?source=eq.${source}`, { method:'DELETE', headers:{...H, Prefer:'return=minimal'} });
  await fetch(`${SB_URL}/rest/v1/invoices`, { method:'POST', headers:{...H, Prefer:'return=minimal'},
    body: JSON.stringify({ trainer_name:'__bookings__', period_start:today, period_end:today, source, status:'data', raw_text:dataStr, created_by:'weekly-sync' }) });
}

export default async () => {
  if (!SB_URL || !SB_KEY) return new Response(JSON.stringify({ ok:false, error:'missing env' }), { status:500 });
  try {
    const r = await fetch(ICAL_URL, { signal: AbortSignal.timeout(20000) });
    const raw = await r.text();
    const bookings = parseIcal(raw);
    await sbWrite('pt-bookings', JSON.stringify({ updated: new Date().toISOString(), bookings }));
    return new Response(JSON.stringify({ ok:true, count: Object.keys(bookings).length }), { headers:{'content-type':'application/json'} });
  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error:String(e) }), { status:500 });
  }
};

export { parseIcal };
