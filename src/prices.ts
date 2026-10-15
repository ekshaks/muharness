// Model prices, $ per million tokens. Prices change often, so they live here and nowhere else: update this file alone,
// with the date and the source. `write` is the cache-write price for the cache lifetime the harness uses
// (Claude Code writes 1-hour entries, billed at 2x input; 5-minute entries are 1.25x input).
import { Policies } from './core.js'

export type Price = Policies['price']

/** Real models, by model id. */
export const PRICES: Record<string, Price> = {
  // Checked 2026-10-04: reproduces the app's own total from its own token counts (cc-session-2, check V16). 1-hour writes.
  'claude-sonnet-5': { input: 2, write: 4, read: 0.2, output: 10 },
  // From the Claude API reference (model table cached 2026-10-06), read 2026-10-14. Not used by a check yet. 1-hour writes.
  'claude-sonnet-5-5': { input: 2, write: 4, read: 0.2, output: 10 },
  'claude-opus-5-5': { input: 4, write: 8, read: 0.2, output: 20 },
}

/** Illustrative prices for the simulator archetypes, not a real model (5-minute writes). */
export const PRICE: Price = { input: 3, write: 3.75, read: 0.3, output: 15 }
