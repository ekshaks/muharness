// Behaviour checks for the core. Each drives the pure step functions with scripted events, so no model is involved.
// Run: npm run check
import { deepStrictEqual, ok, strictEqual as eq } from 'node:assert'
import { Call, Effect, Entry, Usage, Event, HandlerFactory, Hook, ROOT, Registry, World, init, replayWorld, rollup, run, spawns, stepWorld, total, world } from './core.js'
import { archetypes, cache, context, item, spawn, uid } from './policies.js'
import { PRICES, importClaudeCode, replayUsage } from './import-cc.js'
import { importCodex } from './import-codex.js'

const base = archetypes[0].P                                     // minimal: explicit cache, everything allowed
const mk = () => world(init([{ name: 'system', items: [item('system', 1000)] }, { name: 'memory', items: [item('memory', 500)] }]))
const send = (w: World, reg: Registry, c: string, e: Event) => stepWorld(w, { c, e }, reg)
const sampleOf = (fx: { f: Effect }[]) => fx.find(x => x.f.k === 'sample')!.f as Extract<Effect, { k: 'sample' }>
const tokensBilled = (w: World, c = ROOT) => { const u = w.convs[c].ledger.usage; return u.input + u.cacheRead + u.cacheWrite }
const convIds = (w: World, c = ROOT) => w.convs[c].ctx[w.convs[c].ctx.length - 1].ids
const reply = (tokens: number, calls?: Call[]) => ({ ...item('assistant', tokens), calls })
const input = (tokens = 100): Event => ({ t: 'input', item: item('user', tokens) })

const checks: [string, () => void | Promise<void>][] = []
const check = (name: string, fn: () => void | Promise<void>) => checks.push([name, fn])

check('section change breaks the cached prefix from that segment on', () => {
  const secondTurn = (change: boolean) => {
    const reg: Registry = { [ROOT]: base }
    let r = send(mk(), reg, ROOT, input())
    r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50), purpose: 'act' })
    if (change) r = send(r.w, reg, ROOT, { t: 'section', name: 'memory', items: [item('memory', 500)] })   // same size, new identity
    r = send(r.w, reg, ROOT, input())
    r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50), purpose: 'act' })
    return r.w.convs[ROOT].ledger.usage
  }
  eq(secondTurn(false).cacheRead, 1000 + 500 + 100)             // system, memory, first user message
  eq(secondTurn(true).cacheRead, 1000)                          // only the system prompt survives the change
  const r = send(mk(), { [ROOT]: base }, ROOT, { t: 'section', name: 'date', items: [item('system', 20)] })
  deepStrictEqual(r.w.convs[ROOT].ctx.map(g => g.name), ['system', 'memory', 'date', 'conv'])   // a new section goes before the conversation
})

check('a stale reply after an interrupt is billed against its own prompt and never accepted as current', () => {
  const reg: Registry = { [ROOT]: base }
  let r = send(mk(), reg, ROOT, input())
  const a = sampleOf(r.fx)
  r = send(r.w, reg, ROOT, { t: 'interrupt' })
  r = send(r.w, reg, ROOT, input())
  const b = sampleOf(r.fx)
  ok(a.id !== b.id)
  const stale = reply(50)
  r = send(r.w, reg, ROOT, { t: 'sampled', of: a.id, item: stale, purpose: 'act' })
  eq(r.w.convs[ROOT].phase, 'sampling')                         // still waiting for b
  eq(r.w.convs[ROOT].awaiting, b.id)
  eq(tokensBilled(r.w), 1000 + 500 + 100)                       // a's prompt (b's would be 1700)
  ok(!convIds(r.w).includes(stale.id))
  r = send(r.w, reg, ROOT, { t: 'sampled', of: b.id, item: reply(50), purpose: 'act' })
  eq(r.w.convs[ROOT].phase, 'done')
  eq(r.w.convs[ROOT].turns, 1)
  eq(tokensBilled(r.w), 1600 + 1700)
})

check('children live in the world log, joined by prefix, message and owner edges; cost rolls up; replay is exact', async () => {
  const P = { ...base, spawn: spawn('brief') }
  const H: HandlerFactory = c => {
    let n = 0
    return {
      sample: async () => (c === ROOT ? (n++ === 0 ? reply(100, [{ id: uid('c'), tool: 'agent', args: { task: 'look around' } }]) : reply(50)) : reply(80)),
      tool: async cl => ({ ...item('tool', 20), callId: cl.id }),
      ask: async () => true,
    }
  }
  const w0 = mk()
  const { world: w1, log } = await run(w0, [{ c: ROOT, e: input() }], P, H)
  const child = Object.keys(w1.convs).find(c => c !== ROOT)!
  ok(log.some(x => x.c === child && x.e.t === 'sampled'))        // the child's events are in the same log
  deepStrictEqual(w1.edges.map(e => e.kind).sort(), ['message', 'owner', 'prefix'])
  const res = Object.values(w1.convs[ROOT].items).find(i => i.text === 'child summary')!
  eq(res.tokens, 80)                                             // the child's last own item, not its inherited prefix
  const L = rollup(w1), own = w1.convs[ROOT].ledger.usd, kid = w1.convs[child].ledger.usd
  ok(Math.abs(L.usd - (own + kid)) < 1e-12 && Math.abs(L.by.child - kid) < 1e-12)
  eq(L.samples, 3); eq(spawns(w1), 1)
  deepStrictEqual(replayWorld(w0, log, P), w1)
})

check('abort cascades to children, the parent gets exactly one result, and a late child reply is billed but ignored', () => {
  const P = { ...base, spawn: spawn('brief') }, reg: Registry = { [ROOT]: P }
  const ag = { id: uid('c'), tool: 'agent', args: { task: 'x' } }
  let r = send(mk(), reg, ROOT, input())
  r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(100, [ag]), purpose: 'act' })
  const child = r.emit[0].c
  r = send(r.w, reg, child, r.emit[0].e)                         // the child starts from its brief
  const late = sampleOf(r.fx)
  r = send(r.w, reg, ROOT, { t: 'interrupt' })
  const cascade = r.emit.find(x => x.c === child && x.e.t === 'interrupt')
  ok(cascade)
  r = send(r.w, reg, child, cascade.e)
  eq(r.w.convs[child].phase, 'idle')
  const toParent = r.emit.find(x => x.c === ROOT)!               // the child's own "interrupted" result: the parent already has one
  r = send(r.w, reg, ROOT, toParent.e)
  eq(r.w.convs[ROOT].items[`${ag.id}:r`].text, 'interrupted')
  eq(convIds(r.w).filter(id => id === `${ag.id}:r`).length, 1)
  r = send(r.w, reg, child, { t: 'sampled', of: late.id, item: reply(80), purpose: 'act' })
  eq(r.w.convs[child].phase, 'idle'); eq(r.emit.length, 0)
  eq(rollup(r.w).samples, 2)                                     // root's first sample + the child's late one
})

check('a hook that drops an effect gets a synthetic result instead of stalling the conversation', async () => {
  const H: HandlerFactory = () => {
    let n = 0
    return {
      sample: async () => (n++ === 0 ? reply(100, [{ id: uid('c'), tool: 'read', args: {} }]) : reply(50)),
      tool: async cl => ({ ...item('tool', 20), callId: cl.id }),
      ask: async () => true,
    }
  }
  const drop: Hook = { effect: f => (f.k === 'tool' ? null : f) }
  const { world: w } = await run(mk(), [{ c: ROOT, e: input() }], base, H, [drop])
  eq(w.convs[ROOT].phase, 'done')
  ok(Object.values(w.convs[ROOT].items).some(i => i.text === 'blocked by hook'))
})

check('shape gets the call that made each result, so it can treat tools differently', () => {
  const reg: Registry = { [ROOT]: { ...base, context: context({ keep: { bash: 0.01 } }) } }
  const calls: Call[] = [{ id: uid('c'), tool: 'read', args: {} }, { id: uid('c'), tool: 'bash', args: {} }]
  let r = send(mk(), reg, ROOT, input())
  r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50, calls), purpose: 'act' })
  for (const c of [...calls].reverse()) r = send(r.w, reg, ROOT, { t: 'result', item: { ...item('tool', 1000), callId: c.id } })   // results arrive out of order
  const size = (c: Call) => Object.values(r.w.convs[ROOT].items).find(i => i.callId === c.id)!.tokens
  eq(size(calls[0]), 1000)                                      // the read stays exact
  eq(size(calls[1]), 10)                                        // the test output shrinks
})

const promptTokens = (fx: { f: Effect }[]) => sampleOf(fx).prompt.reduce((n, x) => n + x.tokens, 0)

check('an interrupt can leave the cut-off reply and partial tool output visible to the model', () => {
  const reg: Registry = { [ROOT]: base }
  const after = (partial?: Record<string, ReturnType<typeof reply>>) => {
    let r = send(mk(), reg, ROOT, input())
    const a = sampleOf(r.fx)
    r = send(r.w, reg, ROOT, { t: 'interrupt', partial: partial && { [a.id]: partial.reply } })
    return send(r.w, reg, ROOT, input())
  }
  const cut = reply(120, [{ id: uid('c'), tool: 'read', args: {} }])
  const kept = after({ reply: cut })
  eq(promptTokens(kept.fx), 1000 + 500 + 100 + 120 + 100)      // the partial reply is part of the next prompt
  eq(kept.w.convs[ROOT].items[cut.id].calls, undefined)         // without its calls: a cut-off call is not valid
  eq(promptTokens(after().fx), 1000 + 500 + 100 + 100)          // no partial given: discarded, as before
  const call = { id: uid('c'), tool: 'bash', args: {} }
  let r = send(mk(), reg, ROOT, input())
  r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(100, [call]), purpose: 'act' })
  r = send(r.w, reg, ROOT, { t: 'interrupt', partial: { [call.id]: item('tool', 700, 'half the log') } })
  eq(r.w.convs[ROOT].items[`${call.id}:r`].tokens, 700)         // the model is told what the tool had produced
})

check('a restart redoes or abandons what was in flight, as the recover policy says, and never bills a lost request', () => {
  const reg: Registry = { [ROOT]: base }                        // base: read and grep are safe to rerun
  let r = send(mk(), reg, ROOT, input())
  const a = sampleOf(r.fx)
  r = send(r.w, reg, ROOT, { t: 'restart' })
  const b = sampleOf(r.fx)
  ok(a.id !== b.id); eq(tokensBilled(r.w), 0)                   // the lost request was not billed
  r = send(r.w, reg, ROOT, { t: 'sampled', of: b.id, item: reply(50), purpose: 'act' })
  eq(r.w.convs[ROOT].phase, 'done'); eq(tokensBilled(r.w), 1600)
  r = send(r.w, reg, ROOT, { t: 'sampled', of: a.id, item: reply(50), purpose: 'act' })   // a late answer to the lost request
  eq(tokensBilled(r.w), 1600); eq(r.w.convs[ROOT].turns, 1)
  // tools: the safe one reruns, the other is reported as interrupted, then the turn continues
  const rd = { id: uid('c'), tool: 'read', args: {} }, sh = { id: uid('c'), tool: 'bash', args: {} }
  r = send(mk(), reg, ROOT, input())
  r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(100, [rd, sh]), purpose: 'act' })
  r = send(r.w, reg, ROOT, { t: 'restart' })
  deepStrictEqual(r.fx.map(x => (x.f.k === 'tool' ? x.f.call.tool : x.f.k)), ['read'])
  eq(r.w.convs[ROOT].items[`${sh.id}:r`].text, 'interrupted')
  r = send(r.w, reg, ROOT, { t: 'result', item: { ...item('tool', 50), callId: rd.id } })
  ok(sampleOf(r.fx))
  // a policy that abandons everything ends the turn
  const none: Registry = { [ROOT]: { ...base, recover: () => 'abandon' } }
  r = send(mk(), none, ROOT, input())
  r = send(r.w, none, ROOT, { t: 'restart' })
  eq(r.fx.length, 0); eq(r.w.convs[ROOT].phase, 'idle')
})

check('a restart reaches owned children, and the parent keeps waiting on a delegated call', () => {
  const reg: Registry = { [ROOT]: { ...base, spawn: spawn('brief') } }
  const ag = { id: uid('c'), tool: 'agent', args: { task: 'x' } }
  let r = send(mk(), reg, ROOT, input())
  r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(100, [ag]), purpose: 'act' })
  const child = r.emit[0].c
  r = send(r.w, reg, child, r.emit[0].e)
  const lost = sampleOf(r.fx)
  r = send(r.w, reg, ROOT, { t: 'restart' })
  eq(r.fx.length, 0)                                            // no second child, no rerun of the agent call
  eq(r.w.convs[ROOT].pending[ag.id].st, 'running')
  const again = r.emit.find(x => x.c === child && x.e.t === 'restart'); ok(again)
  r = send(r.w, reg, child, again.e)
  const redo = sampleOf(r.fx); ok(redo.id !== lost.id)
  r = send(r.w, reg, child, { t: 'sampled', of: redo.id, item: reply(80), purpose: 'act' })
  r = send(r.w, reg, ROOT, r.emit.find(x => x.c === ROOT)!.e)   // the child's result reaches the parent
  ok(sampleOf(r.fx)); eq(Object.keys(r.w.convs).length, 2)
})

check('a fork starts from a prefix of the history, keeps the cache warm, and its spend counts in the world total', () => {
  const w0 = mk(), reg: Registry = { [ROOT]: base }, entries: Entry[] = []
  let w = w0
  const go = (c: string, e: Event) => { entries.push({ c, e }); const r = stepWorld(w, { c, e }, reg); w = r.w; return r }
  let r = go(ROOT, input())
  r = go(ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50), purpose: 'act' })
  r = go(ROOT, input())
  go(ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50), purpose: 'act' })   // history: user, reply, user, reply
  const before = w.convs[ROOT]
  go(ROOT, { t: 'fork', child: 'f1', at: 2 })
  deepStrictEqual(w.convs[ROOT], before)                        // the parent is untouched
  eq(convIds(w, 'f1').length, 2)
  const edge = w.edges.find(x => x.kind === 'prefix' && x.to === 'f1')!
  ok(edge.kind === 'prefix' && edge.shared.length === 4)        // system, memory, and the first two conversation items
  r = go('f1', input())
  go('f1', { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50), purpose: 'act' })
  eq(w.convs['f1'].ledger.usage.cacheRead, 1000 + 500 + 100 + 50)   // the shared prefix is read from the cache
  ok(Math.abs(total(w).usd - (w.convs[ROOT].ledger.usd + w.convs['f1'].ledger.usd)) < 1e-12)
  eq(spawns(w), 0)                                              // a fork is not owned, so it is not a child
  deepStrictEqual(replayWorld(w0, entries, base), w)
})

check('a warm (hidden with last) sends the previous prompt again: all of it is a cache read, and the next call writes the reply', () => {
  const after = (warm: Event[]) => {
    const reg: Registry = { [ROOT]: base }
    let r = send(mk(), reg, ROOT, input())
    r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50), purpose: 'act' })
    const before = { ...r.w.convs[ROOT].ledger.usage }
    for (const e of warm) r = send(r.w, reg, ROOT, e)
    const u = r.w.convs[ROOT].ledger.usage, warmed = { read: u.cacheRead - before.cacheRead, write: u.cacheWrite - before.cacheWrite }
    r = send(r.w, reg, ROOT, input())
    r = send(r.w, reg, ROOT, { t: 'sampled', of: sampleOf(r.fx).id, item: reply(50), purpose: 'act' })
    return { warmed, next: r.w.convs[ROOT].ledger.usage.cacheWrite - u.cacheWrite }
  }
  deepStrictEqual(after([{ t: 'hidden', output: 0, last: true }]), { warmed: { read: 1600, write: 0 }, next: 50 + 100 })   // reply and new user message
  deepStrictEqual(after([{ t: 'hidden', output: 0 }]), { warmed: { read: 1600, write: 50 }, next: 100 })                 // a turn-end request caches the reply
  deepStrictEqual(after([{ t: 'expire' }]), { warmed: { read: 0, write: 0 }, next: 1600 + 50 + 100 })                    // no warm: everything is written again
})

check('calibration (V16): real Claude Code sessions replay to their logged usage per call, within 10 tokens per field', () => {
  const P = { ...base, budget: () => null }
  for (const f of ['cc-session-1', 'cc-session-2']) {
    const imp = importClaudeCode(`src/fixtures/${f}.jsonl`), got = replayUsage(imp, P).calls
    eq(got.length, imp.observed.length)
    got.forEach((u, k) => {
      for (const x of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
        ok(Math.abs(u[x] - imp.observed[k][x]) <= 10, `${f} call ${k} ${x}: computed ${u[x]}, logged ${imp.observed[k][x]}`)
    })
  }
})

check('calibration (V16): with the requests the log omits (hidden turn-end, compaction), cache totals match the app\'s own count (reads within 3%, writes within 1%)', () => {
  const imp = importClaudeCode('src/fixtures/cc-session-2.jsonl'), r = replayUsage(imp, { ...base, budget: () => null }), n = imp.app!.calls
  const total = (f: 'cacheRead' | 'cacheWrite') => r.calls.slice(0, n).reduce((a, u) => a + u[f], 0) + r.unlogged[n - 1][f]
  const near = (f: 'cacheRead' | 'cacheWrite', tol: number) => ok(Math.abs(total(f) / imp.app!.usage[f] - 1) <= tol, `${f}: computed ${total(f)}, app ${imp.app!.usage[f]}`)
  near('cacheRead', 0.03); near('cacheWrite', 0.01)
})

check('calibration (V16): at list prices the replay costs what the app charged, within 1% (the logged calls alone come to 10% less)', () => {
  const imp = importClaudeCode('src/fixtures/cc-session-2.jsonl'), p = PRICES[imp.model], n = imp.app!.calls
  const usd = (u: Usage) => (u.input * p.input + u.cacheRead * p.read + u.cacheWrite * p.write + u.output * p.output) / 1e6
  ok(Math.abs(usd(imp.app!.usage) - imp.app!.usd) < 1e-6, 'prices reproduce the app\'s own total from its own token counts')
  const r = replayUsage(imp, { ...base, budget: () => null, price: p })
  const got = r.calls.slice(0, n).reduce((a, u) => a + usd(u), 0) + usd(r.unlogged[n - 1])
  ok(Math.abs(got / imp.app!.usd - 1) <= 0.01, `computed $${got.toFixed(2)}, app $${imp.app!.usd.toFixed(2)}`)
})

check('calibration (V16, Codex): prompt and output sizes replay exactly; the automatic cache over-predicts reads by at most 2.5% in total', () => {
  const P = { ...base, budget: () => null, cache: cache.auto(1024) }
  const evicted: Record<string, number> = { 'codex-2-cache-drop': 3 }   // recorded gap: the provider dropped the conversation's cache mid-session (FEATURES.md, S3)
  for (const f of ['codex-1-tool-loop', 'codex-2-cache-drop', 'codex-3-reasoning', 'codex-4b-thread']) {
    const imp = importCodex(`src/fixtures/${f}.jsonl`), got = replayUsage(imp, P).calls
    let computed = 0, logged = 0
    got.forEach((u, k) => {
      const o = imp.observed[k]
      eq(u.input + u.cacheRead, o.input + o.cacheRead, `${f} call ${k}: prompt size`); eq(u.output, o.output, `${f} call ${k}: output`)
      if (k === evicted[f]) return
      ok(u.cacheRead >= o.cacheRead, `${f} call ${k}: Codex read more than the whole previous prompt`)
      computed += u.cacheRead; logged += o.cacheRead
    })
    ok(computed / logged - 1 <= 0.025, `${f}: cached reads computed ${computed}, logged ${logged}`)
  }
})

let failed = 0
for (const [name, fn] of checks) {
  try { await fn(); console.log('ok   ', name) } catch (e) { failed++; console.log('FAIL ', name, '\n     ', (e as Error).message.split('\n').slice(0, 6).join('\n      ')) }
}
if (failed) process.exit(1)
