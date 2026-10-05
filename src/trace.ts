// Prints one scripted session as a timeline. Every row is one log entry, tagged by the group where the interesting thing happens:
//   SEE = the prompt was built and billed    ACT = a decision about calls, approval or stopping    REL = something crossed between logs
// KEEP is the log itself: the rows are the log, and the last line replays it. Run: npm run trace
import { deepStrictEqual } from 'node:assert'
import { HandlerFactory, Handlers, ROOT, Registry, init, originOf, replayWorld, rollup, run, spawns, stepWorld, world } from './core.js'
import { archetypes, context, item, uid } from './policies.js'

type Step = { calls: [tool: string, out: number][] } | { agent: Step[] }
const SCRIPT: Step[] = [
  { calls: [['grep', 800], ['read', 1500]] },        // two tool calls in parallel
  { agent: [{ calls: [['read', 1200]] }] },          // delegate exploration to a child conversation
  { calls: [['edit', 300]] },                        // an edit: the permission policy asks the human
]
function handlers(script: Step[]): Handlers {
  let i = 0
  return {
    sample: async (_prompt, purpose) => {
      if (purpose === 'compact') return item('summary', 600, 'summary')
      const st = script[i++]
      if (!st) return item('assistant', 300, 'final answer')
      const calls = 'agent' in st ? [{ id: uid('c'), tool: 'agent', args: { steps: st.agent } }] : st.calls.map(([tool, out]) => ({ id: uid('c'), tool, args: { out } }))
      return { ...item('assistant', 200 + 60 * calls.length), calls }
    },
    tool: async c => ({ ...item('tool', Number(c.args.out)), callId: c.id }),
    ask: async () => true,
  }
}

const P = { ...archetypes.find(b => b.name === 'rich')!.P, context: context({ limit: 4500 }) }   // small limit so compaction shows up
const w0 = world(init([{ name: 'system', items: [item('system', 500)] }, { name: 'tools', items: [item('tools', 1000, 'grep read edit agent')] }]))
const H: HandlerFactory = (c, w) => handlers(c === ROOT ? SCRIPT : (originOf(w, c)!.args.steps as Step[]))
const first = await run(w0, [{ c: ROOT, e: { t: 'input', item: item('user', 100, 'fix the login bug') } }], P, H)
// After the turn: a turn-end request the harness makes on its own, then a pause long enough for the provider to drop the cache, then a new message.
const later = await run(first.world, [{ c: ROOT, e: { t: 'hidden', output: 50 } }, { c: ROOT, e: { t: 'expire' } }, { c: ROOT, e: { t: 'input', item: item('user', 50, 'thanks') } }], P, () => handlers([]))
const w1 = later.world, log = [...first.log, ...later.log]

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const names: Record<string, string> = { [ROOT]: 'root' }
const label = (c: string) => (names[c] ??= `child${Object.keys(names).length}`)
const rows: string[][] = []
const reg: Registry = { [ROOT]: P }
let w = w0
log.forEach((en, i) => {
  const before = w.convs[en.c], r = stepWorld(w, en, reg); w = r.w
  const U0 = before.ledger.usage, U1 = w.convs[en.c].ledger.usage, e = en.e
  const read = U1.cacheRead - U0.cacheRead, write = U1.cacheWrite - U0.cacheWrite, fresh = U1.input - U0.input
  const usd = w.convs[en.c].ledger.usd - before.ledger.usd, tool = (id: string) => before.pending[id]?.call.tool ?? '?'
  let tag = 'ACT', what = ''
  if (e.t === 'input') en.c === ROOT ? (what = `user: "${e.item.text}"`) : ((tag = 'REL'), (what = `child receives its brief (${e.item.tokens} tok)`))
  else if (e.t === 'sampled') {
    tag = 'SEE'
    const prompt = `prompt ${k(read + write + fresh)} (cache read ${k(read)}, write ${k(write)}, new ${k(fresh)})`
    what = e.purpose === 'compact' ? `compaction summary replaces the history; ${prompt}` : `${e.item.calls?.map(c => c.tool).join(' + ') ?? 'final answer'}: ${prompt}, reply ${e.item.tokens} tok`
  } else if (e.t === 'result') {
    if (e.item.text?.startsWith('child')) { tag = 'REL'; what = `child's summary returns to the parent (${e.item.tokens} tok)` }
    else what = `${tool(e.item.callId!)} result enters the context (${e.item.tokens} tok)`
  } else if (e.t === 'verdict') what = `human ${e.allow ? 'approves' : 'denies'} ${tool(e.callId)}`
  else if (e.t === 'hidden') { tag = 'SEE'; what = `hidden turn-end request (reply discarded): prompt ${k(read + write + fresh)} (cache read ${k(read)}, write ${k(write)}), it caches the final reply` }
  else if (e.t === 'expire') { tag = 'SEE'; what = 'pause past the cache lifetime: the provider drops the cache' }
  else what = e.t
  rows.push([String(i + 1), label(en.c), tag, what, usd ? `$${usd.toFixed(4)}` : ''])
  const note = (t: string, s: string) => rows.push(['', '', t, `  ↳ ${s}`, ''])
  for (const { f } of r.fx) {
    if (f.k === 'sample' && f.purpose === 'compact') note('SEE', `context policy: prompt is ${k(f.prompt.reduce((n, x) => n + x.tokens, 0))}, over the limit, so compact first`)
    if (f.k === 'ask') note('ACT', `permission policy: ${f.call.tool} needs approval`)
    if (f.k === 'halt') note('ACT', `budget policy: halt (${f.reason})`)
  }
  for (const x of r.emit) if (x.c !== en.c && x.e.t === 'input') note('REL', `spawn policy: ${label(x.c)} created (edges: owner, message, prefix)`)
})

const L = rollup(w1), own = w1.convs[ROOT].ledger.usd
const pad = (cells: string[]) => `${cells[0].padStart(2)}  ${cells[1].padEnd(6)}  ${cells[2].padEnd(3)}  ${cells[3].padEnd(100)}  ${cells[4].padStart(8)}`
console.log('SEE = prompt built and billed   ACT = decision on calls, approval, stopping   REL = crossed between logs\n')
console.log(pad([' #', 'conv', 'tag', 'what happened', 'cost']))
rows.forEach(r => console.log(pad(r)))
const by = Object.entries(L.by).sort((a, b) => b[1] - a[1]).map(([name, usd]) => `${name} ${Math.round((100 * usd) / L.usd)}%`).join(', ')
console.log(`\ntotal $${L.usd.toFixed(4)} (root $${own.toFixed(4)}, children $${(L.usd - own).toFixed(4)}), ${L.samples} model calls, ${spawns(w1)} child conversation(s)`)
console.log(`where the money went: ${by}`)
deepStrictEqual(replayWorld(w0, log, P), w1)
console.log(`KEEP: replaying the ${log.length} log entries from the start rebuilds the world exactly (checked)`)
