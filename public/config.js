// Public Supabase config — safe to expose (protected by Row Level Security + Auth).
window.APP_CONFIG = {
  SUPABASE_URL: 'https://eqevyohstkwqslloqsni.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_sXCosNFUdqcFvpG2aJnYlw_bTg9M9dn'
};

// ── Role-based access ───────────────────────────────────────────────
// A user's role is looked up from the app_roles table (keyed by email).
//   role 'full'    → sees every tool (default when no row exists)
//   role 'limited' → sees only the pages listed in app_roles.tools[]
window.cwRole = async function (sb) {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const email = session.user.email;
    const { data } = await sb.from('app_roles').select('role,tools').ilike('email', email).maybeSingle();
    return { email, role: (data && data.role) || 'full', tools: (data && data.tools) || null };
  } catch (e) { return { email: null, role: 'full', tools: null }; }
};
window.cwAllowed = function (role, page) {
  if (!role) return false;
  if (role.role !== 'limited') return true;
  if (!Array.isArray(role.tools)) return true;
  return role.tools.includes(page);
};
// Use on a tool page: redirects to the hub if the signed-in user may not see it.
window.cwGuard = async function (sb, page) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace('index.html'); return null; }
  const role = await window.cwRole(sb);
  if (!window.cwAllowed(role, page)) { location.replace('index.html'); return null; }
  return role;
};

// Shared top nav bar — only shows tools the signed-in user is allowed to see.
window.cwNav = function (role, current) {
  if (!document.getElementById('cwnav-style')) {
    const st = document.createElement('style'); st.id = 'cwnav-style';
    st.textContent = '.cwnav{display:flex;gap:4px;background:#13291d;padding:6px 10px;overflow-x:auto;align-items:center}.cwnav a{color:#cde7d6;text-decoration:none;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 12px;border-radius:7px;white-space:nowrap}.cwnav a:hover{background:rgba(255,255,255,.08)}.cwnav a.active{background:#2f5d43;color:#fff}.cwnav .sp{flex:1}';
    document.head.appendChild(st);
  }
  const tools = [
    { h:'index.html', ic:'🌿', t:'Hub' },
    { h:'invoice.html', ic:'🧾', t:'Invoice' },
    { h:'milestones.html', ic:'🏅', t:'Milestones' },
    { h:'studio-pulse.html', ic:'📉', t:'Studio Pulse' },
    { h:'followup.html', ic:'📞', t:'Follow-Up' },
  ].filter(x => x.h === 'index.html' || window.cwAllowed(role, x.h));
  return `<nav class="cwnav">${tools.map(x => `<a href="${x.h}"${x.h===current?' class="active"':''}>${x.ic} ${x.t}</a>`).join('')}<span class="sp"></span><a href="#" onclick="(async()=>{await sb.auth.signOut();location.replace('index.html')})();return false">Sign out</a></nav>`;
};
