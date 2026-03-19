/**
 * Curve functions for deadline-based priority boosting.
 * Each function takes:
 *   - timeRemainingPct: fraction of time remaining [0..1], where 0 = deadline passed, 1 = just created
 *   - basePriority: the job's original priority
 *   - maxBoost: the ceiling priority value
 *   - boostThreshold: pct at which boosting begins (default 0.5)
 * Returns: new priority value
 */

export function linearCurve(
  timeRemainingPct: number,
  basePriority: number,
  maxBoost: number,
  boostThreshold = 0.5,
): number {
  if (timeRemainingPct >= boostThreshold) {
    return basePriority
  }
  // As timeRemainingPct goes from boostThreshold → 0, priority goes from basePriority → maxBoost
  const progress = 1 - timeRemainingPct / boostThreshold
  return Math.round(basePriority + (maxBoost - basePriority) * progress)
}

export function exponentialCurve(
  timeRemainingPct: number,
  basePriority: number,
  maxBoost: number,
  boostThreshold = 0.5,
): number {
  if (timeRemainingPct >= boostThreshold) {
    return basePriority
  }
  // Exponential acceleration: progress^2 makes it accelerate near deadline
  const linearProgress = 1 - timeRemainingPct / boostThreshold
  const progress = linearProgress * linearProgress
  return Math.round(basePriority + (maxBoost - basePriority) * progress)
}

export function stepCurve(
  timeRemainingPct: number,
  basePriority: number,
  maxBoost: number,
  boostThreshold = 0.5,
): number {
  if (timeRemainingPct >= boostThreshold) {
    return basePriority
  }
  // Step function: jump to intermediate values at 1/3 intervals
  const range = maxBoost - basePriority
  if (timeRemainingPct < boostThreshold / 3) {
    // Last third: jump to maxBoost
    return maxBoost
  } else if (timeRemainingPct < (boostThreshold * 2) / 3) {
    // Middle third: jump to 2/3 of the boost
    return Math.round(basePriority + (range * 2) / 3)
  } else {
    // First third below threshold: jump to 1/3 of the boost
    return Math.round(basePriority + range / 3)
  }
}
