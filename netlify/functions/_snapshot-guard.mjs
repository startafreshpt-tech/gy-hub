// ============================================================================
// _snapshot-guard — the last line of defence for published milestone data.
//
// WHY THIS EXISTS
// Every milestone incident so far shared one root cause: a throttled Trainerize
// call returned nothing, which was indistinguishable from "this member has no
// data", so a zero got published. It emptied the 1000 Club, blanked Sharron
// Booth, and collapsed April Van Berkum's 20.9kg transformation to 3.8kg.
//
// Fixing each call site is necessary but not sufficient — the next unfound bug
// in that class would ship the same way. So nothing reaches the dashboard
// without passing through here.
//
// THE RULE: published data may never be WORSE than the last known good snapshot
// in ways that are physically impossible.
//   - workout/activity counts only ever increase
//   - a recorded all-time transformation doesn't evaporate
//   - the date of someone's last workout never moves backwards
// A drop in any of those means a failed fetch, not a real change, so we carry
// the previous value forward and record that we did.
//
// Pure functions only — no I/O — so they are exhaustively unit tested.
// ============================================================================

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

// A transformation this large doesn't silently shrink; below this we treat a
// drop as plausible real-world regain rather than a fetch failure.
const LOSS_TRUST_KG = 3;
// How far an all-time loss must fall before we call it a failure rather than regain.
const LOSS_COLLAPSE_RATIO = 0.6;

/**
 * Merge a freshly built snapshot against the last known good one.
 * Returns { members, carried } where `carried` lists every value we had to
 * restore, so the sync reports exactly what went wrong instead of hiding it.
 */
export function mergeSnapshot(next, prev) {
  const nextMembers = (next && next.members) || [];
  const prevMembers = (prev && prev.members) || [];
  if (!prevMembers.length) return { members: nextMembers, carried: [] };

  const P = Object.create(null);
  for (const m of prevMembers) if (m && m.id != null) P[m.id] = m;

  const carried = [];
  const members = nextMembers.map((m) => {
    const p = m && m.id != null ? P[m.id] : null;
    if (!p) return m;
    const out = { ...m };
    const fields = [];

    // Workout + activity counts are monotonic. A fall means a failed fetch.
    if ((num(p.lifetime) || 0) > (num(out.lifetime) || 0)) { out.lifetime = p.lifetime; fields.push('lifetime'); }
    if ((num(p.activities) || 0) > (num(out.activities) || 0)) { out.activities = p.activities; fields.push('activities'); }
    out.combined = (num(out.lifetime) || 0) + (num(out.activities) || 0);

    // An established all-time loss must not vanish or collapse.
    const pl = num(p.alltime_loss_kg), nl = num(out.alltime_loss_kg);
    if (pl != null && pl >= LOSS_TRUST_KG && (nl == null || nl < pl * LOSS_COLLAPSE_RATIO)) {
      out.alltime_loss_kg = pl;
      fields.push('alltime_loss_kg');
    }

    // Last workout date can only move forward.
    if (p.last_workout && (!out.last_workout || String(p.last_workout) > String(out.last_workout))) {
      out.last_workout = p.last_workout;
      fields.push('last_workout');
    }

    if (fields.length) carried.push({ id: out.id, name: out.name, fields });
    return out;
  });

  return { members, carried };
}

/** Rebuild the "biggest transformations" board from the merged members, so it
 *  can never disagree with the member records it is meant to summarise. */
export function topTransformations(members, limit = 10) {
  return (members || [])
    .map((m) => ({ name: m.name, kg: num(m.alltime_loss_kg) }))
    .filter((r) => r.kg != null && r.kg > 0)
    .sort((a, b) => b.kg - a.kg)
    .slice(0, limit)
    .map((r) => ({ name: r.name, kg: Math.round(r.kg * 10) / 10 }));
}

/**
 * Look for signs the run was degraded. These do not block publishing (the merge
 * has already made the data safe) — they drive the health banner so a bad run is
 * visible rather than silent.
 */
export function auditSnapshot(next, prev, health = {}) {
  const alerts = [];
  const n = (next && next.members) || [];
  const p = (prev && prev.members) || [];

  if (p.length && n.length < p.length * 0.8) {
    alerts.push(`Member count fell from ${p.length} to ${n.length}`);
  }
  if (p.length) {
    const zeroN = n.filter((m) => !(num(m.lifetime) > 0)).length;
    const zeroP = p.filter((m) => !(num(m.lifetime) > 0)).length;
    if (zeroN > Math.max(zeroP * 1.5, zeroP + 15)) {
      alerts.push(`Members with no workouts jumped from ${zeroP} to ${zeroN}`);
    }
  }
  if (health.calendar_still_failed > 0) alerts.push(`${health.calendar_still_failed} member(s) still failing after retry`);
  if (health.summary_failed_after_retry > 0) alerts.push(`${health.summary_failed_after_retry} workout-total call(s) failed after retry`);
  if (health.weak_baseline > 0) alerts.push(`${health.weak_baseline} member(s) have an unreliable weight baseline`);
  if (health.calendar_retry_skipped > 0) alerts.push(`${health.calendar_retry_skipped} member(s) exceeded the retry cap`);
  return alerts;
}
