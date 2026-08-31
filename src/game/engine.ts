import { SUIT_NAME, SUIT_SYMBOL, buildDeck, cardLabel, sortHand, suitOf } from './cards'
import { mulberry32, nextSeed, randomSeed, shuffle } from './rng'
import {
  DEFAULT_RULES,
  HAND_SIZE,
  SEATS,
  TRICKS_PER_HAND,
  assertPointsBalance,
  legalMoves,
  nextSeat,
  scoreHand,
  teamOf,
  trickPoints,
  trickWinner,
} from './rules'
import type {
  CardId,
  GameAction,
  GameState,
  HandResult,
  PlayerConfig,
  RuleSet,
  Seat,
  Suit,
  Trick,
} from './types'

const PACKET = 4

export interface NewGameOptions {
  players: PlayerConfig[]
  rules?: Partial<RuleSet>
  seed?: number
  dealer?: Seat
}

export function createGame(options: NewGameOptions): GameState {
  const rules: RuleSet = { ...DEFAULT_RULES, ...options.rules }
  if (options.players.length !== 4) {
    throw new Error('304 seats exactly four players (the six-hand variant is on the roadmap)')
  }
  const seed = options.seed ?? randomSeed()
  const dealer = options.dealer ?? 0

  const base: GameState = {
    rules,
    players: [...options.players].sort((a, b) => a.seat - b.seat),
    seed,
    handNumber: 0,
    dealer,
    phase: 'bidding',
    hands: { 0: [], 1: [], 2: [], 3: [] },
    pending: { 0: [], 1: [], 2: [], 3: [] },
    bids: [],
    inAuction: [],
    currentBid: 0,
    currentBidder: null,
    turn: dealer,
    declarer: null,
    contract: null,
    trump: null,
    concealedCardId: null,
    trumpRevealed: false,
    concealedReturned: false,
    mustPlayTrump: null,
    tricks: [],
    currentTrick: null,
    cardPoints: [0, 0],
    gamePoints: [0, 0],
    history: [],
    log: [],
  }

  return dealHand(base)
}

/**
 * Deal the first packet of four to each seat and open the auction.
 * The second packet is held back until the contract and trump are settled —
 * that is the point of 304's bidding: you commit on half a hand.
 */
function dealHand(state: GameState): GameState {
  const rand = mulberry32(state.seed)
  const deck = shuffle(buildDeck(), rand)

  const hands: Record<Seat, CardId[]> = { 0: [], 1: [], 2: [], 3: [] }
  const pending: Record<Seat, CardId[]> = { 0: [], 1: [], 2: [], 3: [] }

  let i = 0
  const order = rotation(nextSeat(state.dealer))
  for (const seat of order) hands[seat] = deck.slice(i, (i += PACKET))
  for (const seat of order) pending[seat] = deck.slice(i, (i += PACKET))

  const opener = nextSeat(state.dealer)

  return {
    ...state,
    handNumber: state.handNumber + 1,
    phase: 'bidding',
    hands: mapHands(hands, (cards) => sortHand(cards)),
    pending,
    bids: [],
    inAuction: rotation(opener),
    currentBid: 0,
    currentBidder: null,
    turn: opener,
    declarer: null,
    contract: null,
    trump: null,
    concealedCardId: null,
    trumpRevealed: false,
    concealedReturned: false,
    mustPlayTrump: null,
    tricks: [],
    currentTrick: null,
    cardPoints: [0, 0],
    log: [
      ...state.log,
      `— Hand ${state.handNumber + 1} — ${nameOf(state, state.dealer)} deals, ${nameOf(state, opener)} opens the bidding.`,
    ],
  }
}

/** Seats in clockwise order starting from `start`. */
function rotation(start: Seat): Seat[] {
  return SEATS.map((_, i) => (start + i) % 4)
}

function mapHands(
  hands: Record<Seat, CardId[]>,
  fn: (cards: CardId[], seat: Seat) => CardId[],
): Record<Seat, CardId[]> {
  const out: Record<Seat, CardId[]> = { 0: [], 1: [], 2: [], 3: [] }
  for (const seat of SEATS) out[seat] = fn(hands[seat] ?? [], seat)
  return out
}

export const nameOf = (state: GameState, seat: Seat): string =>
  state.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`

export const teamName = (state: GameState, team: number): string => {
  const members = state.players.filter((p) => teamOf(p.seat) === team)
  return members.map((p) => p.name).join(' & ') || `Team ${team + 1}`
}

/** True when the trick on the table is complete and waiting to be swept up. */
export const needsResolve = (state: GameState): boolean =>
  state.phase === 'playing' && state.currentTrick?.plays.length === 4

export function reduce(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'BID':
      return applyBid(state, action.seat, action.amount)
    case 'PASS':
      return applyPass(state, action.seat)
    case 'SET_TRUMP':
      return applySetTrump(state, action.seat, action.cardId)
    case 'CALL_TRUMP':
      return applyCallTrump(state, action.seat)
    case 'PLAY':
      return applyPlay(state, action.seat, action.cardId)
    case 'RESOLVE_TRICK':
      return resolveTrick(state)
    case 'NEXT_HAND':
      return startNextHand(state)
    default:
      return state
  }
}

function reject(state: GameState, message: string): GameState {
  // Illegal input is a bug in the caller, not a game event. Surfacing it in the
  // log rather than throwing keeps a networked peer from crashing the table.
  if (typeof console !== 'undefined') console.warn('[304]', message)
  return { ...state, log: [...state.log, `⚠︎ ${message}`] }
}

function applyBid(state: GameState, seat: Seat, amount: number): GameState {
  if (state.phase !== 'bidding') return reject(state, 'Bidding is closed')
  const moves = legalMoves(state, seat)
  if (state.turn !== seat) return reject(state, `${nameOf(state, seat)} bid out of turn`)
  if (!moves.bidRange) return reject(state, 'No bid is available')
  const { min, max, step } = moves.bidRange
  if (amount < min || amount > max) return reject(state, `${amount} is outside ${min}–${max}`)
  if (amount !== max && (amount - min) % step !== 0) {
    return reject(state, `Bids go up in ${step}s`)
  }

  const next: GameState = {
    ...state,
    bids: [...state.bids, { seat, amount }],
    currentBid: amount,
    currentBidder: seat,
    log: [...state.log, `${nameOf(state, seat)} bids ${amount}.`],
  }
  return advanceAuction(next, seat)
}

function applyPass(state: GameState, seat: Seat): GameState {
  if (state.phase !== 'bidding') return reject(state, 'Bidding is closed')
  if (state.turn !== seat) return reject(state, `${nameOf(state, seat)} passed out of turn`)
  if (!legalMoves(state, seat).canPass) {
    return reject(state, `${nameOf(state, seat)} cannot pass — everyone else is out`)
  }

  const next: GameState = {
    ...state,
    bids: [...state.bids, { seat, amount: null }],
    inAuction: state.inAuction.filter((s) => s !== seat),
    log: [...state.log, `${nameOf(state, seat)} passes.`],
  }
  return advanceAuction(next, seat)
}

function advanceAuction(state: GameState, from: Seat): GameState {
  const live = state.inAuction
  if (live.length === 1 && state.currentBidder === live[0]) {
    return openContract(state, live[0])
  }

  let candidate = nextSeat(from)
  for (let i = 0; i < 4 && !live.includes(candidate); i++) candidate = nextSeat(candidate)
  return { ...state, turn: candidate }
}

function openContract(state: GameState, declarer: Seat): GameState {
  return {
    ...state,
    phase: 'choosing-trump',
    declarer,
    contract: state.currentBid,
    turn: declarer,
    log: [
      ...state.log,
      `${nameOf(state, declarer)} takes the contract at ${state.currentBid} and picks a trump face down.`,
    ],
  }
}

function applySetTrump(state: GameState, seat: Seat, cardId: CardId): GameState {
  if (state.phase !== 'choosing-trump') return reject(state, 'Not the moment to set a trump')
  if (state.declarer !== seat) return reject(state, 'Only the declarer sets the trump')
  if (!state.hands[seat].includes(cardId)) return reject(state, 'That card is not in hand')

  const trump = suitOf(cardId)
  // The rest of the deal goes out now that the contract is settled.
  const hands = mapHands(state.hands, (cards, s) => [...cards, ...(state.pending[s] ?? [])])

  const leader = state.rules.firstLead === 'declarer' ? seat : nextSeat(state.dealer)

  return {
    ...state,
    phase: 'playing',
    trump,
    concealedCardId: cardId,
    trumpRevealed: false,
    concealedReturned: false,
    hands: mapHands(hands, (cards) => sortHand(cards)),
    pending: { 0: [], 1: [], 2: [], 3: [] },
    turn: leader,
    currentTrick: { leader, plays: [] },
    log: [...state.log, `Trump is set face down. ${nameOf(state, leader)} leads.`],
  }
}

function applyCallTrump(state: GameState, seat: Seat): GameState {
  if (state.phase !== 'playing') return reject(state, 'Nothing to call')
  if (!legalMoves(state, seat).canCallTrump) {
    return reject(state, `${nameOf(state, seat)} cannot call for the trump right now`)
  }
  return {
    ...state,
    trumpRevealed: true,
    concealedReturned: true,
    mustPlayTrump: seat,
    log: [
      ...state.log,
      `${nameOf(state, seat)} calls. Trump is ${suitLabel(state.trump)} — and it counts for this trick too.`,
    ],
  }
}

function suitLabel(suit: Suit | null): string {
  return suit ? `${SUIT_SYMBOL[suit]} ${SUIT_NAME[suit]}` : '—'
}

function applyPlay(state: GameState, seat: Seat, cardId: CardId): GameState {
  if (state.phase !== 'playing' || !state.currentTrick) return reject(state, 'No trick in progress')
  if (state.currentTrick.plays.length >= 4) {
    return reject(state, 'That trick is already complete')
  }
  if (state.turn !== seat) return reject(state, `${nameOf(state, seat)} played out of turn`)
  const moves = legalMoves(state, seat)
  if (!moves.playable.includes(cardId)) {
    return reject(state, `${cardLabel(cardId)} is not a legal play${moves.reason ? ` — ${moves.reason}` : ''}`)
  }

  const trick: Trick = {
    ...state.currentTrick,
    plays: [...state.currentTrick.plays, { seat, cardId }],
  }
  const hands = mapHands(state.hands, (cards, s) =>
    s === seat ? cards.filter((c) => c !== cardId) : cards,
  )

  return {
    ...state,
    hands,
    currentTrick: trick,
    mustPlayTrump: state.mustPlayTrump === seat ? null : state.mustPlayTrump,
    turn: trick.plays.length === 4 ? seat : nextSeat(seat),
    log: [...state.log, `${nameOf(state, seat)} plays ${cardLabel(cardId)}.`],
  }
}

function resolveTrick(state: GameState): GameState {
  if (!state.currentTrick || state.currentTrick.plays.length !== 4) return state

  const winner = trickWinner(state.currentTrick, state.trump, state.trumpRevealed)
  const points = trickPoints(state.currentTrick)
  const completed: Trick = { ...state.currentTrick, winner, points }
  const tricks = [...state.tricks, completed]

  const cardPoints: [number, number] = [...state.cardPoints] as [number, number]
  cardPoints[teamOf(winner)] += points

  const log = [
    ...state.log,
    `${nameOf(state, winner)} takes trick ${tricks.length}${points ? ` (+${points})` : ' (no points)'}.`,
  ]

  if (tricks.length === TRICKS_PER_HAND) {
    return finishHand({ ...state, tricks, currentTrick: null, cardPoints, log })
  }

  // Nobody called: the declarer's face-down card comes back for the last trick
  // and the hand simply finishes without a trump.
  const lastTrickNow = tricks.length === TRICKS_PER_HAND - 1
  const returning = lastTrickNow && !state.concealedReturned && state.concealedCardId !== null

  return {
    ...state,
    tricks,
    cardPoints,
    mustPlayTrump: null,
    concealedReturned: state.concealedReturned || returning,
    currentTrick: { leader: winner, plays: [] },
    turn: winner,
    log: returning
      ? [...log, 'Nobody called. The face-down card goes back into the hand — no trump this deal.']
      : log,
  }
}

function finishHand(state: GameState): GameState {
  assertPointsBalance(state.cardPoints)
  const declarer = state.declarer as Seat
  const contract = state.contract as number
  const score = scoreHand(state.rules, declarer, contract, state.cardPoints, state.tricks)

  const gamePoints: [number, number] = [
    state.gamePoints[0] + score.gamePoints[0],
    state.gamePoints[1] + score.gamePoints[1],
  ]

  const result: HandResult = {
    handNumber: state.handNumber,
    dealer: state.dealer,
    declarer,
    declaringTeam: teamOf(declarer),
    bid: contract,
    trump: state.trump!,
    trumpWasRevealed: state.trumpRevealed,
    cardPoints: state.cardPoints,
    made: score.made,
    capot: score.capot,
    gamePoints: score.gamePoints,
  }

  const declaringTeam = teamOf(declarer)
  const verdict = score.made
    ? `${teamName(state, declaringTeam)} made ${contract} with ${state.cardPoints[declaringTeam]}.`
    : `${teamName(state, declaringTeam)} went down — ${state.cardPoints[declaringTeam]} against a bid of ${contract}.`

  const matchOver = gamePoints[0] >= state.rules.targetGamePoints || gamePoints[1] >= state.rules.targetGamePoints

  return {
    ...state,
    phase: matchOver ? 'match-over' : 'hand-over',
    gamePoints,
    history: [...state.history, result],
    log: [
      ...state.log,
      verdict + (score.capot ? ' All eight tricks!' : ''),
      ...(matchOver
        ? [`🏆 ${teamName(state, gamePoints[0] > gamePoints[1] ? 0 : 1)} win the match.`]
        : []),
    ],
  }
}

function startNextHand(state: GameState): GameState {
  if (state.phase !== 'hand-over') return state
  return dealHand({
    ...state,
    dealer: nextSeat(state.dealer),
    seed: nextSeed(state.seed),
  })
}

/** Start a fresh match, keeping the same players and rules. */
export function rematch(state: GameState, seed = randomSeed()): GameState {
  return createGame({
    players: state.players,
    rules: state.rules,
    seed,
    dealer: nextSeat(state.dealer),
  })
}

export { HAND_SIZE, TRICKS_PER_HAND }
