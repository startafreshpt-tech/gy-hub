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
