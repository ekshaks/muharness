// Simulation: one scripted coding task, run through every bundle with a mocked model and tools.
// The mock is a handler; the core, policies and cost arithmetic are the real ones.
import { deepStrictEqual } from 'node:assert'
import { Call, Entry, Event, HandlerFactory, Handlers, Hook, Item, Purpose, ROOT, init, originOf, replayWorld, rollup, run, spawns as nSpawns, world } from './core.js'
import { pause } from './timing.js'
import { Bundle, ablations, archetypes, item, uid } from './policies.js'

type Step = { tool: string; out: number } | { explore: { tool: string; out: number }[] } | { end: true }   // end: the model stops the turn here
/** The "world": what the model will do, and how big each tool output is. `explore` is delegable.
 *  `mixed` is the original task; the others isolate one task shape each, so a setting's effect can be compared across shapes. */
const TASKS: Record<string, Step[]> = {
  mixed: [
    { tool: 'grep', out: 1200 },
    { explore: [{ tool: 'read', out: 6000 }, { tool: 'read', out: 9000 }, { tool: 'read', out: 5000 }, { tool: 'grep', out: 1500 }] },
    { tool: 'read', out: 7000 }, { tool: 'edit', out: 300 }, { tool: 'bash', out: 8000 },
    { tool: 'read', out: 4000 }, { tool: 'edit', out: 300 }, { tool: 'bash', out: 8000 },
    { tool: 'edit', out: 200 }, { tool: 'bash', out: 2500 },
  ],
  singleEdit: [{ tool: 'grep', out: 800 }, { tool: 'read', out: 3000 }, { tool: 'edit', out: 200 }, { tool: 'bash', out: 2500 }],
  wideSearch: [
    { tool: 'grep', out: 1500 },
    { explore: [{ tool: 'read', out: 6000 }, { tool: 'read', out: 8000 }, { tool: 'read', out: 7000 }, { tool: 'grep', out: 2000 }, { tool: 'read', out: 6000 }] },
    { explore: [{ tool: 'read', out: 5000 }, { tool: 'read', out: 4000 }, { tool: 'grep', out: 1200 }] },
    { tool: 'edit', out: 300 }, { tool: 'bash', out: 3000 },
  ],
  debugLoop: [
    { tool: 'read', out: 4000 },
    ...Array.from({ length: 6 }, (_, k): Step[] => [{ tool: 'edit', out: 300 }, { tool: 'bash', out: 6000 }, ...(k % 2 ? [{ tool: 'read', out: 3000 }] : [])]).flat(),
  ],
}
const call = (tool: string, args: Record<string, unknown>): Call => ({ id: uid('c'), tool, args })
/** `npm run sim -- --retrieve 0.2`: in setups that offer a `retrieve` tool, the mock model asks for the full original of 1 in 5 tool results
 *  that `shape` made smaller (caveman's `retrieve` tool). The full original then enters context too. Off by default, so the stored tables do not change. */
const flag = process.argv.indexOf('--retrieve'), RETRIEVE = flag < 0 ? 0 : Number(process.argv[flag + 1])
if (!(RETRIEVE >= 0 && RETRIEVE <= 1)) throw new Error('--retrieve needs a rate from 0 to 1')

/** Mock model: follows the script; delegates `explore` if an agent tool is offered, else reads in parallel.
 *  If `script` is offered (code mode), an edit followed by a test run becomes one script whose output is the test output.
 *  If `load_tool` is offered (deferred tools), it first loads the description of any tool not yet in its prompt. */
function mockModel(script: Step[], effort: number, defer = 0) {
  let i = 0, shrunk = 0
  const sizes = new Map<string, number>(), seen = new Set<string>()   // original output size by call id; results already looked at
  return async (prompt: Item[], purpose: Purpose): Promise<Item> => {
    if (purpose === 'compact') return item('summary', 2000, 'summary of progress')
    if (RETRIEVE && prompt.some(p => p.role === 'tools' && p.text?.split(' ').includes('retrieve'))) {   // only setups that offer the tool; every (1/rate)-th smaller result
      const want: Call[] = []
      for (const p of prompt) if (p.role === 'tool' && p.callId && !seen.has(p.callId)) {
        seen.add(p.callId)
        const full = sizes.get(p.callId)
        if (full !== undefined && p.tokens < full && ++shrunk % Math.round(1 / RETRIEVE) === 0) want.push(call('retrieve', { out: full }))
      }
      if (want.length) return { ...item('assistant', 60 * want.length), calls: want }
    }
    const offers = (t: string) => prompt.some(p => p.role === 'tools' && p.text?.split(' ').includes(t))
    const st = script[i], nx = script[i + 1]
    if (!st) return item('assistant', 400, 'done: summary of findings')
    if ('end' in st) { i++; return item('assistant', 200, 'stopping here for now') }
    const pair = offers('script') && 'tool' in st && st.tool === 'edit' && nx && 'tool' in nx && nx.tool === 'bash'
    const calls = pair ? [call('script', { out: (nx as { out: number }).out })]
      : 'explore' in st
      ? offers('agent') ? [call('agent', { task: 'explore the auth module', steps: st.explore })] : st.explore.map(x => call(x.tool, { out: x.out }))
      : [call(st.tool, { out: st.out })]
    if (offers('load_tool')) {
      const loaded = new Set(prompt.map(p => p.text?.match(/^desc:(.+)/)?.[1]))
      const need = [...new Set(calls.map(c => c.tool))].filter(t => !loaded.has(t))
      if (need.length) return { ...item('assistant', 60 * need.length), calls: need.map(t => call('load_tool', { name: t, out: defer })) }
    }
    i += pair ? 2 : 1
    for (const c of calls) sizes.set(c.id, Number(c.args.out))
    return { ...item('assistant', effort + 60 * calls.length), calls }
  }
}
function handlers(b: Bundle, script: Step[]): Handlers {
  return {
    sample: mockModel(script, b.effort, b.defer),
    tool: async c => ({ ...item('tool', Number(c.args.out), c.tool === 'load_tool' ? `desc:${c.args.name}` : undefined), callId: c.id }),
    ask: async () => true,                                   // the "human" approves everything
  }
}

/** `between`: if given, the task has an `end` step; the user comes back after it, and these events (a pause) come first. */
async function simulate(b: Bundle, task = TASKS.mixed, between?: Event[]) {
  const w0 = world(init([
    { name: 'system', items: [item('system', b.prefix.system)] },
    { name: 'tools', items: [item('tools', b.prefix.tools, b.tools.join(' '))] },
    ...(b.prefix.memory ? [{ name: 'memory', items: [item('memory', b.prefix.memory)] }] : []),
  ]))
  // a child conversation's script comes from the call that spawned it
  const hs: Record<string, Handlers> = {}                 // kept across turns, so the mock model goes on with its script
  const H: HandlerFactory = (c, w) => (hs[c] ??= handlers(b, c === ROOT ? task : (originOf(w, c)!.args.steps as Step[])))
  const counts: Record<string, number> = {}
  const audit: Hook = { effect: f => ((counts[f.k] = (counts[f.k] ?? 0) + 1), f) }   // hooks observe or rewrite
  let { world: w1, log } = await run(w0, [{ c: ROOT, e: { t: 'input', item: item('user', 150, 'fix the login bug') } }], b.P, H, [audit])
  if (between) {
    const back: Entry[] = [...between.map(e => ({ c: ROOT, e })), { c: ROOT, e: { t: 'input', item: item('user', 50, 'continue') } }]
    const r = await run(w1, back, b.P, H, [audit]); w1 = r.world; log = [...log, ...r.log]
  }
  deepStrictEqual(replayWorld(w0, log, b.P), w1)                                      // replay is exact, children included
  return { b, L: rollup(w1), spawns: nSpawns(w1), turns: w1.convs[ROOT].turns, asks: counts.ask ?? 0, compactions: log.filter(x => x.c === ROOT && x.e.t === 'sampled' && x.e.purpose === 'compact').length }
}

const k = (x: number) => `${(x / 1000).toFixed(0)}k`
const pct = (x = 0, of: number) => `${Math.round((100 * x) / of)}%`
function table(title: string, rows: Awaited<ReturnType<typeof simulate>>[]) {
  console.log(`\n${title}`)
  console.table(Object.fromEntries(rows.map(({ b, L, turns, asks, compactions, spawns }) => [b.like ? `${b.name} (~${b.like})` : b.name, {
    $: L.usd.toFixed(3), samples: L.samples, turns, spawns, compact: compactions, asks,
    'in': k(L.usage.input), 'cache r': k(L.usage.cacheRead), 'cache w': k(L.usage.cacheWrite), out: k(L.usage.output),
    prefix: pct((L.by.system ?? 0) + (L.by.tools ?? 0) + (L.by.memory ?? 0), L.usd),
    history: pct((L.by.user ?? 0) + (L.by.assistant ?? 0) + (L.by.summary ?? 0), L.usd),
    'tool out': pct(L.by.tool, L.usd), output: pct(L.by.output, L.usd), child: pct(L.by.child, L.usd),
  }])))
}

const main = await Promise.all(archetypes.map(b => simulate(b)))
if (RETRIEVE) console.log(`--retrieve ${RETRIEVE}: the model asks for the full original of 1 in ${Math.round(1 / RETRIEVE)} results that were made smaller`)
table('Archetypes on the same task (illustrative parameters; replay verified for every run)', main)
table('One-knob ablations', await Promise.all(ablations().map(b => simulate({ ...b, like: '' }))))

// The same setups on each task shape: does a setting's effect depend on the task?
const setups = [...archetypes, ...ablations()]
const byTask = await Promise.all(setups.map(b => Promise.all(Object.values(TASKS).map(t => simulate(b, t)))))
console.log('\nCost per task shape, $ (samples)')
console.table(Object.fromEntries(setups.map((b, i) => [b.name, Object.fromEntries(Object.keys(TASKS).map((t, j) => [t, `${byTask[i][j].L.usd.toFixed(3)} (${byTask[i][j].L.samples})`]))])))

// A pause between two turns: the user stops after the first test run and comes back later. Claude's 1-hour cache (src/timing.ts).
// Without warms, a pause longer than the lifetime writes the whole prompt again. With caveman's warm rule, a warm at 54 minutes keeps it alive.
const twoTurns: Step[] = [...TASKS.mixed.slice(0, 5), { end: true }, ...TASKS.mixed.slice(5)]
const rich = archetypes.find(b => b.name === 'rich')!
console.log('\nA pause between two turns (rich, mixed task with a stop after the first test run, 1-hour cache), $')
console.table(Object.fromEntries(await Promise.all([0, 30, 70, 120].map(async m => {
  const cold = pause(m * 60_000), hot = pause(m * 60_000, { warm: true })
  const [a, w] = await Promise.all([simulate(rich, twoTurns, cold), simulate(rich, twoTurns, hot)])
  return [`${m} min`, { 'no warm': a.L.usd.toFixed(3), 'with warms': w.L.usd.toFixed(3), warms: hot.filter(e => e.t === 'hidden').length, 'cache expired': `${cold.some(e => e.t === 'expire') ? 'yes' : 'no'} / ${hot.some(e => e.t === 'expire') ? 'yes' : 'no'}` }]
}))))
