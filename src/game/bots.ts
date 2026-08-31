import { RANK_VALUE, SUITS, rankOf, suitOf, totalPoints, valueOf } from './cards'
import { legalMoves, partnerOf, teamOf, trickPoints, trickWinner } from './rules'
import type { CardId, GameAction, GameState, Seat, Suit, Trick } from './types'

/**
 * A deliberately modest opponent.
 *
 * It plays a tidy social game — it follows the obvious lines, feeds points to a
 * winning partner, and does not cheat by looking at hidden hands. It is here so
 * you can practise, and so the test suite can drive thousands of complete hands
 * without a human. Beating it should not feel like an achievement.
 */

export function botAction(state: GameState, seat: Seat): GameAction | null {
  switch (state.phase) {
    case 'bidding':
      return state.turn === seat ? bidAction(state, seat) : null
    case 'choosing-trump':
      return state.declarer === seat ? trumpAction(state, seat) : null
    case 'playing':
      return state.turn === seat ? playAction(state, seat) : null
    default:
      return null
  }
}

// --- bidding ---------------------------------------------------------------

/** Rough guess at what the four cards on view are worth in a played hand. */
export function evaluateOpeningHand(cards: CardId[]): { estimate: number; bestSuit: Suit } {
  const bySuit = groupBySuit(cards)
  let bestSuit: Suit = 'S'
  let bestScore = -Infinity

  for (const suit of SUITS) {
    const held = bySuit[suit] ?? []
    // Length matters more than raw points when you get to name the trump.
    const score = held.length * 18 + totalPoints(held) * 0.6 + (held.some((c) => rankOf(c) === 'J') ? 12 : 0)
    if (score > bestScore) {
      bestScore = score
      bestSuit = suit
    }
  }

  const honours = cards.filter((c) => ['J', '9', 'A'].includes(rankOf(c))).length
  const estimate = 110 + totalPoints(cards) * 0.55 + bestScore * 0.35 + honours * 6

  return { estimate: Math.round(estimate), bestSuit }
}

function bidAction(state: GameState, seat: Seat): GameAction {
  const moves = legalMoves(state, seat)
  const { estimate } = evaluateOpeningHand(state.hands[seat])

  if (!moves.bidRange) return { type: 'PASS', seat }

  const { min, step } = moves.bidRange
  if (!moves.canPass) {
    return { type: 'BID', seat, amount: min }
  }

  // Partner already holds the contract — no point bidding them up.
  if (state.currentBidder !== null && teamOf(state.currentBidder) === teamOf(seat)) {
    return { type: 'PASS', seat }
  }

  if (estimate >= min) {
    const stretch = Math.min(estimate, min + step * 2)
    const amount = Math.max(min, Math.floor(stretch / step) * step)
    return { type: 'BID', seat, amount: Math.min(amount, moves.bidRange.max) }
  }

  return { type: 'PASS', seat }
}

function trumpAction(state: GameState, seat: Seat): GameAction {
  const hand = state.hands[seat]
  const { bestSuit } = evaluateOpeningHand(hand)
  const inSuit = hand.filter((c) => suitOf(c) === bestSuit)
  // Set aside the cheapest card of the chosen suit — the face-down card is out
  // of play for a while, so it should not be the Jack.
  const pick = [...inSuit].sort((a, b) => valueOf(a) - valueOf(b))[0] ?? hand[0]
  return { type: 'SET_TRUMP', seat, cardId: pick }
}

// --- play ------------------------------------------------------------------

function playAction(state: GameState, seat: Seat): GameAction {
  const moves = legalMoves(state, seat)
  const trick = state.currentTrick
  if (!trick) return { type: 'PASS', seat }

  // Void, trump still face down: call for it when the pot is worth taking and
  // there is a realistic chance of winning it.
  if (moves.canCallTrump) {
    const pot = trickPoints(trick)
    const myTrumps = state.hands[seat].filter((c) => suitOf(c) === state.trump)
    const partnerWinning = isPartnerWinning(state, seat, trick)
    if (!partnerWinning && pot >= 13 && (myTrumps.length > 0 || seat === state.declarer)) {
      return { type: 'CALL_TRUMP', seat }
    }
  }

  const options = moves.playable
  if (options.length === 0) return { type: 'PASS', seat }
  if (options.length === 1) return { type: 'PLAY', seat, cardId: options[0] }

  if (trick.plays.length === 0) return { type: 'PLAY', seat, cardId: chooseLead(state, options) }

  const partnerWinning = isPartnerWinning(state, seat, trick)
  const pot = trickPoints(trick)

  if (partnerWinning) {
    // Partner has it — throw the points their way, but only if it is safe-ish.
    const lastToPlay = trick.plays.length === 3
    if (lastToPlay || pot < 20) return { type: 'PLAY', seat, cardId: richest(options) }
    return { type: 'PLAY', seat, cardId: cheapest(options) }
  }

  const winners = options.filter((cardId) => wouldWin(state, trick, seat, cardId))
  if (winners.length > 0) {
    // Win it as cheaply as possible, unless the trick is fat enough to justify
    // spending a big card on it.
    const sorted = [...winners].sort((a, b) => valueOf(a) - valueOf(b))
    return { type: 'PLAY', seat, cardId: pot >= 20 ? sorted[sorted.length - 1] : sorted[0] }
  }

  return { type: 'PLAY', seat, cardId: cheapest(options) }
}

function chooseLead(state: GameState, options: CardId[]): CardId {
  const bySuit = groupBySuit(options)
  // Lead a suit where we hold the Jack — the top card and 30 points at once.
  for (const suit of SUITS) {
    const held = bySuit[suit] ?? []
    if (held.some((c) => rankOf(c) === 'J')) {
      return held.find((c) => rankOf(c) === 'J')!
    }
  }
  // Otherwise get rid of a cheap card and keep the powder dry.
  return cheapest(options)
}

function wouldWin(state: GameState, trick: Trick, seat: Seat, cardId: CardId): boolean {
  const probe: Trick = { ...trick, plays: [...trick.plays, { seat, cardId }] }
  return trickWinner(probe, state.trump, state.trumpRevealed) === seat
}

function isPartnerWinning(state: GameState, seat: Seat, trick: Trick): boolean {
  if (trick.plays.length === 0) return false
  const leader = trickWinner(trick, state.trump, state.trumpRevealed)
  return leader === partnerOf(seat)
}

const cheapest = (ids: CardId[]): CardId =>
  [...ids].sort((a, b) => valueOf(a) - valueOf(b) || RANK_VALUE[rankOf(a)] - RANK_VALUE[rankOf(b)])[0]

const richest = (ids: CardId[]): CardId => [...ids].sort((a, b) => valueOf(b) - valueOf(a))[0]

function groupBySuit(ids: CardId[]): Partial<Record<Suit, CardId[]>> {
  const out: Partial<Record<Suit, CardId[]>> = {}
  for (const id of ids) {
    const s = suitOf(id)
    ;(out[s] ??= []).push(id)
  }
  return out
}
