import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { botAction, createGame, legalMoves, needsResolve, reduce } from '../game'
import type { GameAction, GameState, PlayerConfig, RuleSet, Seat } from '../game/types'
import { LocalTransport } from '../net/transport'

export type TableMode = 'pass-and-play' | 'solo'

export interface TableSetup {
  mode: TableMode
  players: PlayerConfig[]
  teamNames: [string, string]
  rules: Partial<RuleSet>
}

/** How long a completed trick sits on the table before it is swept up. */
const TRICK_PAUSE_MS = 1400
const BOT_THINK_MS = 650

export function useGame(setup: TableSetup) {
  const [state, dispatch] = useReducer(reduce, undefined, () =>
    createGame({ players: setup.players, rules: setup.rules }),
  )

  // Pass-and-play: only one hand is on screen at a time. `revealed` is the seat
  // whose cards are currently face up on this device.
  const [revealed, setRevealed] = useState<Seat | null>(
    setup.mode === 'solo' ? humanSeat(setup.players) : null,
  )

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

  // In solo play the human always sees their own hand. In pass-and-play the
  // device is handed over, so hide everything until the next player says so.
  useEffect(() => {
    if (setup.mode === 'solo') {
      setRevealed(humanSeat(setup.players))
      return
    }
    if (revealed !== null && revealed !== actor && !isBot(actor)) setRevealed(null)
  }, [actor, isBot, revealed, setup.mode, setup.players])

  const moves = useMemo(() => legalMoves(state, actor), [state, actor])

  const waitingOnHuman =
    !isBot(actor) &&
    (state.phase === 'bidding' || state.phase === 'choosing-trump' || state.phase === 'playing') &&
    !needsResolve(state)

  const needsPass = setup.mode === 'pass-and-play' && waitingOnHuman && revealed !== actor

  return {
    state,
    setup,
    actor,
    moves,
    revealed,
    needsPass,
    waitingOnHuman,
    isBot,
    reveal: () => setRevealed(actor),
    hide: () => setRevealed(null),
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

export type GameApi = ReturnType<typeof useGame>
export type { GameState }
