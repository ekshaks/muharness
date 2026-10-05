// Observed-usage mode (V16): turn a Claude Code session log into core events, replay them, and compare the ledger with the logged usage.
// The log has per-call usage but no per-message sizes, so each call's new prompt tokens (minus the previous reply) become one item.
// Claude's cache rules are applied here, as events, so the core needs no clock:
//   expire: the cache lives one hour after its last use; a longer pause empties it.
//   hidden: after some turn ends Claude Code makes a request the log does not record, which caches the final reply. Its trigger is not known,
//           so it is inferred where the next call reads that reply from cache; the app's own totals (`cost-state`) are the independent check.
//   compaction: Claude Code compacts when the prompt passes a threshold, so the replay uses the core's own compaction path with that threshold
//           (taken from the log). The compaction request is not logged; the summary is sized so the next prompt matches, and the cache starts empty after it.
import { readFileSync } from 'node:fs'
import { Event, Item, Policies, State, Usage, emptyLedger, init, step } from './core.js'
import { context } from './policies.js'

export const CLAUDE = { ttlMs: 3600_000, slackMs: 60_000 }   // slack: the last use (the hidden request) is a little after the logged reply
/** $/Mtok. Claude Code writes 1-hour cache entries, billed at 2x input (5-minute ones would be 1.25x). */
export const PRICES: Record<string, Policies['price']> = { 'claude-sonnet-5': { input: 2, write: 4, read: 0.2, output: 10 } }

interface ApiUsage { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }
interface Call { u: ApiUsage; calls: string[]; t: number; end: number; compactedFrom?: number }
export interface Imported {
  s0: State; first: Event; replies: { item: Item; hidden: boolean; next: Event[]; summary?: Item }[]
  compactAbove: number                                      // prompt size that triggers compaction
  model: string; observed: Usage[]; app?: { usage: Usage; usd: number; calls: number }
}

const usage = (u: ApiUsage): Usage => ({ input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens })
const sent = (u: ApiUsage) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens

export function importClaudeCode(path: string): Imported {
  const calls: Call[] = [], byId = new Map<string, Call>()
  let compactedFrom: number | undefined, model = '', app: { modelUsage: Record<string, any>; at: number } | undefined
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const x = JSON.parse(line)
    if (x.type === 'system' && x.subtype === 'compact_boundary') compactedFrom = x.compactMetadata.preTokens
    if (x.type === 'cost-state') app = { modelUsage: x.modelUsage, at: calls.length }
    if (x.type !== 'assistant' || x.isSidechain) continue
    const m = x.message, t = Date.parse(x.timestamp)          // one API call is logged as several entries sharing message.id and usage
    if (!byId.has(m.id)) { const c = { u: m.usage, calls: [], t, end: t, compactedFrom }; byId.set(m.id, c); calls.push(c); compactedFrom = undefined; model = m.model }
    const c = byId.get(m.id)!; c.end = t
    for (const b of m.content) if (b.type === 'tool_use') c.calls.push(b.id)
  }
  const warm = calls[0].u.cache_read_input_tokens               // cached before this session started (system prompt, tools)
  const s0 = init([{ name: 'prefix', items: [{ id: 'prefix', role: 'system', tokens: warm }] }], ['prefix'])
  const first: Event = { t: 'input', item: { id: 'u0', role: 'user', tokens: sent(calls[0].u) - warm } }
  const sizes = calls.flatMap(c => (c.compactedFrom ? [c.compactedFrom] : []))
  const replies = calls.map((c, k) => {
    const item: Item = { id: `a${k}`, role: 'assistant', tokens: c.u.output_tokens, calls: c.calls.map(id => ({ id, tool: 'tool', args: {} })) }
    const n = calls[k + 1], next: Event[] = []
    let hidden = false, summary: Item | undefined
    if (n) {
      const grew = (n.compactedFrom ?? sent(n.u)) - sent(c.u) - c.u.output_tokens   // everything that entered the prompt after this reply
      if (!c.calls.length) next.push({ t: 'input', item: { id: `u${k + 1}`, role: 'user', tokens: grew } })
      else c.calls.forEach((id, i) => next.push({ t: 'result', item: { id: `${id}:r`, role: 'tool', tokens: i ? 0 : grew, callId: id } }))
      if (n.compactedFrom) summary = { id: `s${k}`, role: 'summary', tokens: sent(n.u) - warm }
      const expired = n.t - c.end > CLAUDE.ttlMs + CLAUDE.slackMs
      if (expired) next.push({ t: 'expire' })
      hidden = !expired && !summary && n.u.cache_read_input_tokens - n.u.input_tokens - (sent(c.u) - c.u.input_tokens) > c.u.output_tokens / 2   // read more than this call cached
    }
    return { item, hidden, next, summary }
  })
  const appUsage = app?.modelUsage[model]
  return {
    s0, first, replies, compactAbove: sizes.length ? Math.min(...sizes) - 1 : Infinity, model, observed: calls.map(c => usage(c.u)),
    app: app && appUsage && { calls: app.at, usd: appUsage.costUSD, usage: { input: appUsage.inputTokens, cacheRead: appUsage.cacheReadInputTokens, cacheWrite: appUsage.cacheCreationInputTokens, output: appUsage.outputTokens } },
  }
}

const sum = (a: Usage, b: Usage, k = 1): Usage => ({ input: a.input + k * b.input, cacheRead: a.cacheRead + k * b.cacheRead, cacheWrite: a.cacheWrite + k * b.cacheWrite, output: a.output + k * b.output })

/** Replay through the core. `calls`: computed usage of each logged call. `unlogged`: running total of the requests the log omits (hidden, compaction), after each call. */
export function replayUsage(imp: Imported, P0: Policies): { calls: Usage[]; unlogged: Usage[] } {
  const P = { ...P0, context: context({ limit: imp.compactAbove }) }, calls: Usage[] = [], unlogged: Usage[] = []
  let [s] = step(imp.s0, imp.first, P), u = emptyLedger().usage
  const off = (e: Event) => { const before = { ...s.ledger.usage }; [s] = step(s, e, P); u = sum(u, sum(s.ledger.usage, before, -1)) }
  for (const r of imp.replies) {
    const before = { ...s.ledger.usage }
    ;[s] = step(s, { t: 'sampled', of: s.awaiting!, item: r.item, purpose: 'act' }, P)
    calls.push(sum(s.ledger.usage, before, -1))
    if (r.hidden) off({ t: 'hidden', output: 0 })              // its reply size is not logged
    for (const e of r.next) [s] = step(s, e, P)
    if (r.summary) { off({ t: 'sampled', of: s.awaiting!, item: r.summary, purpose: 'compact' }); [s] = step(s, { t: 'expire' }, P) }
    unlogged.push(u)
  }
  return { calls, unlogged }
}
