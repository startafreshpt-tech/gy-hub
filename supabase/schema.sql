-- ============================================================================
-- GY Session Reconciliation — Supabase schema
-- Run in Supabase: Dashboard > SQL Editor > New query > paste > Run
-- ============================================================================

-- ---------- TRAINERS -------------------------------------------------------
-- `gm_match` = how the trainer appears inside a GymMaster session "type"
-- string, e.g. "PT Gavyn 45 mins" -> match "Gavyn".
create table if not exists trainers (
  id             bigint generated always as identity primary key,
  name           text    not null unique,
  gm_match       text    not null,
  is_contractor  boolean default true,            -- contractors submit invoices
  admin_eligible boolean default true,            -- can invoice admin hours (owner/manager = false)
  default_rate   numeric default 0,
  rate_per_hour  numeric default 50,              -- pay rate ($/hr); Kerry = 45
  tz_trainer_id  bigint,                          -- Trainerize trainerID (caseload)
  gm_staffid     bigint,                          -- GymMaster staff id (squad attribution)
  active         boolean default true,
  created_at     timestamptz default now()
);

-- Seed the 6 trainers found in GymMaster (edit is_contractor / rate as needed)
insert into trainers (name, gm_match, is_contractor, admin_eligible, rate_per_hour, tz_trainer_id, gm_staffid) values
  ('Gavyn',   'Gavyn',   false, false, 50, 846968,   null),     -- owner: no invoice, no admin
  ('Scott',   'Scott',   false, false, 50, 17211359, null),     -- manager: no invoice, no admin
  ('Caron',   'Caron',   true,  true,  50, 9197343,  471941),
  ('Ethan',   'Ethan',   true,  true,  50, 14755865, 471939),
  ('Laura',   'Laura',   true,  true,  50, 28036432, null),
  ('Natalie', 'Natalie', true,  true,  50, 2744337,  null),
  ('Kerry',   'Kerry',   true,  false, 45, null,     471944),   -- squads only, $45/hr, no Trainerize caseload
  ('Ross',    'Ross',    true,  false, 50, 1538611,  471943)    -- squads (Early Bird), confirm rate
on conflict (name) do update set
  tz_trainer_id  = excluded.tz_trainer_id,
  is_contractor  = excluded.is_contractor,
  admin_eligible = excluded.admin_eligible,
  rate_per_hour  = excluded.rate_per_hour,
  gm_staffid     = excluded.gm_staffid;

-- ---------- CLIENTS (mirror of GymMaster members with PT) ------------------
create table if not exists clients (
  gm_member_id bigint primary key,
  first_name   text,
  surname      text,
  full_name    text,
  email        text,
  status       text,
  last_synced  timestamptz
);

-- ---------- SESSIONS (one row per GymMaster PT booking) --------------------
create table if not exists sessions (
  gm_booking_id  bigint primary key,
  gm_member_id   bigint references clients(gm_member_id),
  client_name    text,
  trainer_name   text,        -- parsed short name ("Gavyn")
  trainer_full   text,        -- "Gavyn Berntsen"
  service_type   text,        -- raw "PT Gavyn 45 mins"
  session_kind   text,        -- individual | couple | pod | squad | onboard
  billable_minutes int,       -- 30/45/60; onboard & squad billed at 60
  session_date   date not null,
  start_time     text,
  attended       boolean,
  result_text    text,        -- "Showed late" / "No Show" / "Booking" / "Cancelled"
  duration_label text,
  synced_at      timestamptz default now()
);
create index if not exists sessions_date_idx    on sessions (session_date);
create index if not exists sessions_trainer_idx on sessions (trainer_name);
create index if not exists sessions_member_idx  on sessions (gm_member_id);

-- ---------- INVOICES (what a trainer billed for a period) ------------------
create table if not exists invoices (
  id           bigint generated always as identity primary key,
  trainer_name text not null,
  period_start date not null,
  period_end   date not null,
  source       text default 'manual',   -- manual | pdf | sheet
  status       text default 'draft',    -- draft | reconciled | approved
  notes        text,
  raw_text     text,
  created_by   text,
  created_at   timestamptz default now()
);

create table if not exists invoice_lines (
  id              bigint generated always as identity primary key,
  invoice_id      bigint references invoices(id) on delete cascade,
  client_name     text not null,
  gm_member_id    bigint,
  sessions_billed numeric not null default 0,
  rate            numeric default 0,
  amount          numeric,
  notes           text
);
create index if not exists invoice_lines_invoice_idx on invoice_lines (invoice_id);

-- ---------- SYNC LOG -------------------------------------------------------
create table if not exists sync_log (
  id                bigint generated always as identity primary key,
  started_at        timestamptz default now(),
  finished_at       timestamptz,
  members_scanned   int,
  sessions_upserted int,
  status            text,   -- running | ok | error
  message           text
);

-- ---------- MEMBERSHIP TIERS (coaching entitlements, from pricing) ----------
-- Used to cross-credit how many coaching sessions a client's plan includes.
create table if not exists memberships (
  id                bigint generated always as identity primary key,
  name              text unique,    -- Gym Only / Bronze / Core / Essential / Premium / Elite
  price_weekly      numeric,
  session_minutes   int,            -- length of an included session
  sessions_per_cycle int,           -- how many included per cycle
  cycle             text            -- week / fortnight / month / 12weeks / none
);
insert into memberships (name, price_weekly, session_minutes, sessions_per_cycle, cycle) values
  ('Gym Only',  30, 0,  0, 'none'),
  ('Bronze',    39, 45, 1, '12weeks'),
  ('Core',      49, 45, 1, 'month'),
  ('Essential', 69, 30, 1, 'fortnight'),
  ('Premium',   89, 30, 1, 'week'),
  ('Elite',    145, 30, 2, 'week')
on conflict (name) do nothing;

-- ---------- ADMIN TIME ALLOWANCE (prorated by caseload) --------------------
-- Max admin HOURS PER WEEK a coach may invoice, based on how many clients
-- they are looking after. Used to cap admin time on their invoice.
create table if not exists admin_allowance (
  min_members int,
  max_members int,
  hours_per_week numeric
);
insert into admin_allowance (min_members, max_members, hours_per_week) values
  (0,10,1), (11,20,1), (21,30,1.5), (31,40,2),
  (41,50,2.5), (51,60,3), (61,70,3.5)
on conflict do nothing;

-- ============================================================================
-- Row Level Security: only signed-in users read/write.
-- The sync function uses the service-role key, which bypasses RLS.
-- ============================================================================
alter table trainers      enable row level security;
alter table clients       enable row level security;
alter table sessions      enable row level security;
alter table invoices      enable row level security;
alter table invoice_lines enable row level security;
alter table sync_log      enable row level security;
alter table memberships   enable row level security;
alter table admin_allowance enable row level security;

create policy "auth read trainers" on trainers      for select to authenticated using (true);
create policy "auth read clients"  on clients        for select to authenticated using (true);
create policy "auth read sessions" on sessions       for select to authenticated using (true);
create policy "auth read invoices" on invoices       for select to authenticated using (true);
create policy "auth read ilines"   on invoice_lines  for select to authenticated using (true);
create policy "auth read synclog"  on sync_log       for select to authenticated using (true);
create policy "auth read memb"     on memberships     for select to authenticated using (true);
create policy "auth write memb"    on memberships     for all to authenticated using (true) with check (true);
create policy "auth read admin"    on admin_allowance for select to authenticated using (true);

create policy "auth write invoices" on invoices      for all to authenticated using (true) with check (true);
create policy "auth write ilines"   on invoice_lines for all to authenticated using (true) with check (true);
create policy "auth write trainers" on trainers      for all to authenticated using (true) with check (true);

-- ============================================================================
-- Client Follow-up: shared weekly status tracking (replaces the artifact's
-- per-browser localStorage so Gavyn and Alex see the same picture).
-- One row per (week_key, client_email). week_key = Monday of that week.
-- ============================================================================
create table if not exists followup_status (
  id           bigint generated by default as identity primary key,
  week_key     date        not null,
  client_email text        not null,
  status       text        not null,
  notes        text        default '',
  updated_by   text,
  updated_at   timestamptz default now(),
  unique (week_key, client_email)
);
create index if not exists followup_status_week_idx on followup_status (week_key);

alter table followup_status enable row level security;
-- Authenticated hub users (Gavyn, Alex) can read and write follow-up statuses.
create policy "auth read followup"  on followup_status for select to authenticated using (true);
create policy "auth write followup" on followup_status for all    to authenticated using (true) with check (true);
