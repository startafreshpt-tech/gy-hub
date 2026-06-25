# Growing Younger Hub

Internal tools for Growing Younger Fitness Studio, behind one Supabase login.

- **Invoice Reconciliation** (`public/invoice.html`) — trainer invoices vs GymMaster sessions/pods/squads/admin + GST.
- **Trainerize Milestones** (`public/milestones.html`) — coming soon (live, weekly refresh from Trainerize).
- **Studio Pulse** (`public/studio-pulse.html`) — coming soon (live, weekly refresh from GymMaster).
- Home/portal: `public/index.html`.

## Stack
- Hosting: Netlify (publish `public/`, functions `netlify/functions/`, auto-deploy from this repo).
- Data: Supabase (Postgres + Auth). Schema in `supabase/schema.sql`.
- Sync: `netlify/functions/sync-gymmaster-background.mjs` (GymMaster + Trainerize → Supabase), weekly via `sync-cron.mjs`.

## Secrets (Netlify env vars — never commit)
GYMMASTER_API_KEY, GYMMASTER_BASE_URL, GYMMASTER_COMPANY_ID,
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SYNC_LOOKBACK_DAYS,
TRAINERIZE_GROUP_ID, TRAINERIZE_API_TOKEN
