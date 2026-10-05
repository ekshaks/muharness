// Policy library + harness archetypes. A harness = a bundle of policies + prefix sizes + model effort.
import { Call, CacheClass, Id, Item, Policies, Role, SpawnSpec, State, TurnDecision, forkState, promptOf, tokens } from './core.js'

let n = 0
export const uid = (p = 'i') => `${p}${++n}`
export const item = (role: Role, tokens: number, text?: string): Item => ({ id: uid(), role, tokens, text })

// ── Cache models (provider behaviour, abstracted to "which prompt items are cache reads") ──
const lcp = (p: Item[], prev: Id[]) => { let i = 0; while (i < p.length && p[i].id === prev[i]) i++; return i }
export const cache = {
  none: (p: Item[]): CacheClass[] => p.map(() => 'input'),
  /** automatic prefix caching: common prefix is read if long enough, no write premium */
  auto: (min = 1024) => (p: Item[], prev: Id[]): CacheClass[] => {
    const k = lcp(p, prev), ok = tokens(p.slice(0, k)) >= min
    return p.map((_, i) => (ok && i < k ? 'read' : 'input'))
  },
  /** explicit breakpoint at the end of every prompt: common prefix read, the rest written at a premium */
  explicit: (p: Item[], prev: Id[]): CacheClass[] => { const k = lcp(p, prev); return p.map((_, i) => (i < k ? 'read' : 'write')) },
}

// ── Context: compaction threshold and tool-output truncation ──
//   keepTail: share of conversation items kept verbatim after the summary (at least 4), counted in items, not turns
export const context = ({ limit = Infinity, truncate = Infinity, keepTail = 0 } = {}): Policies['context'] => ({
  assemble: s => (tokens(promptOf(s)) > limit ? 'compact' : 'ok'),
  compacted: (s, sum) => {
    const ids = s.ctx[s.ctx.length - 1].ids, k = keepTail ? Math.max(4, Math.floor(ids.length * keepTail)) : 0
    return [...s.ctx.filter(g => g.stable), { name: 'conv', ids: [sum.id, ...(k ? ids.slice(-k) : [])], stable: false }]
  },
  shape: r => (r.tokens > truncate ? { ...r, tokens: truncate, text: `${r.text ?? ''} [truncated]` } : r),
})

// ── Turn: when to stop. `verify` re-prompts once after the model says it's done. ──
export const turn = {
  basic: (_: State, r: Item): TurnDecision => (r.calls?.length ? { next: 'act' } : { next: 'stop' }),
  verify: (text = 'Verify your work before finishing.') => (s: State, r: Item): TurnDecision => {
    if (r.calls?.length) return { next: 'act' }
    if (Object.values(s.items).some(i => i.text === text)) return { next: 'stop' }
    return { next: 'nudge', item: { id: `nudge:${s.turns}`, role: 'user', tokens: 20, text } }  // id from state: stays pure
  },
}

export const permission = ({ deny = [] as string[], ask = [] as string[] } = {}) =>
  (c: Call) => (deny.includes(c.tool) ? 'deny' : ask.includes(c.tool) ? 'ask' : 'allow') as 'allow' | 'ask' | 'deny'

// ── Spawn: how much parent context a child sees, and what comes back ──
//   fork : child inherits the whole conversation (cache-warm, but large prompts)
//   brief: child gets only the stable prefix + a short brief (small prompts, prefix still cache-warm)
export const spawn = (mode: 'none' | 'fork' | 'brief', returns: 'summary' | 'full' = 'summary') =>
  (c: Call, s: State): SpawnSpec | null => {
    if (mode === 'none' || c.tool !== 'agent') return null
    const init = forkState(s)
    if (mode === 'brief') init.ctx = [...init.ctx.filter(g => g.stable), { name: 'conv', ids: [], stable: false }]
    return { init, returns, brief: { id: `${c.id}:brief`, role: 'user', tokens: 150, text: String(c.args.task) } }
  }

/** After a restart: redo the model request in flight, rerun tools named safe, report the others to the model as interrupted. */
export const recover = (safe: string[] = []) => (c: Call | null) => (c === null || safe.includes(c.tool) ? 'redo' : 'abandon') as 'redo' | 'abandon'

export const maxTurns = (k: number) => (s: State) => (s.turns >= k ? `max ${k} turns` : null)

/** Illustrative list prices, $/Mtok. */
export const PRICE = { input: 3, write: 3.75, read: 0.3, output: 15 }

// ── Archetypes. Numbers are ILLUSTRATIVE guesses, not measurements of the real products. ──
export interface Bundle {
  name: string; like: string
  prefix: { system: number; tools: number; memory: number }   // tokens re-sent every turn
  tools: string[]; effort: number                              // tool names; reasoning+text tokens per turn
  defer?: number                                               // deferred tools: tokens of one tool description, loaded on demand
  P: Policies
}
const base: Policies = {
  context: context(), turn: turn.basic, permission: permission(), spawn: spawn('none'),
  budget: maxTurns(40), recover: recover(['read', 'grep']), cache: cache.explicit, price: PRICE,
}
const T = ['read', 'grep', 'edit', 'bash']
export const archetypes: Bundle[] = [
  { name: 'minimal', like: 'pi', prefix: { system: 900, tools: 700, memory: 0 }, tools: T, effort: 250, P: base },
  { name: 'rich', like: 'claude code', prefix: { system: 3000, tools: 9000, memory: 2500 }, tools: [...T, 'agent'], effort: 400,
    P: { ...base, context: context({ limit: 50_000 }), spawn: spawn('brief'), permission: permission({ ask: ['edit'] }) } },
  { name: 'truncating', like: 'codex', prefix: { system: 2500, tools: 1800, memory: 0 }, tools: T, effort: 400,
    P: { ...base, cache: cache.auto(1024), context: context({ truncate: 2500, limit: 60_000 }) } },
  { name: 'memory', like: 'hermes', prefix: { system: 1800, tools: 3500, memory: 2300 }, tools: [...T, 'agent'], effort: 300,
    P: { ...base, spawn: spawn('fork'), turn: turn.verify() } },
  // The paper's 90-line harness (arXiv 2609.00006, Listing 3): no cache markers, so no caching; compact at 120k keeping 30% of messages;
  // truncate tool output at 25k chars (~6k tokens); stop at 50 turns or $5. Bugs it has that this model does not copy: see docs/harness-docs/mvh-vs-core.md.
  { name: 'mvh', like: 'paper 90-line', prefix: { system: 1000, tools: 100, memory: 0 }, tools: T, effort: 300,
    P: { ...base, cache: cache.none, context: context({ limit: 120_000, truncate: 6000, keepTail: 0.3 }),
      budget: s => (s.turns >= 50 ? 'max 50 turns' : s.ledger.usd >= 5 ? 'max $5' : null) } },
]

/** One-knob variations, to isolate the cost of a single design choice. */
export const vary = (b: Bundle, name: string, patch: Omit<Partial<Bundle>, 'P'> & { P?: Partial<Policies> }): Bundle =>
  ({ ...b, ...patch, name: `${b.name} ${name}`, P: { ...b.P, ...patch.P } })
export const ablations = (a = Object.fromEntries(archetypes.map(b => [b.name, b]))): Bundle[] => [
  vary(a.rich, '- subagent', { tools: T, P: { spawn: spawn('none') } }),
  vary(a.rich, 'fork not brief', { P: { spawn: spawn('fork') } }),
  vary(a.rich, 'no cache', { P: { cache: cache.none } }),
  vary(a.rich, '+ deferred tools', { prefix: { ...a.rich.prefix, tools: 1000 }, tools: [...a.rich.tools, 'load_tool'], defer: 1600 }),
  vary(a.rich, '+ code mode', { tools: [...a.rich.tools, 'script'], P: { permission: permission({ ask: ['edit', 'script'] }) } }),
  vary(a.minimal, '+ compact@35k', { P: { context: context({ limit: 35_000 }) } }),
  vary(a.minimal, '+ truncate 2.5k', { P: { context: context({ truncate: 2500 }) } }),
  vary(a.memory, '- verify', { P: { turn: turn.basic } }),
]
