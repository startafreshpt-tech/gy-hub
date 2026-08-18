# Growing Younger — gy-hub Project Context

**Read this first in any new conversation.** It captures the architecture, the
data model, and the decisions/gotchas that the code doesn't state out loud, so a
fresh session is up to speed without re-reading old chats.

Studio: Growing Younger, an over-40s functional-fitness studio (Auckland, NZ).
Owner: Gavyn Berntsen. GymMaster subdomain: `growingyounger`. Trainerize group `6611`.

---

## What this is

A private internal hub (staff logins) with four tools, deployed on **GitHub Pages**
(frontend) + **GitHub Actions** (weekly sync) + **Supabase** (Postgres). It pulls from
**GymMaster** (gym management) and **Trainerize** (coaching app).

Tools (pages in `public/`):
- **Invoice Check** (`invoice.html`) — reconciles trainer session invoices vs GymMaster.
- **Studio Pulse** (`studio-pulse.html`) — churn-risk scoring.
- **Milestones** (`milestones.html`) — workout/weight-loss milestone dashboard + clubs.
- **Follow-Up** (`followup.html`) — who needs contacting; coach rosters.

Run the sync: GitHub → `startafreshpt-tech/gy-hub` → Actions → **Weekly Sync** → Run workflow.
I (Claude) **cannot** trigger it via API — the user clicks Run. Repo is **PUBLIC**: never commit secrets.

## How the sync works

`.github/workflows/weekly-sync.yml` runs `scripts/run-sync.mjs`, which invokes, in order:
`sync-gymmaster-background.mjs` (gm), `sync-milestones-background.mjs` (ms),
`sync-coaches-background.mjs` (co), `sync-deactivated-background.mjs` (dz), then
`scripts/studio-pulse.mjs`. All write to Supabase.

A separate **Netlify** scheduled deploy also runs the same functions (~Mon 1pm NZT) and
can run STALE code — this caused duplicate rows once. Worth disabling in Netlify; the
GitHub Actions run is the real one. Dedupe logic protects against it regardless.

## Data model (Supabase)

- `sessions` — one row per booking. Primary key `gm_booking_id`. Real GymMaster ids are
  ~4e5; **synthetic** ids from the appointment scan are `memberId*1e9 + dayNum*1e4 + startMin`
  (≈7e14). Boundary constant `SYNTH_FLOOR = 1e8` separates them. **No FK to clients** (dropped —
  it blocked expired-member inserts). `attended` boolean drives billing.
- `clients` — GymMaster active members (name, email, gm_member_id, membership, status).
- `manual_sessions`, `followup_status`, `coach_overrides`, `sales_log`, `app_roles`, `trainers`.
- **Blobs** live in the `invoices` table keyed by `source`: `tz-roster` (Trainerize coach
  assignment authority), `pt-bookings` (next bookings), `holds-snapshot`, `member-coaches`,
  `client-coaches`, `milestones-snapshot` (kept last 5), `tz-deactivated`, and `debug-*`
  diagnostics.

## Key decisions & gotchas (the "why")

**Sessions come from GymMaster report #9** (standard_report, staff key `X-GM-API-KEY`), not
per-member login — the member-portal API can't see expired members. Report #9 gives every
booking with a `Booking Result`. Pods/squads still come from the class schedule.

**Billing rule: only `Showed` / `Showed late` count** as a delivered/billable session.
`Booking` (unmarked), `No show`, `Cancelled no Charge`, blank do NOT. `isCheckedIn()` = `/^showed/i`.

**Cancelled/no-show bookings are excluded entirely** from the invoice (`isDead()` filter) — they
don't count as booked, billed, or "not checked in."

**Check-in override:** GymMaster's booking *result* can stay "Booking" even when a client is
checked in (the "Undo Check In" state). Report #9 only exposes the result, so the gm sync
also reads each active member's portal `past` bookings (which carry the real `b.attended` flag)
and PATCHes matching appointment rows to attended. Matching is by synthId (`timeToSec()` converts
portal time to seconds to match report #9). Active members only (can't log in as expired).

**Cancelled-then-rebooked:** report #9 returns two rows for one slot; `resultRank()` keeps the
"Showed" one (Showed > Booking > Cancelled/No-show).

**Trainerize is the authority for coach assignment.** `tz-roster` blob is built from
`/user/getClientList` (verbose) — each client's `details.trainer.firstName` is the coach.
Follow-Up lists every assigned client (in GymMaster or not), cross-referenced to GymMaster by
email for plan + next booking. Non-GM clients get a "Not in GymMaster" chip.

**Follow-Up "booked":** any upcoming personal appointment counts (PT, coaching, appraisal,
assessment, discovery) — not just PT/coaching. Only genuine group/class/gym-only are excluded.

**Invoice specifics:** GST_TRAINERS=['Gavyn','Ethan']; EMPLOYEES=['Laura'] (8% holiday, no GST);
Caron not GST-registered; Scott salaried. Capacity metric on the trainer card: available hours =
contracted − 30min lunch × 5 days (Scott 37.5 → 35). Contractor rate $50/hr. Records tab stores
full itemised line-items and renders them as the ticked session list.

**Milestones reliability (hard-won):** a throttled Trainerize call once looked identical to
"no data" and published zeros — emptying the 1000 Club, blanking members, collapsing weight-loss.
Fixes: failed calendar/summary/bodystat calls are detected (`_failed`) and retried; an empty
response is NOT a failure. **`_snapshot-guard.mjs`** is the last line of defence — published data
can never regress below the last good snapshot (workout counts only go up; transformations can't
evaporate; last-workout dates can't move back). A health banner surfaces degraded runs.
Clubs: 10/50/100/200/400/1000, by lifetime workouts.

**Studio Pulse churn signals** (adaptive-weighted): the biggest is **"paying but not attending"**
(+3.0, no gym visit 21+ days) then "attendance slipping" (+1.5, 10–20 days) — added from exit-survey
analysis (attendance drop → "not worth it" → leave, often to Snap). Exit survey (Google Sheet) is
the calibration source. Next signals to add: results-plateau, coach-leaving flag.

## Tests

`test/appointments.test.mjs`, `test/weight-guards.test.mjs`, `test/milestone-floors.test.mjs`,
`test/snapshot-guard.test.mjs`. Run with `node test/<file>`. Add tests for any billing/churn logic.

## Current open items / context

- Ethan leaves **20 Sep 2026**; his 48 clients are being reassigned (see the reallocation
  spreadsheet). Coach-leaving churn flag not yet built.
- Recalc of xlsx via LibreOffice is slow in the sandbox — prefer Python-computed values for
  one-off reports over live formulas.

## Working-with-Claude tips (to save tokens)

- Start a **new chat per task**; say "read CONTEXT.md in gy-hub and <relevant file>".
- The repo is the source of truth. Update this file when a decision changes.
- Supabase MCP + the GitHub PAT let me query data and push code directly.
