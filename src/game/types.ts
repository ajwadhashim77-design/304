/**
 * Core types for 304.
 *
 * Everything in `src/game` is pure TypeScript with zero framework or DOM
 * dependencies. That is deliberate: the same module is imported by the web UI
 * today and can be dropped into a React Native / Expo app, or run on a server
 * for authoritative online play, without a single change.
 */

export type Suit = 'S' | 'H' | 'D' | 'C'

/** Ranks listed strongest first. This is 304's order, not poker's. */
export type Rank = 'J' | '9' | 'A' | '10' | 'K' | 'Q' | '8' | '7'

/** A card id is rank + suit, e.g. `JS`, `10H`, `7C`. */
export type CardId = string

export interface Card {
  id: CardId
  rank: Rank
  suit: Suit
  /** Point value counted at the end of the hand. */
  value: number
  /** Trick-taking strength within a suit. Higher wins. */
  strength: number
}

/** Seats are 0..3 clockwise. Partners sit opposite: 0+2 vs 1+3. */
export type Seat = number

export type TeamId = 0 | 1

export interface PlayerConfig {
  seat: Seat
  name: string
  /** A bot plays itself. Human seats wait for input from the UI/transport. */
  isBot: boolean
}

export type Phase =
  | 'bidding'
  | 'choosing-trump'
  | 'playing'
  | 'hand-over'
  | 'match-over'

export interface Bid {
  seat: Seat
  /** `null` means the player passed. */
  amount: number | null
}

export interface PlayedCard {
  seat: Seat
  cardId: CardId
}

export interface Trick {
  /** Seat that led this trick. */
  leader: Seat
  plays: PlayedCard[]
  /** Set once the trick is complete. */
  winner?: Seat
  /** Card points carried by the trick. Set once complete. */
  points?: number
}

export interface HandResult {
  handNumber: number
  dealer: Seat
  declarer: Seat
  declaringTeam: TeamId
  bid: number
  trump: Suit
  trumpWasRevealed: boolean
  /** Card points taken by each team this hand. Always sums to 304. */
  cardPoints: [number, number]
  made: boolean
  /** Declaring team swept all eight tricks. */
  capot: boolean
  /** Game points awarded this hand. */
  gamePoints: [number, number]
}

export interface RuleSet {
  /** Lowest legal opening bid. Traditionally 130. */
  minBid: number
  /** Highest legal bid — every point in the deck. */
  maxBid: number
  /** Bids must be a multiple of this. Most tables use 5. */
  bidStep: number
  /**
   * A bid at or above this level is worth double game points, win or lose.
   * Set to `maxBid + 1` to switch the double off.
   */
  doubleThreshold: number
  /** Game points for a normal made/failed contract. */
  gamePointsBase: number
  /** Extra game point for taking all eight tricks. */
  capotBonus: number
  /** Game points needed to win the match. */
  targetGamePoints: number
  /**
   * Who leads the first trick.
   * `left-of-dealer` is the common Sri Lankan rule; some tables let the
   * declarer lead instead.
   */
  firstLead: 'left-of-dealer' | 'declarer'
}

export interface GameState {
  rules: RuleSet
  players: PlayerConfig[]
  /** Seed for the next deal — kept in state so a game is fully reproducible. */
  seed: number
  handNumber: number
  dealer: Seat
  phase: Phase

  /** Cards currently held, by seat. Sorted for display. */
  hands: Record<Seat, CardId[]>
  /** Cards dealt but not yet handed out (the second packet of four). */
  pending: Record<Seat, CardId[]>

  // --- bidding ---
  bids: Bid[]
  /** Seats still live in the auction. */
  inAuction: Seat[]
  currentBid: number
  currentBidder: Seat | null
  turn: Seat

  // --- contract ---
  declarer: Seat | null
  contract: number | null
  trump: Suit | null
  /** The face-down card the declarer set aside. Its suit is the trump. */
  concealedCardId: CardId | null
  trumpRevealed: boolean
  /**
   * True once the declarer's face-down card is playable again. That happens
   * when somebody calls for the trump, or automatically before the last trick
   * if nobody ever did — in which case it returns to the hand as an ordinary
   * card and the whole hand is played without a trump.
   */
  concealedReturned: boolean
  /** Seat that called for the reveal and must now play a trump if able. */
  mustPlayTrump: Seat | null

  // --- play ---
  tricks: Trick[]
  currentTrick: Trick | null
  /** Card points banked by each team this hand. */
  cardPoints: [number, number]

  // --- match ---
  gamePoints: [number, number]
  history: HandResult[]
  /** Human-readable running commentary, newest last. */
  log: string[]
}

export type GameAction =
  | { type: 'BID'; seat: Seat; amount: number }
  | { type: 'PASS'; seat: Seat }
  | { type: 'SET_TRUMP'; seat: Seat; cardId: CardId }
  | { type: 'CALL_TRUMP'; seat: Seat }
  | { type: 'PLAY'; seat: Seat; cardId: CardId }
  | { type: 'RESOLVE_TRICK' }
  | { type: 'NEXT_HAND' }

/** What a seat is allowed to do right now. */
export interface LegalMoves {
  seat: Seat
  playable: CardId[]
  /** Cards in hand that are visible but not legal — greyed out in the UI. */
  blocked: CardId[]
  canCallTrump: boolean
  /** Bidding only. */
  bidRange: { min: number; max: number; step: number } | null
  canPass: boolean
  reason?: string
}
