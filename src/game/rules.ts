import { card, DECK_POINTS, SUIT_SYMBOL, suitOf, totalPoints } from './cards'
import type {
  CardId,
  GameState,
  LegalMoves,
  RuleSet,
  Seat,
  Suit,
  TeamId,
  Trick,
} from './types'

export const SEATS: readonly Seat[] = [0, 1, 2, 3]
export const HAND_SIZE = 8
export const TRICKS_PER_HAND = 8

/** Partners sit opposite each other: seats 0 & 2 play seats 1 & 3. */
export const teamOf = (seat: Seat): TeamId => (seat % 2) as TeamId
export const partnerOf = (seat: Seat): Seat => (seat + 2) % 4
export const nextSeat = (seat: Seat): Seat => (seat + 1) % 4
export const opposingTeam = (team: TeamId): TeamId => (1 - team) as TeamId

export const DEFAULT_RULES: RuleSet = {
  minBid: 130,
  maxBid: DECK_POINTS,
  bidStep: 5,
  doubleThreshold: 250,
  gamePointsBase: 1,
  capotBonus: 1,
  targetGamePoints: 5,
  firstLead: 'left-of-dealer',
}

/**
 * Which card wins a trick.
 *
 * Trump only counts once it has been revealed. A card of the trump suit thrown
 * away as a blind discard earlier in the hand becomes a trump retroactively the
 * moment somebody calls, including within the trick in progress — that is the
 * standard rule and it is where most of the drama in 304 comes from.
 */
export function trickWinner(trick: Trick, trump: Suit | null, trumpActive: boolean): Seat {
  if (trick.plays.length === 0) throw new Error('Cannot resolve an empty trick')
  const ledSuit = suitOf(trick.plays[0].cardId)
  const effectiveTrump = trumpActive ? trump : null

  let best = trick.plays[0]
  for (const play of trick.plays.slice(1)) {
    if (beats(play.cardId, best.cardId, ledSuit, effectiveTrump)) best = play
  }
  return best.seat
}

function beats(
  challenger: CardId,
  incumbent: CardId,
  ledSuit: Suit,
  trump: Suit | null,
): boolean {
  const c = card(challenger)
  const i = card(incumbent)
  const cIsTrump = trump !== null && c.suit === trump
  const iIsTrump = trump !== null && i.suit === trump

  if (cIsTrump && !iIsTrump) return true
  if (!cIsTrump && iIsTrump) return false
  if (cIsTrump && iIsTrump) return c.strength > i.strength

  // Neither is trump — only the led suit can win.
  if (c.suit !== ledSuit) return false
  if (i.suit !== ledSuit) return true
  return c.strength > i.strength
}

export function trickPoints(trick: Trick): number {
  return totalPoints(trick.plays.map((p) => p.cardId))
}

/**
 * What the seat on turn may legally do.
 *
 * The rules being enforced:
 *  - Follow the led suit if you can.
 *  - If you cannot, and the trump is still face down, you may either call for
 *    it to be turned up or throw any card away blind.
 *  - Whoever calls for the trump must then play one if they hold one.
 *  - The declarer's face-down card is not playable while it is face down.
 */
export function legalMoves(state: GameState, seat: Seat): LegalMoves {
  const hand = state.hands[seat] ?? []
  const empty: LegalMoves = {
    seat,
    playable: [],
    blocked: [],
    canCallTrump: false,
    bidRange: null,
    canPass: false,
  }

  if (state.phase === 'bidding') {
    if (state.turn !== seat) return { ...empty, reason: 'Not your turn' }
    const min = Math.max(state.rules.minBid, state.currentBid + state.rules.bidStep)
    // If everyone else has passed and no bid stands, the last player in must bid.
    const forced = state.inAuction.length === 1 && state.currentBidder === null
    return {
      ...empty,
      bidRange:
        min <= state.rules.maxBid
          ? { min, max: state.rules.maxBid, step: state.rules.bidStep }
          : null,
      canPass: !forced,
      reason: forced ? 'Everyone else passed — you have to take it' : undefined,
    }
  }

  if (state.phase === 'choosing-trump') {
    if (state.declarer !== seat) return { ...empty, reason: 'Only the declarer picks trump' }
    // Trump is chosen from the first packet of four, before the rest is dealt.
    return { ...empty, playable: [...hand] }
  }

  const concealed = state.concealedCardId
  const concealedLocked = concealed !== null && !state.concealedReturned
  const available = hand.filter((id) => !concealedLocked || id !== concealed)
  // The face-down card is reported as blocked whether or not it is this seat's
  // turn, so the UI can grey it out at all times rather than only on turn.
  const hiddenFromPlay =
    concealedLocked && concealed !== null && hand.includes(concealed) ? [concealed] : []

  if (state.phase !== 'playing' || state.turn !== seat || !state.currentTrick) {
    return { ...empty, blocked: hiddenFromPlay, reason: 'Not your turn' }
  }

  // A full trick has to be swept up before anyone plays again. Without this
  // guard a fast tap — or a peer whose clock is ahead — can slip a fifth card
  // onto the table.
  if (state.currentTrick.plays.length >= 4) {
    return { ...empty, blocked: hiddenFromPlay, reason: 'Trick complete' }
  }

  // Leading — anything goes.
  if (state.currentTrick.plays.length === 0) {
    return { ...empty, playable: available, blocked: hiddenFromPlay }
  }

  const ledSuit = suitOf(state.currentTrick.plays[0].cardId)
  const followers = available.filter((id) => suitOf(id) === ledSuit)

  if (followers.length > 0) {
    return {
      ...empty,
      playable: followers,
      blocked: [...available.filter((id) => suitOf(id) !== ledSuit), ...hiddenFromPlay],
      reason: `Must follow ${SUIT_SYMBOL[ledSuit]}`,
    }
  }

  // Void in the led suit.
  if (state.mustPlayTrump === seat && state.trump) {
    const trumps = available.filter((id) => suitOf(id) === state.trump)
    if (trumps.length > 0) {
      return {
        ...empty,
        playable: trumps,
        blocked: available.filter((id) => suitOf(id) !== state.trump),
        reason: 'You called — you must play a trump',
      }
    }
    return { ...empty, playable: available, reason: 'You called, but hold no trump' }
  }

  if (!state.trumpRevealed) {
    return {
      ...empty,
      playable: available,
      blocked: hiddenFromPlay,
      canCallTrump: true,
      reason: 'Void — call for trump, or throw away blind',
    }
  }

  return { ...empty, playable: available, reason: 'Void — play anything' }
}

export function isLegalPlay(state: GameState, seat: Seat, cardId: CardId): boolean {
  return legalMoves(state, seat).playable.includes(cardId)
}

/** Legal bid values for a seat, as a list the UI can render as chips. */
export function bidOptions(state: GameState): number[] {
  const range = legalMoves(state, state.turn).bidRange
  if (!range) return []
  const out: number[] = []
  for (let v = range.min; v <= range.max; v += range.step) out.push(v)
  // 304 itself is always offerable even if it is off-step.
  if (out[out.length - 1] !== range.max && range.max >= range.min) out.push(range.max)
  return out
}

export interface HandScore {
  cardPoints: [number, number]
  made: boolean
  capot: boolean
  gamePoints: [number, number]
}

/**
 * Score a finished hand.
 *
 * The declaring team needs at least its bid in card points. A contract at or
 * above `doubleThreshold` is worth double either way — the standard "the higher
 * you climb the further you fall" house rule, and it is configurable.
 */
export function scoreHand(
  rules: RuleSet,
  declarer: Seat,
  contract: number,
  cardPoints: [number, number],
  tricks: Trick[],
): HandScore {
  const declaringTeam = teamOf(declarer)
  const defendingTeam = opposingTeam(declaringTeam)
  const made = cardPoints[declaringTeam] >= contract
  const capot =
    tricks.length === TRICKS_PER_HAND &&
    tricks.every((t) => t.winner !== undefined && teamOf(t.winner) === declaringTeam)

  const stake = contract >= rules.doubleThreshold ? rules.gamePointsBase * 2 : rules.gamePointsBase
  const gamePoints: [number, number] = [0, 0]

  if (made) {
    gamePoints[declaringTeam] = stake + (capot ? rules.capotBonus : 0)
  } else {
    gamePoints[defendingTeam] = stake
  }

  return { cardPoints, made, capot, gamePoints }
}

/** Sanity check used by the tests and the dev overlay. */
export function assertPointsBalance(cardPoints: [number, number]): void {
  const sum = cardPoints[0] + cardPoints[1]
  if (sum !== DECK_POINTS) {
    throw new Error(`Card points must total ${DECK_POINTS}, got ${sum}`)
  }
}
