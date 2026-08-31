import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DECK_POINTS,
  RANKS,
  buildDeck,
  card,
  sortHand,
  totalPoints,
} from './cards'
import { DEFAULT_RULES, TRICKS_PER_HAND, legalMoves, scoreHand, teamOf, trickWinner } from './rules'
import { createGame, needsResolve, reduce } from './engine'
import { botAction } from './bots'
import type { GameState, PlayerConfig, Seat, Trick } from './types'

const PLAYERS: PlayerConfig[] = [
  { seat: 0, name: 'Nimal', isBot: true },
  { seat: 1, name: 'Kavi', isBot: true },
  { seat: 2, name: 'Ruwan', isBot: true },
  { seat: 3, name: 'Dilani', isBot: true },
]

const trick = (leader: Seat, plays: [Seat, string][]): Trick => ({
  leader,
  plays: plays.map(([seat, cardId]) => ({ seat, cardId })),
})

describe('the deck', () => {
  it('holds 32 distinct cards', () => {
    const deck = buildDeck()
    assert.equal(deck.length, 32)
    assert.equal(new Set(deck).size, 32)
  })

  it('is worth exactly 304 points — the whole point of the name', () => {
    assert.equal(totalPoints(buildDeck()), DECK_POINTS)
  })

  it('is worth 76 per suit', () => {
    const spades = buildDeck().filter((id) => card(id).suit === 'S')
    assert.equal(totalPoints(spades), 76)
  })

  it('ranks Jack and Nine above the Ace', () => {
    assert.deepEqual([...RANKS], ['J', '9', 'A', '10', 'K', 'Q', '8', '7'])
    assert.ok(card('JS').strength > card('9S').strength)
    assert.ok(card('9S').strength > card('AS').strength)
    assert.ok(card('AS').strength > card('10S').strength)
    assert.ok(card('10S').strength > card('KS').strength)
  })

  it('parses the ten without tripping over the two-character rank', () => {
    assert.equal(card('10H').rank, '10')
    assert.equal(card('10H').suit, 'H')
    assert.equal(card('10H').value, 10)
  })

  it('sorts a hand by suit with the trump first', () => {
    const sorted = sortHand(['7S', 'JH', 'AS', '9H'], 'H')
    assert.deepEqual(sorted, ['JH', '9H', 'AS', '7S'])
  })
})

describe('winning a trick', () => {
  it('gives it to the highest card of the led suit', () => {
    const t = trick(0, [
      [0, '10S'],
      [1, 'KS'],
      [2, '9S'],
      [3, 'AS'],
    ])
    assert.equal(trickWinner(t, null, false), 2, 'the Nine beats the Ace in 304')
  })

  it('ignores cards that cannot follow', () => {
    const t = trick(0, [
      [0, '7S'],
      [1, 'JH'],
      [2, 'JD'],
      [3, '8S'],
    ])
    assert.equal(trickWinner(t, null, false), 3)
  })

  it('lets a trump beat the led suit once it is revealed', () => {
    const t = trick(0, [
      [0, 'JS'],
      [1, '7H'],
      [2, '8S'],
      [3, '7S'],
    ])
    assert.equal(trickWinner(t, 'H', true), 1)
  })

  it('treats a trump-suit card as an ordinary discard while it is still face down', () => {
    const t = trick(0, [
      [0, 'JS'],
      [1, '7H'],
      [2, '8S'],
      [3, '7S'],
    ])
    assert.equal(trickWinner(t, 'H', false), 0)
  })

  it('gives it to the highest trump when several are played', () => {
    const t = trick(0, [
      [0, 'JS'],
      [1, '7H'],
      [2, '9H'],
      [3, 'QH'],
    ])
    assert.equal(trickWinner(t, 'H', true), 2)
  })
})

describe('legal moves', () => {
  const playing = (): GameState => {
    let s = createGame({ players: PLAYERS, seed: 42, dealer: 0 })
    while (s.phase === 'bidding') s = step(s)
    while (s.phase === 'choosing-trump') s = step(s)
    return s
  }

  it('locks the declarer out of their own face-down card', () => {
    const s = playing()
    const declarer = s.declarer as Seat
    assert.ok(s.concealedCardId)
    assert.ok(s.hands[declarer].includes(s.concealedCardId!))
    assert.ok(!legalMoves(s, declarer).playable.includes(s.concealedCardId!))
    assert.deepEqual(legalMoves(s, declarer).blocked.includes(s.concealedCardId!), true)
  })

  it('forces you to follow the led suit when you can', () => {
    let s = playing()
    const leader = s.turn
    const lead = legalMoves(s, leader).playable[0]
    const ledSuit = card(lead).suit
    s = reduce(s, { type: 'PLAY', seat: leader, cardId: lead })

    const next = s.turn
    const holdings = s.hands[next].filter((id) => card(id).suit === ledSuit)
    const moves = legalMoves(s, next)
    if (holdings.length > 0) {
      assert.deepEqual(new Set(moves.playable), new Set(holdings))
    } else {
      assert.ok(moves.canCallTrump, 'a void player should be offered the call')
    }
  })

  it('only lets the seat on turn act', () => {
    const s = playing()
    const other = (s.turn + 1) % 4
    assert.equal(legalMoves(s, other).playable.length, 0)
  })

  it('refuses a fifth card once the trick is full', () => {
    let s = playing()
    for (let i = 0; i < 4; i++) {
      const seat = s.turn
      s = reduce(s, { type: 'PLAY', seat, cardId: legalMoves(s, seat).playable[0] })
    }
    assert.equal(s.currentTrick?.plays.length, 4)

    for (const seat of [0, 1, 2, 3] as Seat[]) {
      assert.equal(legalMoves(s, seat).playable.length, 0, `seat ${seat} should be locked out`)
    }

    const seat = s.turn
    const stray = s.hands[seat][0]
    const after = reduce(s, { type: 'PLAY', seat, cardId: stray })
    assert.equal(after.currentTrick?.plays.length, 4, 'the trick must not grow')
    assert.ok(after.log.some((l) => l.startsWith('⚠︎')))
  })
})

describe('scoring a hand', () => {
  const noTricks: Trick[] = []

  it('awards the contract when the declaring team gets there', () => {
    const score = scoreHand(DEFAULT_RULES, 0, 150, [160, 144], noTricks)
    assert.equal(score.made, true)
    assert.deepEqual(score.gamePoints, [1, 0])
  })

  it('pays the defenders when the declarer falls short', () => {
    const score = scoreHand(DEFAULT_RULES, 0, 150, [149, 155], noTricks)
    assert.equal(score.made, false)
    assert.deepEqual(score.gamePoints, [0, 1])
  })

  it('doubles the stake on a big contract, in both directions', () => {
    const won = scoreHand(DEFAULT_RULES, 1, 250, [50, 254], noTricks)
    assert.deepEqual(won.gamePoints, [0, 2])
    const lost = scoreHand(DEFAULT_RULES, 1, 250, [100, 204], noTricks)
    assert.deepEqual(lost.gamePoints, [2, 0])
  })

  it('adds a bonus for sweeping all eight tricks', () => {
    const sweep: Trick[] = Array.from({ length: TRICKS_PER_HAND }, (_, i) => ({
      leader: 0,
      plays: [],
      winner: i % 2 === 0 ? 0 : 2,
      points: 0,
    }))
    const score = scoreHand(DEFAULT_RULES, 0, 200, [304, 0], sweep)
    assert.equal(score.capot, true)
    assert.deepEqual(score.gamePoints, [2, 0])
  })
})

/** Drive whichever seat is on turn using the bot, one action at a time. */
function step(state: GameState): GameState {
  if (needsResolve(state)) return reduce(state, { type: 'RESOLVE_TRICK' })
  if (state.phase === 'hand-over') return reduce(state, { type: 'NEXT_HAND' })
  const seat = state.phase === 'choosing-trump' ? (state.declarer as Seat) : state.turn
  const action = botAction(state, seat)
  if (!action) throw new Error(`Bot had nothing to do in phase "${state.phase}"`)
  return reduce(state, action)
}

describe('playing whole games', () => {
  it('runs 200 matches to completion without an illegal move or a stuck turn', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let s = createGame({ players: PLAYERS, seed, dealer: seed % 4 })
      let guard = 0

      while (s.phase !== 'match-over') {
        s = step(s)
        assert.ok(++guard < 5000, `seed ${seed} did not finish`)
        assert.equal(
          s.log.some((line) => line.startsWith('⚠︎')),
          false,
          `seed ${seed} produced an illegal move: ${s.log.filter((l) => l.startsWith('⚠︎')).join(' | ')}`,
        )
      }

      assert.ok(s.history.length > 0)
      for (const hand of s.history) {
        assert.equal(
          hand.cardPoints[0] + hand.cardPoints[1],
          DECK_POINTS,
          `seed ${seed} hand ${hand.handNumber} lost points`,
        )
        assert.equal(hand.made, hand.cardPoints[hand.declaringTeam] >= hand.bid)
      }
      assert.ok(
        Math.max(s.gamePoints[0], s.gamePoints[1]) >= DEFAULT_RULES.targetGamePoints,
        `seed ${seed} ended without a winner`,
      )
    }
  })

  it('deals every card exactly once and empties every hand', () => {
    let s = createGame({ players: PLAYERS, seed: 7, dealer: 0 })
    const dealt = [0, 1, 2, 3].flatMap((seat) => [...s.hands[seat], ...s.pending[seat]])
    assert.equal(dealt.length, 32)
    assert.equal(new Set(dealt).size, 32)

    while (s.phase === 'bidding' || s.phase === 'choosing-trump') s = step(s)
    for (const seat of [0, 1, 2, 3]) assert.equal(s.hands[seat].length, 8)

    while (s.phase === 'playing') s = step(s)
    for (const seat of [0, 1, 2, 3]) assert.equal(s.hands[seat].length, 0)
    assert.equal(s.tricks.length, TRICKS_PER_HAND)
  })

  it('is reproducible from its seed', () => {
    const run = (): GameState => {
      let s = createGame({ players: PLAYERS, seed: 12345, dealer: 2 })
      while (s.phase !== 'match-over') s = step(s)
      return s
    }
    const a = run()
    const b = run()
    assert.deepEqual(a.gamePoints, b.gamePoints)
    assert.deepEqual(a.log, b.log)
  })

  it('never lets a trick be won by a seat that did not play in it', () => {
    let s = createGame({ players: PLAYERS, seed: 99, dealer: 1 })
    while (s.phase !== 'match-over') {
      s = step(s)
      for (const t of s.tricks) {
        assert.ok(t.plays.some((p) => p.seat === t.winner))
        assert.equal(t.plays.length, 4)
      }
    }
  })

  it('keeps the trump hidden until somebody calls for it', () => {
    let s = createGame({ players: PLAYERS, seed: 2024, dealer: 0 })
    while (s.phase === 'bidding' || s.phase === 'choosing-trump') s = step(s)
    assert.equal(s.trumpRevealed, false)
    assert.ok(s.trump, 'the declarer knows the trump even while it is face down')

    while (s.phase === 'playing' && !s.trumpRevealed) s = step(s)
    // Either somebody called, or the hand ran to the last trick untrumped.
    assert.ok(s.trumpRevealed || s.concealedReturned || s.phase !== 'playing')
  })

  it('gives the declaring team a share of the points that matches its tricks', () => {
    let s = createGame({ players: PLAYERS, seed: 555, dealer: 3 })
    while (s.phase === 'bidding' || s.phase === 'choosing-trump') s = step(s)
    while (s.phase === 'playing') s = step(s)

    const tally: [number, number] = [0, 0]
    for (const t of s.tricks) tally[teamOf(t.winner as Seat)] += t.points ?? 0
    assert.deepEqual(s.cardPoints, tally)
  })
})
