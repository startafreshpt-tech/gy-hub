// ============================================================================
// sync-cron  (Netlify scheduled function)
// Fires the background sync every hour.
// Adjust the cron in netlify.toml [functions."sync-cron"].
// ============================================================================
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  try {
    await fetch(`${base}/.netlify/functions/sync-gymmaster-background`, { method: 'POST' });
  } catch (e) {
    console.error('cron trigger failed', e);
  }
  return new Response('triggered');
};
export const config = { schedule: '0 1 * * 1' };
