import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'

import { botAction, createGame, legalMoves, needsResolve, reduce } from '../game'
import type {
  GameAction,
  GameState,
  LegalMoves,
  PlayerConfig,
  RuleSet,
  Seat,
} from '../game/types'
import type { RosterEntry } from '../../server/protocol'
import { LocalTransport } from '../net/transport'

export type TableMode = 'solo' | 'online'

export interface TableSetup {
  mode: TableMode
  players: PlayerConfig[]
  teamNames: [string, string]
  rules: Partial<RuleSet>
}

/** Extra context the table shows when the game is a networked room. */
export interface OnlineInfo {
  code: string
  isHost: boolean
  hostName: string
  connection: 'ok' | 'connecting' | 'dropped'
  /** False while queued actions are still playing out on screen. */
  caughtUp: boolean
  roster: RosterEntry[]
  reconnect: () => void
}

/**
 * Everything the table UI needs, whichever way the game is being driven —
 * locally (`useGame`) or over a room socket (`useOnlineGame`).
 */
export interface TableApi {
  state: GameState
  setup: TableSetup
  actor: Seat
  moves: LegalMoves
  /** The seat whose hand is face up on this device. */
  revealed: Seat | null
  waitingOnHuman: boolean
  isBot: (seat: Seat) => boolean
  play: (cardId: string) => void
  bid: (amount: number) => void
  pass: () => void
  callTrump: () => void
  setTrump: (cardId: string) => void
  nextHand: () => void
  online?: OnlineInfo
}

/** How long a completed trick sits on the table before it is swept up. */
const TRICK_PAUSE_MS = 1400
const BOT_THINK_MS = 650

export function useGame(setup: TableSetup): TableApi {
  const [state, dispatch] = useReducer(reduce, undefined, () =>
    createGame({ players: setup.players, rules: setup.rules }),
  )

  // Locally there is exactly one human, and their hand stays face up.
  const revealed: Seat = humanSeat(setup.players)

  const transport = useMemo(
    () => new LocalTransport(setup.players.map((p) => p.name)),
    [setup.players],
  )

  useEffect(() => {
    void transport.connect({ onAction: ({ action }) => dispatch(action) })
    return () => transport.disconnect()
  }, [transport])

  const send = useCallback((action: GameAction) => transport.send(action), [transport])

  const isBot = useCallback(
    (seat: Seat) => setup.players.find((p) => p.seat === seat)?.isBot ?? false,
    [setup.players],
  )

  const actor: Seat = state.phase === 'choosing-trump' ? (state.declarer ?? state.turn) : state.turn

  // --- automatic beats: bots taking their turn, tricks being swept up --------
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)

    if (needsResolve(state)) {
      timer.current = setTimeout(() => send({ type: 'RESOLVE_TRICK' }), TRICK_PAUSE_MS)
      return () => void (timer.current && clearTimeout(timer.current))
    }

    if (state.phase === 'bidding' || state.phase === 'choosing-trump' || state.phase === 'playing') {
      if (isBot(actor)) {
        const action = botAction(state, actor)
        if (action) {
          timer.current = setTimeout(() => send(action), BOT_THINK_MS)
        }
      }
    }
    return () => void (timer.current && clearTimeout(timer.current))
  }, [state, actor, isBot, send])

  const moves = useMemo(() => legalMoves(state, actor), [state, actor])

  const waitingOnHuman =
    !isBot(actor) &&
    (state.phase === 'bidding' || state.phase === 'choosing-trump' || state.phase === 'playing') &&
    !needsResolve(state)

  return {
    state,
    setup,
    actor,
    moves,
    revealed,
    waitingOnHuman,
    isBot,
    play: (cardId: string) => send({ type: 'PLAY', seat: actor, cardId }),
    bid: (amount: number) => send({ type: 'BID', seat: actor, amount }),
    pass: () => send({ type: 'PASS', seat: actor }),
    callTrump: () => send({ type: 'CALL_TRUMP', seat: actor }),
    setTrump: (cardId: string) => send({ type: 'SET_TRUMP', seat: actor, cardId }),
    nextHand: () => send({ type: 'NEXT_HAND' }),
  }
}

function humanSeat(players: PlayerConfig[]): Seat {
  return players.find((p) => !p.isBot)?.seat ?? 0
}

export type GameApi = TableApi
export type { GameState }
