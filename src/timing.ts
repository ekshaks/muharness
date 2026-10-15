// Provider timing rules, outside the core (D25: the core has no clock). The importer and the simulator turn time into
// `expire` and `hidden` events with these rules, so both use the same numbers.
import { Event } from './core.js'

/** Claude: a cache entry lives one hour after its last use (Claude Code writes 1-hour entries). Slack: the last use is a little after the logged reply. */
export const CLAUDE = { ttlMs: 3600_000, slackMs: 60_000 }

/** Caveman's warm rule (`proxy/internal/gateway/cache_warm.go`): send the previous prompt again with no output at 90% of the lifetime,
 *  for at most `horizonMs` after the last real request. Caveman also skips a warm that it predicts will not pay off; this rule does not. */
export const WARM = { at: 0.9, horizonMs: 3600_000 }

/** The events that a pause of `ms` after the last request adds before the next request. */
export function pause(ms: number, { ttlMs = CLAUDE.ttlMs, warm = false } = {}): Event[] {
  const out: Event[] = []
  let alive = ttlMs                                       // the cache lives until this time, counted from the last request
  if (warm) for (let t = WARM.at * ttlMs; t < ms && t <= WARM.horizonMs && t < alive; t += WARM.at * ttlMs) {
    out.push({ t: 'hidden', output: 0, last: true }); alive = t + ttlMs
  }
  if (ms > alive) out.push({ t: 'expire' })
  return out
}
