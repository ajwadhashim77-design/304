/**
 * Headless soak test: play a pile of complete matches with bots and report on
 * the shape of the game. Useful for sanity-checking a rules change, and for
 * seeing whether the bidding thresholds produce sensible contracts.
 *
 *   npm run sim -- 500
 */
import { botAction, createGame, needsResolve, reduce } from '../src/game'
import { DECK_POINTS } from '../src/game/cards'
import type { GameState, PlayerConfig, Seat } from '../src/game/types'

const PLAYERS: PlayerConfig[] = [
  { seat: 0, name: 'North', isBot: true },
  { seat: 1, name: 'East', isBot: true },
  { seat: 2, name: 'South', isBot: true },
  { seat: 3, name: 'West', isBot: true },
]

function step(state: GameState): GameState {
  if (needsResolve(state)) return reduce(state, { type: 'RESOLVE_TRICK' })
  if (state.phase === 'hand-over') return reduce(state, { type: 'NEXT_HAND' })
  const seat = state.phase === 'choosing-trump' ? (state.declarer as Seat) : state.turn
  const action = botAction(state, seat)
  if (!action) throw new Error(`Nothing to do in phase ${state.phase}`)
  return reduce(state, action)
}

const matches = Number(process.argv[2] ?? 300)
let hands = 0
let made = 0
let capots = 0
let calls = 0
let bidTotal = 0
let warnings = 0
const bidBuckets = new Map<number, number>()

console.time('simulated')
for (let seed = 1; seed <= matches; seed++) {
  let s = createGame({ players: PLAYERS, seed, dealer: seed % 4 })
  let guard = 0
  while (s.phase !== 'match-over') {
    s = step(s)
    if (++guard > 6000) throw new Error(`seed ${seed} never finished`)
  }
  warnings += s.log.filter((l) => l.startsWith('⚠︎')).length
  for (const hand of s.history) {
    hands++
    if (hand.made) made++
    if (hand.capot) capots++
    if (hand.trumpWasRevealed) calls++
    bidTotal += hand.bid
    const bucket = Math.floor(hand.bid / 20) * 20
    bidBuckets.set(bucket, (bidBuckets.get(bucket) ?? 0) + 1)
    if (hand.cardPoints[0] + hand.cardPoints[1] !== DECK_POINTS) {
      throw new Error(`seed ${seed}: card points did not total ${DECK_POINTS}`)
    }
  }
}
console.timeEnd('simulated')

const pct = (n: number) => `${((n / hands) * 100).toFixed(1)}%`
console.log(`
matches       ${matches}
hands         ${hands}
contracts made ${made} (${pct(made)})
trump called   ${calls} (${pct(calls)})
all eight      ${capots} (${pct(capots)})
average bid    ${(bidTotal / hands).toFixed(1)}
illegal moves  ${warnings}
`)
console.log('bid distribution')
for (const bucket of [...bidBuckets.keys()].sort((a, b) => a - b)) {
  const n = bidBuckets.get(bucket)!
  console.log(`  ${bucket}–${bucket + 19}`.padEnd(14), '█'.repeat(Math.round((n / hands) * 120)), n)
}

if (warnings > 0) process.exit(1)
