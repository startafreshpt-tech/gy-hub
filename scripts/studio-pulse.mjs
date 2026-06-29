#!/usr/bin/env node
/**
 * studio_pulse_weekly.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Studio Pulse — Weekly Churn Intelligence (Node.js / ESM port)
 * Growing Younger Fitness Studio, NZ
 *
 * Self-contained: Node 18+ only, uses the BUILT-IN global `fetch`. No npm
 * dependencies. Pulls GymMaster + Trainerize LIVE (no CSV/Excel round-trip),
 * scores every member, runs the adaptive-weight learner, and prints the exact
 * churn_data.json shape the Studio Pulse dashboard reads — to stdout, as a
 * single JSON.stringify, so this script can sit behind any scheduler.
 *
 * Run it with:   node studio_pulse_weekly.mjs > churn_data.json
 * or, in a scheduler that captures stdout directly into your DB/storage.
 *
 * This is a line-by-line port of studio_pulse_weekly.py + refresh_trainerize.py.
 * Every formula, weight, and rounding rule below is copied from that source —
 * see "KNOWN ISSUES" further down for two quirks preserved on purpose for
 * exact parity, plus notes on what to fix if you want to improve on it.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * 1. ENDPOINTS + AUTH  (everything this script calls, and how auth works)
 * ═════════════════════════════════════════════════════════════════════════
 *
 * GYMMASTER  (https://growingyounger.gymmasteronline.com)
 * ────────────────────────────────────────────────────────
 *   Auth: header  X-GM-API-KEY: <api key>   on every request. No login step,
 *         no token, no expiry — it's a static API key tied to this studio's
 *         GymMaster account. (GymMaster's API does NOT expose member email
 *         anywhere we could find — every member/person endpoint and all 200+
 *         report IDs were checked. That's why matching to Trainerize below is
 *         done by name, not email.)
 *
 *   POST /api/v2/report/standard_report
 *     Body: { report_id: <int>, start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" }
 *     Used 3x per run, with three different report_id values:
 *       - report_id 1   → full member roster (we default the window to the
 *                          last 60 days; GymMaster's "Report 1" returns
 *                          current + recently-expired members in that window)
 *       - report_id 311 → payment FAILURES (we pass a 7-day window: this run's
 *                          date minus 7 days → today, to catch failures from
 *                          THIS week only)
 *       - report_id 369 → currently-OVERDUE billing (members who owe money
 *                          right now). NOTE: called with the same default
 *                          60-day window as report 1 — this is inherited
 *                          as-is from the Python source; it doesn't restrict
 *                          to "this week," it just reads whatever the report
 *                          returns for a 60-day lookback.
 *     Response shape varies: sometimes a bare array, sometimes
 *     { result: [...] }, sometimes a dict-of-dicts. All three are unwrapped
 *     into a plain array by gmReportAll() below.
 *
 *   GET <path>   (gmGet — defined for completeness, NOT used by run())
 *     Header: X-GM-API-KEY. This is the generic GymMaster GET helper the
 *     Python source also defines but never calls in the weekly run. Kept
 *     here in case you need ad-hoc lookups later.
 *
 * TRAINERIZE  (https://api.trainerize.com/v03)
 * ─────────────────────────────────────────────
 *   Auth: POST user/login once per run → returns a bearer JWT
 *         (response.token.access_token), good for the rest of the run. Every
 *         subsequent Trainerize call sends  Authorization: Bearer <token>.
 *
 *   POST /user/login
 *     Body: { email, password, rememberMe: true, groupUrl }
 *     groupUrl is derived from the studio's Trainerize base_url by stripping
 *     the protocol and taking everything before the first "." — e.g.
 *     "https://startafreshpt.beta.trainerize.com" → groupUrl "startafreshpt".
 *     No auth header needed for this call (it's how you GET the auth header).
 *
 *   POST /User/getClientList     (auth: Bearer token)
 *     Body: { view: "allActive" }
 *     This is the ONLY view value that works for this account — "all",
 *     "inactive", and "archived" all return HTTP 500 (tested directly against
 *     this studio's Trainerize account). allActive returns every currently
 *     active client across all trainers (no per-trainer filtering needed).
 *     Each user record includes: id, firstName, lastName, email,
 *     latestSignedIn, status, trainerID, etc. (Trainerize DOES expose email
 *     here, unlike GymMaster — flagged in KNOWN ISSUES as a future upgrade
 *     path for matching, once GymMaster's side can supply an email too.)
 *
 *   POST /User/getClientSummary  (auth: Bearer token)
 *     Body: { userID: <id>, unitWeight: "kg" }
 *     Called once PER client returned by getClientList (~65-70 calls/run for
 *     this studio). Returns workoutsTotal, workoutsByWeek[] (recent weeks),
 *     and weeklyStats{ lastAppOpen/lastOpenDate, lastActive/lastActivityDate }.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * 2. CHURN-RISK SCORING — every signal, its calculation, and its weight
 * ═════════════════════════════════════════════════════════════════════════
 * Score starts at 0, signals add to it, final score is capped at 10 and
 * rounded to 1 decimal. risk_tier: score>=7 "high", >=4 "medium", else "low".
 *
 *   payment_failed     +2.5   member ID appears in BOTH this-week's failed
 *                              payments (report 311, 7-day window) AND
 *                              currently-overdue (report 369) — i.e. failed
 *                              and still unresolved right now.
 *   billing_overdue     +2.5   member ID is in report 369 but NOT in this
 *                              week's failures — overdue, but not a fresh
 *                              failure this week. (mutually exclusive with
 *                              payment_failed — failed takes priority)
 *   payment_count_low   +0.5   3-5 LIFETIME payment-failure/overdue events
 *   payment_count_mid   +1.0   6-9 lifetime events
 *   payment_count_high  +1.5   10+ lifetime events
 *                              (lifetime count comes from the persisted
 *                              payment_history state — see section 3 — NOT
 *                              from this week's report alone)
 *   expiry_soon         +1.0   membership end date is 1-14 days away
 *                              (days_to_renewal = end_date - today; fires
 *                              only when 0 < days_to_renewal <= 14)
 *   new_member          +0.5   tenure_months < 3
 *                              (tenure_months = floor(days_since_start / 30))
 *   tz_never            +2.0   Trainerize last-sign-in is unparseable/blank
 *                              ("Not yet", "-", or empty) → treated as never
 *                              having logged in. SEE KNOWN ISSUE #1 — this
 *                              also misfires for "Today".
 *   tz_absent_long      +1.5   days since last Trainerize login >= 10
 *   tz_absent_mild      +0.5   days since last Trainerize login 5-9
 *   tz_no_workouts      +1.0   Trainerize workouts/week is "-", "0", or ""
 *
 * Only members successfully 1:1-matched to a Trainerize account (see
 * MATCHING below) get the tz_* signals added — everyone else keeps their
 * GymMaster-only base score as their final score.
 *
 * Tenure / LTV (informational fields, not scoring signals):
 *   tenure_months = floor(days_since_start / 30)
 *   tenure_weeks  = floor(days_since_start / 7)
 *   monthly_value = membership fee, normalised to a monthly figure:
 *                     fee × 52/12 if Price Description contains "week"
 *                     fee × 26/12 if it contains "fortnight"/"bi-week"
 *                     fee as-is otherwise
 *   ltv           = monthly_value × max(1, tenure_days) / 30.44
 *
 * MATCHING (GymMaster ↔ Trainerize):
 *   Key = (first_name.toLowerCase(), lastName[0].toUpperCase()) — e.g.
 *   "Sarah Hill" → ("sarah","H"). A Trainerize client only gets matched to a
 *   GymMaster member if BOTH sides have EXACTLY ONE person under that key
 *   (no matching at all if either side has 2+ people sharing a first-name +
 *   last-initial). This is a known weak point — see KNOWN ISSUES #2.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * 3. ADAPTIVE LEARNING — how weights move, and exactly what state persists
 * ═════════════════════════════════════════════════════════════════════════
 * Every week this script auto-detects churns by diffing this run's active
 * member-ID set against LAST week's saved snapshot (anyone who vanished and
 * isn't already recorded is logged as a new churn event, source:"snapshot").
 * Those events accumulate in `outcomes.outcomes[]` and are the only thing the
 * learner trains on (a separate `source:"historical_gm"` type can exist for
 * manually-seeded historical churns, but the learner explicitly EXCLUDES
 * those — incomplete signal data — only `source==="snapshot"` rows count).
 *
 *   alpha = clamp((n_snapshot_events - 10) / 40, 0, 1)
 *     n_snapshot_events < 10  → alpha = 0   (pure baseline weights, no learning)
 *     n_snapshot_events = 50  → alpha = 1   (pure learned weights)
 *     n_snapshot_events = 30  → alpha = 0.5 (50/50 blend)
 *   This is a slow ramp by design — 10 events is the floor before the model
 *   trusts any signal lift number, 50 events is "fully trust the data."
 *
 * For each weight key (payment_failed, tz_never, etc.), once alpha > 0:
 *   n_with_churn  = how many of the snapshot churn events had that signal in
 *                   their last_signals[] at the moment they were detected
 *   n_with_active = how many of THIS run's currently-active, currently-scored
 *                   clients carry that same signal right now
 *   n_with_total  = n_with_churn + n_with_active
 *     → if n_with_total < 3, skip learning for this key (too little data,
 *       keep the baseline weight for it)
 *   churn_rate_with  = n_with_churn / n_with_total
 *   base_churn_rate  = n_snapshot_events / (current_active_count + n_snapshot_events)
 *   lift             = churn_rate_with / base_churn_rate, clamped to [0.1, 4.0]
 *   learned_weight   = round(baseline_weight × lift, 2)
 *   blended_weight   = round(baseline_weight × (1-alpha) + learned_weight × alpha, 2)
 * The blended weights are what actually get used to (re-)score every member
 * this run, and are stored back into churn_data.learning.weights for the
 * dashboard to display alongside baseline_weight + churn_events_with_signal
 * per signal (see signal_stats in section 4).
 *
 * STATE PERSISTED BETWEEN RUNS — exactly 3 objects. In the original Python
 * these are 3 separate local JSON files; here they're combined into ONE
 * state object so you can store it as a single row/document in a database.
 * loadState() / saveState() below are the ONLY two functions you need to
 * rewire to your DB — everything else is pure computation.
 *
 *   state.outcomes        — churn event history (drives the learner)
 *     {
 *       last_updated: "YYYY-MM-DD",
 *       total_churn_events: <int>,              // outcomes.length
 *       outcomes: [
 *         {
 *           member_id: "<gymmaster id>" | null,  // null only for
 *                                                 // pre-seeded "historical_gm"
 *                                                 // rows you import manually
 *           name: "First Last",
 *           churned_date: "YYYY-MM-DD",
 *           last_risk_score: <number|null>,      // score at moment of churn
 *           last_signals: ["Payment failed", ...],
 *           on_trainerize: <bool|null>,
 *           still_on_trainerize: <bool>,          // computed at detection time
 *           payment_status: "ok"|"failed"|"overdue"|null,
 *           payment_failure_count: <int>,
 *           source: "snapshot" | "historical_gm" | string,
 *           membership_type: "<string>"           // optional, historical_gm only
 *         }, ...
 *       ]
 *     }
 *
 *   state.snapshot         — last run's full member roster, for diffing
 *     {
 *       snapshot_date: "YYYY-MM-DD",
 *       member_count: <int>,
 *       members: {
 *         "<gymmaster member id>": {
 *           name: "First Last",
 *           risk_score: <number>,
 *           signals: ["...", ...],
 *           on_trainerize: <bool>,
 *           payment_status: "ok"|"failed"|"overdue",
 *           payment_failure_count: <int>
 *         }, ...
 *       }
 *     }
 *
 *   state.paymentHistory   — lifetime payment-failure tally per member
 *     {
 *       last_updated: "YYYY-MM-DD",
 *       members: {
 *         "<gymmaster member id>": {
 *           name: "First Last",
 *           total_failures: <int>,    // weeks counted as a fresh failure
 *           total_overdue: <int>,     // weeks counted as overdue-only
 *           failure_weeks: ["YYYY-MM-DD", ...],  // run-dates already
 *                                                 // counted — dedup guard so
 *                                                 // re-running the same week
 *                                                 // doesn't double-count
 *           first_failure: "YYYY-MM-DD"|null,
 *           last_failure: "YYYY-MM-DD"|null
 *         }, ...
 *       }
 *     }
 *
 * Load order each run: loadState() → use outcomes+snapshot+paymentHistory
 * as inputs to detection/scoring/learning → mutate paymentHistory and
 * outcomes in place during the run → build a brand-new `snapshot` from this
 * run's final scored client list → saveState({ outcomes, snapshot, paymentHistory })
 * once, at the very end, right before printing churn_data. If the run throws
 * before reaching saveState, nothing is persisted — next run just re-detects
 * from the same last-good snapshot, so a crashed run is safe to retry.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * 4. DASHBOARD-READ FIELDS — every churn_data.json field consumed by the UI
 * ═════════════════════════════════════════════════════════════════════════
 *   updated                          — ISO timestamp of this run
 *   source                           — "GymMaster (live) + Trainerize (live)"
 *   trainerize_last_refresh          — "YYYY-MM-DD" of this run
 *   learning.total_churn_events      — KPI card
 *   learning.snapshot_events         — used to show learning progress (x/10, x/50)
 *   learning.alpha_blend             — 0..1, shown as learning %
 *   learning.weights                 — current blended weights (for transparency)
 *   learning.signal_stats[key]       — { baseline_weight, learned_weight,
 *                                        churn_events_with_signal } per signal,
 *                                        rendered in a "what's working" panel
 *   summary.active_members           — KPI card
 *   summary.high_risk_count          — KPI card
 *   summary.medium_risk_count        — KPI card
 *   summary.low_risk_count           — KPI card
 *   summary.retention_rate           — KPI card (%)
 *   summary.avg_risk_score           — KPI card
 *   summary.trainerize_connected     — KPI card (# matched)
 *   clients[]                        — the member risk register table; per
 *                                       client: name, initials, member_id,
 *                                       membership_type, risk_score, risk_tier,
 *                                       payment_status, payment_failure_count,
 *                                       days_to_renewal, tenure_months/weeks,
 *                                       monthly_value, ltv, signals[],
 *                                       on_trainerize, trainerize_last_login_days,
 *                                       trainerize_workouts_per_week,
 *                                       trainerize_total_workouts,
 *                                       trainerize_signins_per_week
 *   priority_actions[]               — clients with risk_score >= 4, condensed
 *                                       { name, risk_score, risk_tier, signals,
 *                                         monthly_value }
 *   trainerize_deactivation_alerts[] — the Trainerize-deactivation panel:
 *                                       { member_id, name, churned_date,
 *                                         trainerize_id, last_login, source }
 *                                       source is "snapshot"/"historical_gm"
 *                                       (Method A — already-recorded churns
 *                                       still on Trainerize) or "no_gm_match"
 *                                       (Method B — any Trainerize client with
 *                                       no current GymMaster match at all,
 *                                       catches people who left BEFORE the
 *                                       snapshot system started tracking them)
 *   payment_history_summary          — the cumulative payment-failure tracker:
 *                                       { members_tracked, chronic_3plus,
 *                                         chronic_6plus, chronic_10plus,
 *                                         last_updated }
 *   revenue_at_risk.monthly/.annual  — KPI cards (sum of monthly_value for
 *                                       every client scoring >= 4)
 *
 * ═════════════════════════════════════════════════════════════════════════
 * 5. RATE LIMITS, CALL COUNT, RUNTIME
 * ═════════════════════════════════════════════════════════════════════════
 *   GymMaster:   3 calls total (report 1, 311, 369). GymMaster doesn't
 *                document a rate limit for this endpoint; 3 calls/run is a
 *                non-issue either way.
 *   Trainerize:  1 login + 1 getClientList + 1 getClientSummary PER CLIENT
 *                (~65-70 clients for this studio) ≈ 67-72 calls/run. The
 *                original Python throttles getClientSummary calls with a
 *                150ms sleep between each (no documented Trainerize rate
 *                limit, but this keeps the run polite) — reproduced below
 *                via `await sleep(150)`.
 *   Total:       ~70-75 HTTP requests/run.
 *   Runtime:     dominated by the Trainerize summary loop: ~70 calls ×
 *                (150ms throttle + ~150-400ms actual request) ≈ 25-40s,
 *                plus a few seconds for the 3 GymMaster calls and the
 *                Trainerize login/list. Expect roughly 35-60 seconds
 *                end-to-end on a normal connection.
 *   Resilience:  fetchJsonWithRetry() below retries on HTTP 429/5xx and on
 *                network errors, with exponential backoff (up to 3 retries).
 *                This is an ADDITION over the Python source (which has no
 *                retry logic) — added because this script is meant to run
 *                fully unattended on a schedule, where a single transient
 *                blip shouldn't fail the whole week's refresh.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * KNOWN ISSUES — preserved on purpose for exact parity with the dashboard
 * you're running today. Flagging so you can decide whether to fix them.
 * ═════════════════════════════════════════════════════════════════════════
 *   #1  daysSince(dateStr) special-cases "Yesterday" and anything containing
 *       "hour"/"minute"/"second", but NOT the string "Today" — so a member
 *       who logged into Trainerize earlier TODAY falls through to the
 *       "DD Mon YYYY" parse attempt, fails it, and returns null → which
 *       triggers tz_never ("Never logged into Trainerize") even though they
 *       used the app an hour ago. This is a real bug in the Python source,
 *       reproduced here byte-for-byte. One-line fix, if you want it: add
 *         if (s.toLowerCase() === 'today') return 0;
 *       right after the "yesterday" check in daysSince().
 *   #2  Matching is first-name + last-initial only, and only fires when
 *       BOTH sides have exactly one person under that key. Two "Sarah H"s
 *       (e.g. Sarah Hill + Sarah Henderson) on either system silently get
 *       NO match at all, for either of them. GymMaster's API does not
 *       expose member email on any endpoint we could find (exhaustively
 *       checked this account's report list and member/person endpoints), so
 *       there is currently no way to do this by email. Trainerize's
 *       getClientList DOES return an email field per client — if GymMaster
 *       support can ever expose member email (e.g. via a custom report
 *       field), that's the upgrade path. Until then, consider fuzzy name
 *       matching (e.g. also try last-name + first-initial, or full
 *       Levenshtein distance) as a lower-effort improvement.
 *   #3  Report 369 (currently-overdue billing) is called with no explicit
 *       date range, so it falls back to the default 60-day window rather
 *       than being a true "who owes money right now, no time bound" call.
 *       Preserved exactly as the Python source has it.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — env vars override these; defaults match this studio's current
// credentials so the script runs out of the box. For anything beyond a
// private, single-operator setup, set these via env vars / a secrets
// manager instead of leaving real credentials in source.
// ═══════════════════════════════════════════════════════════════════════════
const GM_API_KEY = process.env.GM_API_KEY;
const GM_BASE    = process.env.GM_BASE || 'https://growingyounger.gymmasteronline.com';

const TZ_API_BASE = 'https://api.trainerize.com/v03';
const TRAINERIZE_CREDS = {
  email:    process.env.TZ_EMAIL,
  password: process.env.TZ_PASSWORD,
  base_url: process.env.TZ_BASE_URL || 'https://startafreshpt.beta.trainerize.com',
};
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_H = (x={}) => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...x });
const ISO = () => new Date().toISOString().slice(0,10);

// File-based default state store — DATABASE SWAP POINT is loadState()/saveState()
// below. Everything else in this script only ever talks to those two functions,
// never to the filesystem directly, so swapping them for DB calls is a clean cut.
const STATE_DIR = process.env.STUDIO_PULSE_STATE_DIR || process.cwd();
const OUTCOMES_PATH = path.join(STATE_DIR, 'churn_outcomes.json');
const SNAPSHOT_PATH = path.join(STATE_DIR, 'member_snapshot.json');
const PAYHIST_PATH  = path.join(STATE_DIR, 'payment_history.json');

// ═══════════════════════════════════════════════════════════════════════════
// BASELINE SCORING WEIGHTS — blended with learned weights once enough
// churn events have accumulated (see section 3 above).
// ═══════════════════════════════════════════════════════════════════════════
const BASELINE_WEIGHTS = {
  payment_failed:      2.5,
  billing_overdue:     2.5,
  tz_never:            2.0,
  tz_absent_long:      1.5,  // no Trainerize login 10+ days
  tz_absent_mild:      0.5,  // no Trainerize login 5-9 days
  tz_no_workouts:      1.0,
  habits_not_tracked:  1.0,   // not ticking any Trainerize habits (engagement gap)
  expiry_soon:         1.0,
  new_member:          0.5,
  payment_count_low:   0.5,  // 3-5 lifetime failures
  payment_count_mid:   1.0,  // 6-9 lifetime failures
  payment_count_high:  1.5,  // 10+ lifetime failures
};

/** Map a signal string back to its BASELINE_WEIGHTS key, or null. */
function signalToKey(sig) {
  const s = String(sig).toLowerCase();
  if (s.includes('payment failed'))      return 'payment_failed';
  if (s.includes('billing overdue'))     return 'billing_overdue';
  if (s.includes('never logged'))        return 'tz_never';
  if (s.includes('no trainerize login')) return 'tz_absent_long';
  if (s.includes('trainerize login'))    return 'tz_absent_mild';
  if (s.includes('zero workouts'))       return 'tz_no_workouts';
  if (s.includes('habits'))              return 'habits_not_tracked';
  if (s.includes('expiry'))              return 'expiry_soon';
  if (s.includes('new member'))          return 'new_member';
  if (s.includes('missed payments')) {
    const n = parseInt(s.split(/\s+/)[0], 10);
    const nn = Number.isFinite(n) ? n : 0;
    if (nn >= 10) return 'payment_count_high';
    if (nn >= 6)  return 'payment_count_mid';
    return 'payment_count_low';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DATE / NUMBER HELPERS  (calendar-day arithmetic, matching Python's date math)
// ═══════════════════════════════════════════════════════════════════════════
function toLocalDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function daysBetween(a, b) {
  // (a - b) in whole calendar days, both normalised to local midnight first.
  const MS_DAY = 86400000;
  return Math.round((toLocalDateOnly(a) - toLocalDateOnly(b)) / MS_DAY);
}
function addDays(d, n) {
  const r = toLocalDateOnly(d);
  r.setDate(r.getDate() + n);
  return r;
}
function todayStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseDDMonYYYY(s) {
  const m = String(s).trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monIdx = MONTHS.indexOf(m[2].toLowerCase());
  const year = parseInt(m[3], 10);
  if (monIdx === -1) return null;
  return new Date(year, monIdx, day);
}

function parseEpoch(val) {
  // GymMaster's "sorted_Membership Start/End Date" fields are unix epoch
  // seconds. Python's date.fromtimestamp() converts to a LOCAL calendar date
  // — we mirror that by multiplying to ms and taking local y/m/d.
  if (!val) return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return toLocalDateOnly(new Date(n * 1000));
}

function makeKey(first, last) {
  const f = String(first || '').toLowerCase();
  const li = last && String(last).length ? String(last)[0].toUpperCase() : '';
  return `${f}|${li}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// FETCH HELPERS — retry/backoff added for unattended scheduled runs (the
// Python source has no retry logic; this is the one behavioural addition).
// ═══════════════════════════════════════════════════════════════════════════
async function fetchJsonWithRetry(url, options = {}, { retries = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after')) || 0;
          const wait = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
          await sleep(wait);
          continue;
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} — ${text.slice(0, 300)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── GymMaster ────────────────────────────────────────────────────────────
async function gmGet(pathSuffix) {
  // Documented for completeness — not called by run() (matches Python source,
  // which defines gm_get() but never uses it in the weekly job).
  return fetchJsonWithRetry(`${GM_BASE}${pathSuffix}`, {
    headers: { 'X-GM-API-KEY': GM_API_KEY, Accept: 'application/json' },
  });
}

async function gmReportRaw(reportId, startDate, endDate) {
  return fetchJsonWithRetry(`${GM_BASE}/api/v2/report/standard_report`, {
    method: 'POST',
    headers: {
      'X-GM-API-KEY': GM_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ report_id: reportId, start_date: startDate, end_date: endDate }),
  });
}

/** Calls gmReportRaw and unwraps whatever shape (array / {result:[]} / dict-of-dicts) into a plain array. */
async function gmReportAll(reportId, startDate, endDate) {
  const resp = await gmReportRaw(reportId, startDate, endDate);
  let raw = Array.isArray(resp) ? resp : (resp && resp.result !== undefined ? resp.result : resp);
  if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = Object.values(raw);
  return Array.isArray(raw) ? raw : [];
}

// ── Trainerize ───────────────────────────────────────────────────────────
async function tzLogin(creds) {
  const groupUrl = String(creds.base_url || '')
    .replace(/^https?:\/\//, '')
    .split('.')[0];
  const resp = await fetchJsonWithRetry(`${TZ_API_BASE}/user/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: creds.email,
      password: creds.password,
      rememberMe: true,
      groupUrl,
    }),
  });
  const token = resp && resp.token && resp.token.access_token;
  if (!token) throw new Error(`Trainerize login failed: ${JSON.stringify(resp && resp.message ? resp.message : resp)}`);
  return token;
}

async function tzGetClientList(token) {
  const resp = await fetchJsonWithRetry(`${TZ_API_BASE}/User/getClientList`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ view: 'allActive' }),
  });
  const raw = resp && resp.Response !== undefined ? resp.Response : resp;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return raw.users || Object.values(raw);
  return [];
}

async function tzGetClientSummary(token, userId) {
  const resp = await fetchJsonWithRetry(`${TZ_API_BASE}/User/getClientSummary`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ userID: userId, unitWeight: 'kg' }),
  });
  return resp && resp.Response !== undefined ? resp.Response : resp;
}

/** Mirrors refresh_trainerize.py's _days_ago_str(). */
function daysAgoStr(ds, today) {
  if (!ds) return 'Not yet';
  const s = String(ds).slice(0, 10);
  const d = parseISODateOnly(s);
  if (!d) return s || 'Not yet';
  const delta = daysBetween(today, d);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Yesterday';
  return formatDDMonYYYY(d);
}
function parseISODateOnly(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}
function formatDDMonYYYY(d) {
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Logs in, fetches the full active client list, then fetches a summary per
 * client (throttled). Returns a Map keyed by makeKey(first,last) →
 * array of { full_name, trainerize_id, last_signin, last_app_open,
 * last_active, signins_per_week, workouts_per_week, total_workouts } —
 * the same shape parse_trainerize() built from the CSV in the Python source.
 */
async function fetchTrainerizeMap(creds, today) {
  console.error('  Logging into Trainerize API...');
  const token = await tzLogin(creds);
  console.error('  Authenticated. Fetching all active clients...');
  const users = await tzGetClientList(token);
  console.error(`  -> ${users.length} Trainerize clients found. Fetching workout summaries...`);

  const tzMap = new Map();
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const first = u.firstName || '';
    const last = u.lastName || '';
    const fullName = `${first} ${last}`.trim();
    const lastSignin = daysAgoStr(u.latestSignedIn, today);

    let workoutsTotal = 0;
    let wpw = 0;
    let lastApp = 'Not yet';
    let lastActive = 'Not yet';
    let habitsDone = 0;
    try {
      const s = await tzGetClientSummary(token, u.id);
      workoutsTotal = (s && s.workoutsTotal) || 0;
      const workoutsByWeek = (s && s.workoutsByWeek) || [];
      const recent = workoutsByWeek.filter(w => typeof w === 'number');
      wpw = recent.length ? round1(recent.reduce((a, b) => a + b, 0) / recent.length) : 0;
      const ws = (s && s.weeklyStats) || {};
      lastApp = daysAgoStr(ws.lastAppOpen ?? ws.lastOpenDate, today);
      lastActive = daysAgoStr(ws.lastActive ?? ws.lastActivityDate, today);
      const wkArr = Array.isArray(s && s.weeklyStats) ? s.weeklyStats : [];
      habitsDone = wkArr.slice(-5).reduce((a, wk) => a + (Number(wk && wk.habitsCompleted) || 0), 0);
    } catch (e) {
      // Matches Python's bare except in refresh_trainerize.py: keep going
      // with defaults rather than aborting the whole run for one client.
      workoutsTotal = 0; wpw = 0; lastApp = 'Not yet'; lastActive = 'Not yet'; habitsDone = 0;
    }

    if (fullName) {
      const parts = fullName.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        const key = makeKey(parts[0], parts[parts.length - 1]);
        if (!tzMap.has(key)) tzMap.set(key, []);
        tzMap.get(key).push({
          full_name: fullName,
          trainerize_id: String(u.id),
          last_signin: lastSignin,
          last_app_open: lastApp,
          last_active: lastActive,
          signins_per_week: '-',
          workouts_per_week: wpw ? String(wpw) : '-',
          total_workouts: String(workoutsTotal),
          habits_tracked: habitsDone > 0,
        });
      }
    }

    if ((i + 1) % 10 === 0) console.error(`    ...${i + 1}/${users.length}`);
    await sleep(150); // gentle rate limiting — matches refresh_trainerize.py's time.sleep(0.15)
  }
  return tzMap;
}

// ═══════════════════════════════════════════════════════════════════════════
// GYMMASTER SCORING
// ═══════════════════════════════════════════════════════════════════════════
function scoreGmMember(m, failedIds, missedIds, weights, paymentHistory, today) {
  const w = weights || BASELINE_WEIGHTS;
  const mid = String(m['Member ID'] ?? '').trim();
  let score = 0;
  const signals = [];

  let payStatus = 'ok';
  if (failedIds.has(mid)) {
    score += w.payment_failed; payStatus = 'failed'; signals.push('Payment failed');
  } else if (missedIds.has(mid)) {
    score += w.billing_overdue; payStatus = 'overdue'; signals.push('Billing overdue');
  }

  const payCount = paymentHistory ? getPaymentCount(paymentHistory, mid) : 0;
  if (payCount >= 10) {
    score += w.payment_count_high ?? 1.5; signals.push(`${payCount} missed payments (critical)`);
  } else if (payCount >= 6) {
    score += w.payment_count_mid ?? 1.0; signals.push(`${payCount} missed payments`);
  } else if (payCount >= 3) {
    score += w.payment_count_low ?? 0.5; signals.push(`${payCount} missed payments`);
  }

  const endDate = parseEpoch(m['sorted_Membership End Date']);
  let daysToRenewal = null;
  if (endDate) {
    daysToRenewal = daysBetween(endDate, today);
    if (daysToRenewal > 0 && daysToRenewal <= 14) {
      score += w.expiry_soon; signals.push(`Expiry in ${daysToRenewal}d`);
    }
  }

  const startDate = parseEpoch(m['sorted_Membership Start Date']);
  const tenureDaysRaw = startDate ? daysBetween(today, startDate) : 0;
  const tenureMonths = startDate ? Math.max(0, Math.floor(tenureDaysRaw / 30)) : 0;
  const tenureWeeks  = startDate ? Math.max(0, Math.floor(tenureDaysRaw / 7))  : 0;
  if (tenureMonths < 3) {
    score += w.new_member; signals.push('New member');
  }

  const feeStr = String(m['Membership Fee'] ?? '').replace(/\$/g, '').replace(/,/g, '').trim();
  let fee = parseFloat(feeStr);
  if (!Number.isFinite(fee)) fee = 0;
  const desc = String(m['Price Description'] ?? '').toLowerCase();
  let monthly;
  if (desc.includes('week')) monthly = round2(fee * 52 / 12);
  else if (desc.includes('fortnight') || desc.includes('bi-week')) monthly = round2(fee * 26 / 12);
  else monthly = round2(fee);

  const tenureDays = startDate ? tenureDaysRaw : 0;
  const ltv = round2(monthly * Math.max(1, tenureDays) / 30.44);

  const nameRaw = String(m['Member Name'] ?? m['First Name'] ?? '').trim();
  let firstPart, lastPart;
  if (nameRaw.includes(',')) {
    const idx = nameRaw.indexOf(',');
    lastPart = nameRaw.slice(0, idx).trim();
    const firstRest = nameRaw.slice(idx + 1).trim();
    firstPart = firstRest ? firstRest.split(/\s+/)[0] : '?';
  } else {
    const parts = nameRaw.split(/\s+/).filter(Boolean);
    firstPart = parts[0] || '?';
    lastPart = parts.length > 1 ? parts[parts.length - 1] : '';
  }
  const first = firstPart || '?';
  const lastI = lastPart ? lastPart[0].toUpperCase() : '?';
  const name = lastPart ? `${first} ${lastPart}` : first;
  const initials = (first && first !== '?') ? (first[0] + lastI).toUpperCase() : '??';

  const riskScore = round1(Math.min(10, score));

  return {
    name, initials, member_id: mid,
    membership_type: m['Membership Description'] ?? '',
    base_score: riskScore,
    risk_score: riskScore,
    risk_tier: riskScore >= 7 ? 'high' : riskScore >= 4 ? 'medium' : 'low',
    payment_status: payStatus,
    payment_failure_count: paymentHistory ? payCount : 0,
    days_to_renewal: daysToRenewal,
    tenure_months: tenureMonths,
    tenure_weeks: tenureWeeks,
    monthly_value: monthly,
    ltv,
    signals,
    action_note: '',
    on_trainerize: false,
    trainerize_last_login_days: null,
    trainerize_workouts_per_week: null,
    trainerize_total_workouts: null,
    trainerize_signins_per_week: null,
    days_absent: null,
    sessions_this_month: null,
    sessions_last_month: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TRAINERIZE SIGNAL ADDITION
// ═══════════════════════════════════════════════════════════════════════════
function daysSince(dateStr, today) {
  const s = String(dateStr || '').trim();
  if (!s || ['not yet', '-', ''].includes(s.toLowerCase())) return null;
  if (/hour|minute|second/i.test(s)) return 0;
  if (s.toLowerCase() === 'yesterday') return 1;
  if (s.toLowerCase() === 'today') return 0;   // FIX: members who signed in
  // today were wrongly returning null here (Python-quirk port), which fired
  // the tz_never "Never logged into Trainerize" signal on the MOST active
  // members. "Today" now correctly counts as 0 days since last login.
  const parsed = parseDDMonYYYY(s);
  if (!parsed) return null;
  return daysBetween(today, parsed);
}

function addTrainerizeSignals(client, tz, weights, today) {
  const w = weights || BASELINE_WEIGHTS;
  const d = daysSince(tz.last_signin, today);
  let added = 0;
  const signals = [];

  if (d === null) {
    added += w.tz_never; signals.push('Never logged into Trainerize');
  } else if (d >= 10) {
    added += w.tz_absent_long; signals.push(`No Trainerize login ${d}d`);
  } else if (d >= 5) {
    added += w.tz_absent_mild; signals.push(`Trainerize login ${d}d ago`);
  }

  const wpw = tz.workouts_per_week;
  if (wpw === '-' || wpw === '0' || wpw === '') {
    added += w.tz_no_workouts; signals.push('Zero workouts logged');
  }

  if (tz.habits_tracked === false) {
    added += w.habits_not_tracked; signals.push('No habits tracked');
  }
  client.habits_tracked = tz.habits_tracked === true;

  client.on_trainerize = true;
  client.trainerize_last_login_days = d;
  client.trainerize_workouts_per_week = tz.workouts_per_week;
  client.trainerize_signins_per_week = tz.signins_per_week;

  let actualVal = null;
  const actualTotal = tz.total_workouts;
  if (actualTotal !== undefined && actualTotal !== null && actualTotal !== '' && actualTotal !== '-') {
    const n = parseInt(actualTotal, 10);
    if (Number.isFinite(n)) actualVal = n;
  }
  if (actualVal !== null) {
    client.trainerize_total_workouts = actualVal;
  } else {
    let wpwVal = 0;
    if (wpw !== '-' && wpw !== '' && wpw !== '0') {
      const f = parseFloat(wpw);
      wpwVal = Number.isFinite(f) ? f : 0;
    }
    const tw = client.tenure_weeks || 0;
    client.trainerize_total_workouts = (wpwVal > 0 && tw > 0) ? Math.round(wpwVal * tw) : null;
  }

  const newScore = round1(Math.min(10, client.base_score + added));
  client.risk_score = newScore;
  client.risk_tier = newScore >= 7 ? 'high' : newScore >= 4 ? 'medium' : 'low';
  client.signals = [...(client.signals || []), ...signals];
  return client;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHURN OUTCOME TRACKING & WEIGHT LEARNING
// ═══════════════════════════════════════════════════════════════════════════
function detectAndLogChurns(prevSnapshot, currentMembers, outcomesState, tzMap, today) {
  if (!prevSnapshot) return 0;
  const currentIds = new Set(
    currentMembers
      .map(c => String(c.member_id ?? c['Member ID'] ?? '').trim())
      .filter(Boolean)
  );
  const prevMembers = prevSnapshot.members || {};
  const existingIds = new Set(outcomesState.outcomes.map(o => o.member_id));
  let newChurns = 0;

  for (const [mid, info] of Object.entries(prevMembers)) {
    if (!currentIds.has(mid) && !existingIds.has(mid)) {
      const name = info.name || '?';
      let stillTz = false;
      if (tzMap) {
        const parts = name.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          const key = makeKey(parts[0], parts[parts.length - 1]);
          const list = tzMap.get(key);
          stillTz = !!(list && list.length);
        }
      }
      outcomesState.outcomes.push({
        member_id: mid,
        name,
        churned_date: todayStr(today),
        last_risk_score: info.risk_score ?? null,
        last_signals: info.signals || [],
        on_trainerize: info.on_trainerize ?? null,
        still_on_trainerize: stillTz,
        payment_status: info.payment_status ?? null,
        payment_failure_count: info.payment_failure_count ?? 0,
        source: 'snapshot',
      });
      newChurns++;
    }
  }
  return newChurns;
}

function computeLearnedWeights(outcomesState, currentClients) {
  const snapshotOutcomes = outcomesState.outcomes.filter(
    o => o.source === 'snapshot' && o.last_signals != null
  );
  const n = snapshotOutcomes.length;
  const alpha = Math.min(1, Math.max(0, (n - 10) / 40));

  if (alpha === 0) {
    return { weights: { ...BASELINE_WEIGHTS }, nSnapshot: n, alpha: 0 };
  }

  const churnSignalCounts = {};
  const activeSignalCounts = {};
  for (const k of Object.keys(BASELINE_WEIGHTS)) {
    churnSignalCounts[k] = 0;
    activeSignalCounts[k] = 0;
  }
  for (const o of snapshotOutcomes) {
    for (const sig of (o.last_signals || [])) {
      const k = signalToKey(sig);
      if (k) churnSignalCounts[k]++;
    }
  }
  for (const c of currentClients) {
    for (const sig of (c.signals || [])) {
      const k = signalToKey(sig);
      if (k) activeSignalCounts[k]++;
    }
  }

  const baseChurnRate = n / Math.max(1, currentClients.length + n);

  const learned = {};
  for (const [key, baseline] of Object.entries(BASELINE_WEIGHTS)) {
    const nChurn = churnSignalCounts[key];
    const nActive = activeSignalCounts[key];
    const nTotal = nChurn + nActive;
    if (nTotal < 3) { learned[key] = baseline; continue; }
    const churnRateWith = nChurn / nTotal;
    let lift = baseChurnRate > 0 ? churnRateWith / baseChurnRate : 1.0;
    lift = Math.max(0.1, Math.min(4.0, lift));
    const learnedW = round2(baseline * lift);
    const blended = round2(baseline * (1 - alpha) + learnedW * alpha);
    learned[key] = blended;
  }

  return { weights: learned, nSnapshot: n, alpha: round2(alpha) };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT HISTORY TRACKING — lifetime cumulative failure/overdue counts
// ═══════════════════════════════════════════════════════════════════════════
function updatePaymentHistory(ph, weekFailedIds, weekOverdueIds, rawMembers, today) {
  const weekStr = todayStr(today);
  const nameLookup = new Map();
  for (const m of rawMembers) {
    const mid = String(m['Member ID'] ?? '').trim();
    if (mid) nameLookup.set(mid, m);
  }
  const flaggedIds = new Set([...weekFailedIds, ...weekOverdueIds]);
  for (const mid of flaggedIds) {
    if (!mid) continue;
    if (!ph.members[mid]) {
      ph.members[mid] = {
        name: '', total_failures: 0, total_overdue: 0,
        failure_weeks: [], first_failure: null, last_failure: null,
      };
    }
    const rec = ph.members[mid];
    if (nameLookup.has(mid)) {
      const m = nameLookup.get(mid);
      const raw = String(m['Member Name'] ?? '').trim();
      if (raw.includes(',')) {
        const idx = raw.indexOf(',');
        const lp = raw.slice(0, idx).trim();
        const fp = raw.slice(idx + 1).trim();
        rec.name = fp ? `${fp.split(/\s+/)[0]} ${lp}` : raw;
      } else {
        rec.name = raw;
      }
    }
    if (!rec.failure_weeks.includes(weekStr)) {
      rec.failure_weeks.push(weekStr);
      if (weekFailedIds.has(mid)) rec.total_failures = (rec.total_failures || 0) + 1;
      else rec.total_overdue = (rec.total_overdue || 0) + 1;
      rec.last_failure = weekStr;
      if (!rec.first_failure) rec.first_failure = weekStr;
    }
  }
  return ph;
}

function getPaymentCount(ph, mid) {
  const rec = (ph.members && ph.members[String(mid)]) || {};
  return (rec.total_failures || 0) + (rec.total_overdue || 0);
}

function countChronic(ph, n) {
  return Object.values(ph.members).filter(
    m => (m.total_failures || 0) + (m.total_overdue || 0) >= n
  ).length;
}

function buildSnapshot(clients, today) {
  const members = {};
  for (const c of clients) {
    if (!c.member_id) continue;
    members[c.member_id] = {
      name: c.name,
      risk_score: c.risk_score,
      signals: c.signals,
      on_trainerize: c.on_trainerize,
      payment_status: c.payment_status,
      payment_failure_count: c.payment_failure_count ?? 0,
    };
  }
  return { snapshot_date: todayStr(today), member_count: clients.length, members };
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE LOAD/SAVE  ←  THE ONLY TWO FUNCTIONS TO REWIRE FOR YOUR DATABASE
// ═══════════════════════════════════════════════════════════════════════════
async function readJsonOrDefault(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function loadState(today) {
  // ⬇⬇⬇ DATABASE SWAP POINT ⬇⬇⬇
  // Replace the three reads below with e.g.:
  //   const outcomes      = await db.get('studio_pulse_state', 'outcomes')      ?? defaultOutcomes;
  //   const snapshot       = await db.get('studio_pulse_state', 'snapshot')      ?? null;
  //   const paymentHistory = await db.get('studio_pulse_state', 'paymentHistory') ?? defaultPaymentHistory;
  // The shapes of all three are documented in full at the top of this file
  // (section 3 — "STATE PERSISTED BETWEEN RUNS").
  const defaultOutcomes = { last_updated: todayStr(today), total_churn_events: 0, outcomes: [] };
  const defaultPaymentHistory = { last_updated: todayStr(today), members: {} };

  let st = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/invoices?select=raw_text&source=eq.studio-pulse-state&order=created_at.desc&limit=1`, { headers: SB_H() });
    const j = await r.json();
    if (Array.isArray(j) && j[0] && j[0].raw_text) st = JSON.parse(j[0].raw_text);
  } catch (e) { st = null; }
  return {
    outcomes:       (st && st.outcomes)       || defaultOutcomes,
    snapshot:       (st && st.snapshot)        || null,
    paymentHistory: (st && st.paymentHistory)  || defaultPaymentHistory,
  };
}

async function saveState({ outcomes, snapshot, paymentHistory }) {
  // ⬇⬇⬇ DATABASE SWAP POINT ⬇⬇⬇
  // Replace the three writes below with e.g.:
  //   await db.upsert('studio_pulse_state', 'outcomes', outcomes);
  //   await db.upsert('studio_pulse_state', 'snapshot', snapshot);
  //   await db.upsert('studio_pulse_state', 'paymentHistory', paymentHistory);
  const body = JSON.stringify({ trainer_name:'__studiopulse_state__', period_start:ISO(), period_end:ISO(), source:'studio-pulse-state', status:'state', raw_text: JSON.stringify({ outcomes, snapshot, paymentHistory }), created_by:'weekly-sync' });
  await fetch(`${SUPABASE_URL}/rest/v1/invoices?source=eq.studio-pulse-state`, { method:'DELETE', headers: SB_H({ Prefer:'return=minimal' }) });
  await fetch(`${SUPABASE_URL}/rest/v1/invoices`, { method:'POST', headers: SB_H({ 'Content-Type':'application/json', Prefer:'return=minimal' }), body });
}

// ═══════════════════════════════════════════════════════════════════════════
// GYMMASTER MEMBER FETCH/DEDUPE
// ═══════════════════════════════════════════════════════════════════════════
function defaultStart(today) { return todayStr(addDays(today, -60)); }

function dedupeAndFilterExpired(raw, today) {
  const seen = new Set();
  const members = [];
  for (const m of raw) {
    const mid = String(m['Member ID'] ?? '').trim();
    if (!mid || seen.has(mid)) continue;
    const endEpoch = m['sorted_Membership End Date'];
    if (endEpoch) {
      const endDate = parseEpoch(endEpoch);
      if (endDate && endDate < today) continue; // membership expired — exclude
    }
    seen.add(mid);
    members.push(m);
  }
  return members;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function run() {
  const today = toLocalDateOnly(new Date());
  console.error(`Studio Pulse (Node) running — ${todayStr(today)}`);

  const { outcomes: outcomesState, snapshot: prevSnapshot, paymentHistory } = await loadState(today);

  // 1. Trainerize — login + client list + per-client summaries (live, no CSV)
  console.error('  Refreshing Trainerize data...');
  const tzMap = await fetchTrainerizeMap(TRAINERIZE_CREDS, today);
  const tzClientCount = [...tzMap.values()].reduce((a, l) => a + l.length, 0);
  console.error(`  -> ${tzClientCount} Trainerize clients loaded`);

  // 2. GymMaster active members (Report 1)
  console.error('  Fetching GymMaster current members...');
  const rawMembers = await gmReportAll(1, defaultStart(today), todayStr(today));
  const members = dedupeAndFilterExpired(rawMembers, today);
  console.error(`  -> ${members.length} active members (expired excluded)`);

  // 3. Payment data — Report 311 (this week's failures), Report 369 (overdue)
  console.error('  Fetching payment data...');
  const weekStart = todayStr(addDays(today, -7));
  const todayS = todayStr(today);

  let weekFailedIds = new Set();
  try {
    const failedRaw = await gmReportAll(311, weekStart, todayS);
    weekFailedIds = new Set(failedRaw.map(m => String(m['Member ID'] ?? '').trim()).filter(Boolean));
  } catch (e) {
    console.error(`  Warning: Failed payments (live) report error: ${e.message}`);
  }

  let weekOverdueIds = new Set();
  try {
    const overdueRaw = await gmReportAll(369, defaultStart(today), todayS);
    weekOverdueIds = new Set(overdueRaw.map(m => String(m['Member ID'] ?? '').trim()).filter(Boolean));
  } catch (e) {
    console.error(`  Warning: Overdue billing report error: ${e.message}`);
  }

  const failedIds = new Set([...weekFailedIds].filter(id => weekOverdueIds.has(id))); // failed AND unresolved
  const missedIds = new Set([...weekOverdueIds].filter(id => !weekFailedIds.has(id))); // overdue, not a new failure
  console.error(`  -> Live failed (unresolved): ${failedIds.size}, Overdue: ${missedIds.size}`);

  updatePaymentHistory(paymentHistory, weekFailedIds, weekOverdueIds, rawMembers, today);
  const chronic3 = countChronic(paymentHistory, 3);
  console.error(`  -> Payment history: ${Object.keys(paymentHistory.members).length} tracked, ${chronic3} with 3+ lifetime events`);

  // 4. Detect churns vs last run's snapshot (needs tzMap for still_on_trainerize)
  const newChurns = detectAndLogChurns(prevSnapshot, members, outcomesState, tzMap, today);
  outcomesState.total_churn_events = outcomesState.outcomes.length;
  outcomesState.last_updated = todayStr(today);
  if (newChurns) console.error(`  ! ${newChurns} new churn(s) detected since last run`);
  else console.error(`  Churn outcomes: ${outcomesState.total_churn_events} total recorded`);

  // 5. Score with baseline weights first (learner needs active-signal counts)
  const clientsBaseline = members.map(m =>
    scoreGmMember(m, failedIds, missedIds, BASELINE_WEIGHTS, paymentHistory, today)
  );

  // 6. Compute learned weights, re-score if alpha > 0
  const { weights, nSnapshot, alpha } = computeLearnedWeights(outcomesState, clientsBaseline);
  let clients;
  if (alpha > 0) {
    console.error(`  Learning: ${nSnapshot} snapshot events, blend alpha=${alpha} (weights adapting)`);
    clients = members.map(m => scoreGmMember(m, failedIds, missedIds, weights, paymentHistory, today));
  } else {
    console.error(`  Learning: ${nSnapshot} snapshot events (need 10+ to adapt weights)`);
    clients = clientsBaseline;
  }

  // 7. Match Trainerize engagement data onto scored GymMaster clients
  const gmKeyMap = new Map();
  for (const c of clients) {
    const parts = c.name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const key = makeKey(parts[0], parts[parts.length - 1]);
      if (!gmKeyMap.has(key)) gmKeyMap.set(key, []);
      gmKeyMap.get(key).push(c);
    }
  }
  let matched = 0;
  for (const [key, tzList] of tzMap.entries()) {
    const gmList = gmKeyMap.get(key) || [];
    if (gmList.length === 1 && tzList.length === 1) {
      addTrainerizeSignals(gmList[0], tzList[0], weights, today);
      matched++;
    }
  }
  console.error(`  Trainerize: ${matched} clients matched`);

  // 8. Trainerize deactivation alerts — Method A (outcome-based) + Method B
  //    (no current GymMaster match at all — catches pre-snapshot leavers)
  const tzAlerts = [];
  const seenTzIds = new Set();

  for (const o of outcomesState.outcomes) {
    const name = o.name || '?';
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const key = makeKey(parts[0], parts[parts.length - 1]);
      const list = tzMap.get(key);
      if (list && list.length) {
        const tzEntry = list[0];
        if (!seenTzIds.has(tzEntry.trainerize_id)) {
          tzAlerts.push({
            member_id: o.member_id ?? null,
            name,
            churned_date: o.churned_date ?? null,
            trainerize_id: tzEntry.trainerize_id,
            last_login: tzEntry.last_signin,
            source: o.source || 'unknown',
          });
          seenTzIds.add(tzEntry.trainerize_id);
        }
      }
    }
  }
  for (const [key, tzList] of tzMap.entries()) {
    for (const tzEntry of tzList) {
      if (seenTzIds.has(tzEntry.trainerize_id)) continue;
      if (!gmKeyMap.has(key)) {
        tzAlerts.push({
          member_id: null,
          name: tzEntry.full_name,
          churned_date: null,
          trainerize_id: tzEntry.trainerize_id,
          last_login: tzEntry.last_signin,
          source: 'no_gm_match',
        });
        seenTzIds.add(tzEntry.trainerize_id);
      }
    }
  }
  if (tzAlerts.length) {
    console.error(`  ! ${tzAlerts.length} member(s) need Trainerize deactivation`);
  } else {
    console.error('  Trainerize deactivation: none needed');
  }

  // 9. Build this run's snapshot for next run's churn detection
  const newSnapshot = buildSnapshot(clients, today);

  // 10. Sort, compute summary, assemble final output
  clients.sort((a, b) => b.risk_score - a.risk_score);
  const high = clients.filter(c => c.risk_tier === 'high').length;
  const medium = clients.filter(c => c.risk_tier === 'medium').length;
  const low = clients.filter(c => c.risk_tier === 'low').length;
  const avgScore = clients.length
    ? round2(clients.reduce((s, c) => s + c.risk_score, 0) / clients.length)
    : 0;
  const revenueAtRiskMonthly = clients
    .filter(c => c.risk_score >= 4)
    .reduce((s, c) => s + c.monthly_value, 0);

  const priorityActions = clients
    .filter(c => c.risk_score >= 4)
    .map(c => ({
      name: c.name, risk_score: c.risk_score, risk_tier: c.risk_tier,
      signals: c.signals, monthly_value: c.monthly_value,
    }));

  const snapshotOutcomesForStats = outcomesState.outcomes.filter(o => o.source === 'snapshot');
  const signalStats = {};
  for (const [key, bw] of Object.entries(BASELINE_WEIGHTS)) {
    signalStats[key] = {
      baseline_weight: bw,
      learned_weight: weights[key] ?? bw,
      churn_events_with_signal: snapshotOutcomesForStats.filter(o =>
        (o.last_signals || []).some(s => signalToKey(s) === key)
      ).length,
    };
  }

  const churnData = {
    updated: new Date().toISOString(),
    source: 'GymMaster (live) + Trainerize (live)',
    trainerize_last_refresh: todayStr(today),
    learning: {
      total_churn_events: outcomesState.total_churn_events,
      snapshot_events: nSnapshot,
      alpha_blend: alpha,
      weights,
      signal_stats: signalStats,
    },
    summary: {
      active_members: clients.length,
      high_risk_count: high,
      medium_risk_count: medium,
      low_risk_count: low,
      retention_rate: clients.length ? round1((clients.length - high - medium) / clients.length * 100) : 100,
      avg_risk_score: avgScore,
      trainerize_connected: matched,
    },
    clients,
    priority_actions: priorityActions,
    trainerize_deactivation_alerts: tzAlerts,
    payment_history_summary: {
      members_tracked: Object.keys(paymentHistory.members).length,
      chronic_3plus: countChronic(paymentHistory, 3),
      chronic_6plus: countChronic(paymentHistory, 6),
      chronic_10plus: countChronic(paymentHistory, 10),
      last_updated: todayStr(today),
    },
    revenue_at_risk: {
      monthly: round2(revenueAtRiskMonthly),
      annual: round2(revenueAtRiskMonthly * 12),
    },
  };

  paymentHistory.last_updated = todayStr(today);

  // Persist state ONCE, at the very end — if anything above throws, nothing
  // is saved and the next run safely re-detects from the last good snapshot.
  await saveState({ outcomes: outcomesState, snapshot: newSnapshot, paymentHistory });

  console.error('');
  console.error('  churn_data ready');
  console.error(`  High risk:   ${high}`);
  console.error(`  Medium risk: ${medium}`);
  console.error(`  Low risk:    ${low}`);
  console.error(`  Avg score:   ${avgScore}`);
  if (tzAlerts.length) {
    console.error('');
    console.error(`  Trainerize deactivation needed (${tzAlerts.length}):`);
    for (const a of tzAlerts) {
      console.error(`    ${a.name}  TZ_ID=${a.trainerize_id}  source=${a.source}`);
    }
  }

  return churnData;
}

// All progress/diagnostic logging above goes to STDERR on purpose — STDOUT
// carries exactly one line: the final JSON payload, so any scheduler piping
// this script's stdout straight into a file/DB/HTTP call gets clean JSON.
run()
  .then(async churnData => {
    const body = JSON.stringify({ trainer_name:'__studiopulse__', period_start:ISO(), period_end:ISO(), source:'studio-pulse-snapshot', status:'data', raw_text: JSON.stringify(churnData), created_by:'weekly-sync' });
    await fetch(`${SUPABASE_URL}/rest/v1/invoices?source=eq.studio-pulse-snapshot`, { method:'DELETE', headers: SB_H({ Prefer:'return=minimal' }) });
    const w = await fetch(`${SUPABASE_URL}/rest/v1/invoices`, { method:'POST', headers: SB_H({ 'Content-Type':'application/json', Prefer:'return=minimal' }), body });
    console.error('Studio Pulse: wrote churn_data to Supabase, status', w.status);
  })
  .catch(err => {
    console.error('Studio Pulse run failed:', err);
    process.exitCode = 1;
  });
