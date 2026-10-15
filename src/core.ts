// harness-core: a pure statechart core, organised as in docs/MAP.md.
//   SEE  — what the model reads, and what it costs.      ACT  — what happens with the reply, and when to stop.
//   KEEP — the log, replay, and the set of logs.          RELATIONS — edges between logs (prefix, message, owner).
//   Policies decide (pure functions of State). Handlers act (async, impure). Hooks intercept.
//   Everything that differs between harnesses lives outside this file.

// ── Data ────────────────────────────────────────────────────────────────────
export type Id = string
export type ConvId = string
export type Role = 'system' | 'tools' | 'memory' | 'user' | 'assistant' | 'tool' | 'summary'
export interface Call { id: Id; tool: string; args: Record<string, unknown> }
/** Unit of context. Content is opaque to the core; only size, role and structure matter. */
export interface Item { id: Id; role: Role; tokens: number; text?: string; calls?: Call[]; callId?: Id }
/** Context = ordered segments. `stable` ones form the cacheable prefix; the last one is the conversation. */
export interface Segment { name: string; ids: Id[]; stable: boolean }
export type CacheClass = 'read' | 'write' | 'input'
export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number }
/** Cost ledger. `by` attributes dollars to what caused them (role of the item re-sent, output, child). */
export interface Ledger { usage: Usage; usd: number; by: Record<string, number>; samples: number }
export type Purpose = 'act' | 'compact'

// ── Events: facts, appended to the log. Effects: requests to handlers, never logged. ──
export type Event =
  | { t: 'input'; item: Item }                                 // user message, brief for a child, or steering mid-turn
  | { t: 'sampled'; of: Id; item: Item; purpose: Purpose }     // model reply to sample `of`
  | { t: 'result'; item: Item }                                // tool or child-agent result
  | { t: 'verdict'; callId: Id; allow: boolean }               // human approval
  | { t: 'section'; name: string; items: Item[] }              // a stable prompt section changed (memory, date, skills index...)
  | { t: 'interrupt'; partial?: Record<Id, Item> }             // what was cut off can stay visible: partial reply (by sample id) or partial tool output (by call id)
  | { t: 'restart'; delegated?: Id[] }                         // the process died: work in flight is lost, the log is intact (stepWorld fills `delegated`)
  | { t: 'fork'; child: ConvId; at: number }                   // a new conversation that starts from the first `at` conversation items of this one
  | { t: 'expire' }                                            // the provider dropped the cache (e.g. idle past its lifetime): the next prompt is written again
  | { t: 'hidden'; output: number; last?: true }               // a model call whose reply is discarded: on the current context (e.g. a turn-end request), or with `last` on the previous prompt (a warm)

export type Effect =
  | { k: 'sample'; id: Id; prompt: Item[]; purpose: Purpose }
  | { k: 'tool'; call: Call }
  | { k: 'ask'; call: Call }
  | { k: 'spawn'; call: Call; spec: SpawnSpec }                // consumed by stepWorld: it becomes a child log plus edges
  | { k: 'halt'; reason: string }

// ── State of one conversation ───────────────────────────────────────────────
export type Phase = 'idle' | 'sampling' | 'acting' | 'compacting' | 'done'
export interface State {
  phase: Phase
  items: Record<Id, Item>                 // content store
  ctx: Segment[]                          // what the model sees next
  inbox: Item[]                           // steering received mid-turn, flushed at next sample
  pending: Record<Id, { call: Call; st: 'asking' | 'running' | 'done' }>
  inflight: Record<Id, Id[]>              // prompt of every outstanding sample, by sample id (stale ones are still billed)
  awaiting: Id | null                     // the one sample whose reply this conversation is waiting for
  seq: number                             // counter for ids derived from state (keeps step pure)
  lastPrompt: Id[]                        // previous prompt: basis for cache accounting
  ledger: Ledger                          // this conversation only; see rollup() for the owned subtree
  turns: number
}

// ── Policies: the only extension points that change behaviour or cost. Must be pure. ──
export interface SpawnSpec { init: State; brief: Item; returns: 'summary' | 'full'; policies?: Policies }
export type TurnDecision = { next: 'act' } | { next: 'stop' } | { next: 'nudge'; item: Item }
export interface Policies {
  context: {                                       // SEE
    assemble(s: State): 'ok' | 'compact'           // before every sample
    compacted(s: State, summary: Item): Segment[]  // context after a summary is produced
    shape(result: Item, call: Call): Item          // tool output -> what enters context; `call` says which tool made it
  }
  turn(s: State, reply: Item): TurnDecision        // ACT
  permission(call: Call, s: State): 'allow' | 'ask' | 'deny'
  spawn(call: Call, s: State): SpawnSpec | null    // null: an ordinary tool
  budget(s: State): string | null                  // non-null: halt with reason
  recover(call: Call | null, s: State): 'redo' | 'abandon'   // after a restart; null = the model request that was in flight
  cache(prompt: Item[], prev: Id[]): CacheClass[]  // SEE: provider cache model, per prompt item
  price: Record<CacheClass | 'output', number>     // SEE: $ per million tokens
}

// ── Transition function: the three groups meet here ─────────────────────────
export const tokens = (xs: Item[]) => xs.reduce((n, x) => n + x.tokens, 0)
export const promptOf = (s: State) => s.ctx.flatMap(g => g.ids).map(id => s.items[id])
const conv = (s: State) => s.ctx[s.ctx.length - 1]
const synthetic = (c: Call, text: string): Item => ({ id: `${c.id}:r`, role: 'tool', tokens: 10, text, callId: c.id })

export function step(prev: State, e: Event, P: Policies): [State, Effect[]] {
  const s: State = structuredClone(prev), fx: Effect[] = []
  switch (e.t) {
    case 'input':
      if (s.phase === 'idle' || s.phase === 'done') { add(s, e.item); begin(s, P, fx) } else s.inbox.push(e.item)
      break
    case 'sampled': {
      const current = e.of === s.awaiting, ids = s.inflight[e.of] ?? []
      delete s.inflight[e.of]
      charge(s, ids, e.item.tokens, P, current)          // tokens were spent even if the reply is stale
      if (!current) break                                // stale: an interrupt or newer sample superseded it
      s.awaiting = null
      if (e.purpose === 'compact') { s.items[e.item.id] = e.item; s.ctx = P.context.compacted(s, e.item); sample(s, 'act', fx); break }
      add(s, e.item); s.turns++
      const d = P.turn(s, e.item)
      if (d.next === 'nudge') { add(s, d.item); begin(s, P, fx) }
      else if (d.next === 'stop') s.inbox.length ? begin(s, P, fx) : (s.phase = 'done')
      else { s.phase = 'acting'; for (const c of e.item.calls ?? []) dispatch(s, c, P, fx); settle(s, P, fx) }
      break
    }
    case 'verdict': {
      const p = s.pending[e.callId]
      if (!p || p.st !== 'asking') break
      e.allow ? start(s, p.call, P, fx) : finish(s, synthetic(p.call, 'denied'))
      settle(s, P, fx); break
    }
    case 'result':
      if (s.pending[e.item.callId!]?.st !== 'running') break
      finish(s, P.context.shape(e.item, s.pending[e.item.callId!].call)); settle(s, P, fx); break
    case 'section': {                                    // SEE: a stable segment changed; the prefix check shows the cache break
      for (const it of e.items) s.items[it.id] = it
      const ids = e.items.map(i => i.id), g = s.ctx.find(g => g.stable && g.name === e.name)
      if (g) g.ids = ids; else s.ctx.splice(s.ctx.length - 1, 0, { name: e.name, ids, stable: true })
      break
    }
    case 'interrupt': {                                  // every open call still gets a result; replies in flight turn stale
      const part = e.partial ?? {}, cut = s.awaiting && part[s.awaiting]
      if (cut) add(s, { ...cut, calls: undefined, text: `${cut.text ?? ''} [interrupted]` })   // a cut-off reply stays visible, without its calls
      for (const p of Object.values(s.pending)) if (p.st !== 'done') {
        const half = part[p.call.id]
        finish(s, half ? { ...synthetic(p.call, 'interrupted'), tokens: half.tokens, text: `${half.text ?? ''} [interrupted]` } : synthetic(p.call, 'interrupted'))
      }
      s.pending = {}; s.awaiting = null; s.phase = 'idle'; break
    }
    case 'restart': {                                    // lost with the process: every request and tool in flight. The policy decides what is redone
      const was = s.phase
      s.inflight = {}; s.awaiting = null                 // a lost request is not billed: its cost is unknown
      if (was === 'sampling' || was === 'compacting') {
        if (P.recover(null, s) === 'redo') sample(s, was === 'sampling' ? 'act' : 'compact', fx); else s.phase = 'idle'
      } else if (was === 'acting') {
        for (const p of Object.values(s.pending)) {
          if (p.st === 'done' || e.delegated?.includes(p.call.id)) continue   // a delegated call is waiting on its child, which restarts itself
          if (P.recover(p.call, s) === 'abandon') finish(s, synthetic(p.call, 'interrupted'))
          else if (p.st === 'asking') fx.push({ k: 'ask', call: p.call }); else start(s, p.call, P, fx)
        }
        settle(s, P, fx)
      }
      break
    }
    case 'fork': break                                   // nothing changes here: stepWorld creates the new conversation
    case 'expire': s.lastPrompt = []; break
    case 'hidden': charge(s, e.last ? s.lastPrompt : promptOf(s).map(x => x.id), e.output, P, true); break
  }
  return [s, fx]
}

// ── ACT: calls, permissions, stopping ───────────────────────────────────────
function add(s: State, it: Item) { s.items[it.id] = it; conv(s).ids.push(it.id) }
function begin(s: State, P: Policies, fx: Effect[]) {
  for (const it of s.inbox.splice(0)) add(s, it)
  const why = P.budget(s)
  if (why) { s.phase = 'done'; fx.push({ k: 'halt', reason: why }); return }
  sample(s, P.context.assemble(s) === 'compact' ? 'compact' : 'act', fx)
}
function dispatch(s: State, c: Call, P: Policies, fx: Effect[]) {
  s.pending[c.id] = { call: c, st: 'running' }
  const v = P.permission(c, s)
  if (v === 'deny') finish(s, synthetic(c, 'denied'))
  else if (v === 'ask') { s.pending[c.id].st = 'asking'; fx.push({ k: 'ask', call: c }) }
  else start(s, c, P, fx)
}
function start(s: State, c: Call, P: Policies, fx: Effect[]) {
  s.pending[c.id].st = 'running'
  const spec = P.spawn(c, s)
  fx.push(spec ? { k: 'spawn', call: c, spec } : { k: 'tool', call: c })
}
function finish(s: State, it: Item) { add(s, it); s.pending[it.callId!].st = 'done' }
function settle(s: State, P: Policies, fx: Effect[]) {
  if (s.phase !== 'acting' || Object.values(s.pending).some(p => p.st !== 'done')) return
  s.pending = {}; begin(s, P, fx)
}

// ── SEE: the prompt and what it costs (the core owns the arithmetic; policies own the cache model and prices) ──
function sample(s: State, purpose: Purpose, fx: Effect[]) {
  const prompt = promptOf(s), id = `smp${s.seq++}`
  s.inflight[id] = prompt.map(x => x.id); s.awaiting = id
  s.phase = purpose === 'act' ? 'sampling' : 'compacting'
  fx.push({ k: 'sample', id, prompt, purpose })
}
function charge(s: State, ids: Id[], output: number, P: Policies, current: boolean) {
  const prompt = ids.map(id => s.items[id]), cls = P.cache(prompt, s.lastPrompt), L = s.ledger
  const key = { read: 'cacheRead', write: 'cacheWrite', input: 'input' } as const
  prompt.forEach((it, i) => { L.usage[key[cls[i]]] += it.tokens; bill(L, it.role, it.tokens * P.price[cls[i]]) })
  L.usage.output += output; bill(L, 'output', output * P.price.output)
  L.samples++
  if (current) s.lastPrompt = ids                    // a stale reply is billed against its own prompt but doesn't move the cache baseline
}
function bill(L: Ledger, k: string, micro: number) { L.usd += micro / 1e6; L.by[k] = (L.by[k] ?? 0) + micro / 1e6 }
export const emptyLedger = (): Ledger => ({ usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, usd: 0, by: {}, samples: 0 })

// ── KEEP: one conversation's state is a fold over its log ───────────────────
export function init(segs: { name: string; items: Item[] }[], warm: Id[] = []): State {
  const items: Record<Id, Item> = {}
  for (const g of segs) for (const it of g.items) items[it.id] = it
  const ctx = segs.map(g => ({ name: g.name, ids: g.items.map(i => i.id), stable: true }))
  ctx.push({ name: 'conv', ids: [], stable: false })
  return { phase: 'idle', items, ctx, inbox: [], pending: {}, inflight: {}, awaiting: null, seq: 0, lastPrompt: warm, ledger: emptyLedger(), turns: 0 }
}

/** A new conversation that starts from `s`: same items and stable prefix (so the cache stays warm), nothing in flight, a fresh ledger. `keep` limits how many conversation items it inherits. */
export function forkState(s: State, keep = Infinity): State {
  const f: State = { ...structuredClone(s), phase: 'idle', pending: {}, inbox: [], inflight: {}, awaiting: null, turns: 0, ledger: emptyLedger() }
  const g = conv(f); g.ids = g.ids.slice(0, keep)
  return f
}

// ── RELATIONS: a set of logs, and three kinds of edge between them ──────────
//   prefix : `to` starts from the items `from` had (fork, or a child that shares the stable prefix). Cache warmth follows it.
//   message: an event in one log causes an event in another (spawn out, result back).
//   owner  : abort cascades from `from` to `to`, and `to`'s spend rolls up into `from`.
export type MessageEdge = { kind: 'message'; from: ConvId; to: ConvId; call: Call; returns: SpawnSpec['returns'] }
export type Edge =
  | { kind: 'prefix'; from: ConvId; to: ConvId; shared: Id[] }
  | MessageEdge
  | { kind: 'owner'; from: ConvId; to: ConvId }
export interface World { convs: Record<ConvId, State>; edges: Edge[] }
/** One log line: an event in one conversation. The world log is the session. */
export interface Entry { c: ConvId; e: Event }
export const ROOT: ConvId = 'root'
export const world = (root: State): World => ({ convs: { [ROOT]: root }, edges: [] })
/** Policies per conversation. Not part of World (functions aren't data); stepWorld fills it as children appear. */
export type Registry = Record<ConvId, Policies>
export interface Tagged { c: ConvId; f: Effect }
const upEdge = (w: World, c: ConvId) => w.edges.find((x): x is MessageEdge => x.kind === 'message' && x.to === c)
/** The call that created a child conversation (its incoming message edge). */
export const originOf = (w: World, c: ConvId) => upEdge(w, c)?.call

/**
 * Pure: advance one conversation, then apply the relations.
 *   fx  : effects for handlers (spawn is not among them: it was turned into a child plus edges here).
 *   emit: events this step causes in other logs (child's brief, abort cascade, child's result). A live run queues them;
 *         replay ignores them because they are already in the log.
 */
export function stepWorld(w: World, { c, e }: Entry, reg: Registry): { w: World; fx: Tagged[]; emit: Entry[] } {
  const before = w.convs[c]
  const delegated = e.t === 'restart' ? w.edges.flatMap(x => (x.kind === 'message' && x.from === c ? [x.call.id] : [])) : []
  const [s, fx] = step(before, e.t === 'restart' ? { ...e, delegated } : e, reg[c])
  const next: World = { convs: { ...w.convs, [c]: s }, edges: [...w.edges] }
  const out: Tagged[] = [], emit: Entry[] = []
  for (const f of fx) {
    if (f.k !== 'spawn') { out.push({ c, f }); continue }
    const child = `${f.call.id}:conv`, shared = f.spec.init.ctx.flatMap(g => g.ids)
    next.convs[child] = f.spec.init
    next.edges.push({ kind: 'owner', from: c, to: child }, { kind: 'message', from: c, to: child, call: f.call, returns: f.spec.returns })
    if (shared.length) next.edges.push({ kind: 'prefix', from: c, to: child, shared })
    reg[child] = f.spec.policies ?? reg[c]
    emit.push({ c: child, e: { t: 'input', item: f.spec.brief } })
  }
  if (e.t === 'fork' && !next.convs[e.child]) {          // prefix edge only: a fork is independent, not owned
    const f = forkState(s, e.at)
    next.convs[e.child] = f; reg[e.child] = reg[c]
    next.edges.push({ kind: 'prefix', from: c, to: e.child, shared: f.ctx.flatMap(g => g.ids) })
  }
  const up = upEdge(next, c)
  if (e.t === 'interrupt' || e.t === 'restart') {        // both stop work in flight, so both cascade to owned children
    const again: Event = e.t === 'interrupt' ? { t: 'interrupt' } : { t: 'restart' }
    for (const x of next.edges) if (x.kind === 'owner' && x.from === c && !['idle', 'done'].includes(next.convs[x.to].phase)) emit.push({ c: x.to, e: again })
    const ended = e.t === 'interrupt' || (s.phase === 'idle' && before.phase !== 'idle')   // a restart that abandons the turn ends it too
    if (up && ended) emit.push({ c: up.from, e: { t: 'result', item: synthetic(up.call, 'interrupted') } })   // a parent that already moved on ignores it
  } else if (up && s.phase === 'done' && before.phase !== 'done') {
    emit.push({ c: up.from, e: { t: 'result', item: childResult(next, c, up) } })
  }
  return { w: next, fx: out, emit }
}
function childResult(w: World, c: ConvId, up: MessageEdge): Item {
  const s = w.convs[c], shared = new Set(w.edges.flatMap(x => (x.kind === 'prefix' && x.to === c ? x.shared : [])))
  const own = conv(s).ids.filter(id => !shared.has(id)).map(id => s.items[id])
  const tok = up.returns === 'summary' ? (own[own.length - 1]?.tokens ?? 10) : tokens(own)
  return { id: `${up.call.id}:r`, role: 'tool', tokens: tok, callId: up.call.id, text: `child ${up.returns}` }
}

/** Ledger of a conversation plus everything it owns (follows owner edges). */
export function rollup(w: World, c: ConvId = ROOT): Ledger {
  const L = structuredClone(w.convs[c].ledger)
  for (const x of w.edges) if (x.kind === 'owner' && x.from === c) merge(L, rollup(w, x.to), true)
  return L
}
/** Number of conversations below `c`. A spawn is an owner edge, so no separate counter is kept. */
export const spawns = (w: World, c: ConvId = ROOT): number => w.edges.reduce((n, x) => n + (x.kind === 'owner' && x.from === c ? 1 + spawns(w, x.to) : 0), 0)
/** Spend of the whole world: every conversation nothing owns (the root, and any forks), each with what it owns. */
export function total(w: World): Ledger {
  const owned = new Set(w.edges.flatMap(x => (x.kind === 'owner' ? [x.to] : [])))
  const L = emptyLedger()
  for (const c of Object.keys(w.convs)) if (!owned.has(c)) merge(L, rollup(w, c), false)
  return L
}
function merge(L: Ledger, k: Ledger, asChild: boolean) {
  for (const u of Object.keys(L.usage) as (keyof Usage)[]) L.usage[u] += k.usage[u]
  L.usd += k.usd; L.samples += k.samples
  if (asChild) L.by.child = (L.by.child ?? 0) + k.usd
  else for (const [b, v] of Object.entries(k.by)) L.by[b] = (L.by[b] ?? 0) + v
}

/** Pure fold over the world log. Same log + same policies => same world, with no handlers involved. */
export function replayWorld(w0: World, log: Entry[], P: Policies): World {
  const reg: Registry = { [ROOT]: P }
  return log.reduce((w, en) => stepWorld(w, en, reg).w, w0)
}

// ── Imperative shell ────────────────────────────────────────────────────────
export interface Handlers {
  sample(prompt: Item[], purpose: Purpose): Promise<Item>
  tool(call: Call): Promise<Item>
  ask(call: Call): Promise<boolean>
}
/** Handlers for one conversation, built the first time it needs them. A child finds its brief via originOf(w, c). */
export type HandlerFactory = (c: ConvId, w: World) => Handlers
/** Hooks see and may rewrite or drop events (before logging) and effects (before handlers). A dropped effect is answered
 *  with a synthetic result, so the conversation never stalls. Spawn is governed by the permission and spawn policies. */
export interface Hook { event?(e: Event, s: State, c: ConvId): Event | null; effect?(f: Effect, s: State, c: ConvId): Effect | null }

export async function run(w: World, inputs: Entry[], P: Policies, H: HandlerFactory, hooks: Hook[] = []) {
  const log: Entry[] = [], q = [...inputs], reg: Registry = { [ROOT]: P }, hs: Record<ConvId, Handlers> = {}
  while (q.length) {                                     // one queue, one scheduler: conversations interleave deterministically
    let en: Entry | null = q.shift()!
    for (const h of hooks) if (en && h.event) { const e: Event | null = h.event(en.e, w.convs[en.c], en.c); en = e ? { c: en.c, e } : null }
    if (!en) continue
    log.push(en)
    const r = stepWorld(w, en, reg); w = r.w
    q.push(...r.emit)
    const todo: Tagged[] = []
    for (const { c, f } of r.fx) {
      let g: Effect | null = f
      for (const h of hooks) if (g && h.effect) g = h.effect(g, w.convs[c], c)
      if (g) todo.push({ c, f: g }); else { const d = dropped(c, f); if (d) q.push(d) }
    }
    const out = await Promise.all(todo.map(({ c, f }) => perform(c, f, (hs[c] ??= H(c, w)))))   // effects of one step run concurrently
    q.push(...out.filter((x): x is Entry => !!x))
  }
  return { world: w, log }
}
async function perform(c: ConvId, f: Effect, h: Handlers): Promise<Entry | null> {
  switch (f.k) {
    case 'sample': return { c, e: { t: 'sampled', of: f.id, item: await h.sample(f.prompt, f.purpose), purpose: f.purpose } }
    case 'tool': return { c, e: { t: 'result', item: await h.tool(f.call) } }
    case 'ask': return { c, e: { t: 'verdict', callId: f.call.id, allow: await h.ask(f.call) } }
    case 'spawn': case 'halt': return null               // spawn was consumed by stepWorld
  }
}
/** What stands in for an effect a hook dropped, so the state machine can move on. */
function dropped(c: ConvId, f: Effect): Entry | null {
  switch (f.k) {
    case 'tool': case 'spawn': return { c, e: { t: 'result', item: synthetic(f.call, 'blocked by hook') } }
    case 'ask': return { c, e: { t: 'verdict', callId: f.call.id, allow: false } }
    case 'sample': return { c, e: { t: 'interrupt' } }   // nothing to answer with: stop the turn (the dropped reply, if any, stays stale)
    case 'halt': return null
  }
}
