// Observed-usage mode (V16) for Codex rollouts. Same idea as import-cc.ts: one item per call's new prompt tokens, replayed through the core.
// Codex logs, per call, the whole prompt (`input_tokens`, cached part included) and the cached part. There are no cache writes and no prices
// (subscription), so only tokens can be compared.
import { readFileSync } from 'node:fs'
import { Event, Item, Usage, init } from './core.js'
import { Imported } from './import-cc.js'

interface CodexUsage { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number }

export function importCodex(path: string): Imported {
  const calls: { u: CodexUsage; calls: string[] }[] = []
  let pending: string[] = [], model = ''
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const x = JSON.parse(line), p = x.payload ?? {}
    if (x.type === 'turn_context') model = p.model
    if (x.type === 'response_item' && /^(custom_tool_call|function_call)$/.test(p.type)) pending.push(p.call_id)
    if (x.type === 'event_msg' && p.type === 'token_count' && p.info) { calls.push({ u: p.info.last_token_usage, calls: pending }); pending = [] }
  }
  const warm = calls[0].u.cached_input_tokens                 // cached before this session started (instructions, tools)
  const s0 = init([{ name: 'prefix', items: [{ id: 'prefix', role: 'system', tokens: warm }] }], ['prefix'])
  const first: Event = { t: 'input', item: { id: 'u0', role: 'user', tokens: calls[0].u.input_tokens - warm } }
  const replies = calls.map(({ u, calls: ids }, k) => {
    const item: Item = { id: `a${k}`, role: 'assistant', tokens: u.output_tokens, calls: ids.map(id => ({ id, tool: 'tool', args: {} })) }
    const n = calls[k + 1], next: Event[] = []
    if (n) {
      const grew = n.u.input_tokens - u.input_tokens - u.output_tokens   // reasoning is sent back too (it never makes this negative)
      if (!ids.length) next.push({ t: 'input', item: { id: `u${k + 1}`, role: 'user', tokens: grew } })
      else ids.forEach((id, i) => next.push({ t: 'result', item: { id: `${id}:r`, role: 'tool', tokens: i ? 0 : grew, callId: id } }))
    }
    return { item, hidden: false, next }
  })
  const observed: Usage[] = calls.map(({ u }) => ({ input: u.input_tokens - u.cached_input_tokens, cacheRead: u.cached_input_tokens, cacheWrite: 0, output: u.output_tokens }))
  return { s0, first, replies, compactAbove: Infinity, model, observed }
}
