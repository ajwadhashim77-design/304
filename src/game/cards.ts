import type { Card, CardId, Rank, Suit } from './types'

export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'] as const

/**
 * 304's trick-taking order, strongest first. The Jack and Nine outranking the
 * Ace is what catches new players out, and it is also why they are the two
 * biggest point cards.
 */
export const RANKS: readonly Rank[] = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'] as const

/** Point values. One suit is worth 76, so the full deck is worth exactly 304. */
export const RANK_VALUE: Record<Rank, number> = {
  J: 30,
  '9': 20,
  A: 11,
  '10': 10,
  K: 3,
  Q: 2,
  '8': 0,
  '7': 0,
}

export const SUIT_NAME: Record<Suit, string> = {
  S: 'Spades',
  H: 'Hearts',
  D: 'Diamonds',
  C: 'Clubs',
}

export const SUIT_SYMBOL: Record<Suit, string> = {
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣',
}

export const SUIT_IS_RED: Record<Suit, boolean> = { S: false, H: true, D: true, C: false }

/** Strength within a suit — index-based so RANKS stays the single source of truth. */
export const RANK_STRENGTH: Record<Rank, number> = RANKS.reduce(
  (acc, rank, i) => {
    acc[rank] = RANKS.length - 1 - i
    return acc
  },
  {} as Record<Rank, number>,
)

const CARD_CACHE = new Map<CardId, Card>()

export function makeCard(rank: Rank, suit: Suit): Card {
  const id = `${rank}${suit}`
  const cached = CARD_CACHE.get(id)
  if (cached) return cached
  const card: Card = {
    id,
    rank,
    suit,
    value: RANK_VALUE[rank],
    strength: RANK_STRENGTH[rank],
  }
  CARD_CACHE.set(id, card)
  return card
}

/** Suit is always the final character, so `10H` parses correctly. */
export function card(id: CardId): Card {
  const cached = CARD_CACHE.get(id)
  if (cached) return cached
  const suit = id.slice(-1) as Suit
  const rank = id.slice(0, -1) as Rank
  if (!SUITS.includes(suit) || !RANKS.includes(rank)) {
    throw new Error(`Not a 304 card: "${id}"`)
  }
  return makeCard(rank, suit)
}

export const suitOf = (id: CardId): Suit => card(id).suit
export const rankOf = (id: CardId): Rank => card(id).rank
export const valueOf = (id: CardId): number => card(id).value
export const strengthOf = (id: CardId): number => card(id).strength

/** The 32-card 304 deck, in a fixed order. Shuffling is the caller's job. */
export function buildDeck(): CardId[] {
  const deck: CardId[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(makeCard(rank, suit).id)
    }
  }
  return deck
}

export const DECK_POINTS = 304

export function totalPoints(ids: readonly CardId[]): number {
  let sum = 0
  for (const id of ids) sum += valueOf(id)
  return sum
}

/** Sort for display: grouped by suit, strongest first within each suit. */
export function sortHand(ids: readonly CardId[], trump?: Suit | null): CardId[] {
  const suitOrder = (s: Suit) => {
    const base = SUITS.indexOf(s)
    // Keep trump on the far left so the declarer can see it at a glance.
    return trump && s === trump ? -1 : base
  }
  return [...ids].sort((a, b) => {
    const ca = card(a)
    const cb = card(b)
    const bySuit = suitOrder(ca.suit) - suitOrder(cb.suit)
    if (bySuit !== 0) return bySuit
    return cb.strength - ca.strength
  })
}

export function cardLabel(id: CardId): string {
  const c = card(id)
  return `${c.rank}${SUIT_SYMBOL[c.suit]}`
}
