import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { createGame, legalMoves, reduce } from '../game'
import type { GameAction, GameState, LegalMoves, PlayerConfig, Seat } from '../game/types'
import type { OnlineSession, SessionState } from '../net/online'
import type { RosterEntry } from '../../server/protocol'
import type { TableApi } from './useGame'

/**
 * Drive the table from a room session.
 *
 * The server settles everything instantly — bots move and tricks are swept in
 * the same breath as your card — so the log usually runs ahead of what should
 * be on screen. A cursor walks through the actions at a watchable pace, and
 * the table renders the replay at the cursor, not the log's tip. Your own
 * inputs are only enabled once the cursor has caught up.
 */
export function useOnlineGame(session: OnlineSession): TableApi {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)

  const [cursor, setCursor] = useState(0)

  // A new deal (or a full resync after reconnecting) resets the playback: a
  // fresh hand starts from zero, a resync jumps straight to the live position
  // rather than re-performing the whole game.
  const nonceRef = useRef(snap.matchNonce)
  if (nonceRef.current !== snap.matchNonce) {
    nonceRef.current = snap.matchNonce
    setCursor(snap.actions.length)
  }

  const mySeat = seatOf(snap, snap.playerId)

  useEffect(() => {
    if (cursor >= snap.actions.length) return
    const action = snap.actions[cursor]
    const timer = setTimeout(
      () => setCursor((c) => Math.min(c + 1, snap.actions.length)),
      paceFor(action, mySeat, cursor, snap.actions),
    )
    return () => clearTimeout(timer)
  }, [cursor, snap.actions, mySeat])

  // Replay incrementally: keep the state at the cursor and only apply the new
  // actions since last render, rebuilding from the seed when the deal changes.
  const cache = useRef<{ nonce: number; cursor: number; state: GameState } | null>(null)
  const state = useMemo(() => {
    let base = cache.current
    if (!base || base.nonce !== snap.matchNonce || base.cursor > cursor) {
      base = { nonce: snap.matchNonce, cursor: 0, state: freshGame(snap) }
    }
    let s = base.state
    for (let i = base.cursor; i < cursor; i++) s = reduce(s, snap.actions[i])
    cache.current = { nonce: snap.matchNonce, cursor, state: s }
    return s
  }, [snap, cursor])

  const caughtUp = cursor >= snap.actions.length
  const actor: Seat = state.phase === 'choosing-trump' ? (state.declarer ?? state.turn) : state.turn

  const moves: LegalMoves = useMemo(() => {
    if (caughtUp && mySeat !== null) return legalMoves(state, mySeat)
    return { seat: mySeat ?? 0, playable: [], blocked: [], canCallTrump: false, bidRange: null, canPass: false }
  }, [caughtUp, state, mySeat])

  const act = (action: GameAction) => session.act(action)
  const seat = mySeat ?? 0

  const host = snap.roster.find((p) => p.isHost)

  return {
    state,
    setup: {
      mode: 'online',
      players: playersFrom(snap.roster),
      teamNames: [pairName(snap.roster, 0), pairName(snap.roster, 1)],
      rules: { targetGamePoints: snap.rules.targetGamePoints, minBid: snap.rules.minBid },
    },
    actor,
    moves,
    revealed: mySeat,
    waitingOnHuman: caughtUp && actor === mySeat,
    isBot: (s: Seat) => snap.roster.find((p) => p.seat === s)?.isBot ?? true,
    play: (cardId) => act({ type: 'PLAY', seat, cardId }),
    bid: (amount) => act({ type: 'BID', seat, amount }),
    pass: () => act({ type: 'PASS', seat }),
    callTrump: () => act({ type: 'CALL_TRUMP', seat }),
    setTrump: (cardId) => act({ type: 'SET_TRUMP', seat, cardId }),
    nextHand: () => act({ type: 'NEXT_HAND' }),
    online: {
      code: snap.code,
      isHost: session.isHost(),
      hostName: host?.name ?? 'the host',
      connection:
        snap.status === 'playing' || snap.status === 'lobby'
          ? 'ok'
          : snap.status === 'connecting'
            ? 'connecting'
            : 'dropped',
      caughtUp,
      roster: snap.roster,
      reconnect: () => session.reconnect(),
    },
  }
}

/** How long each replayed action lingers before the next lands. */
function paceFor(action: GameAction, mySeat: Seat | null, index: number, log: GameAction[]): number {
  // Your own action echoing back should feel immediate.
  if ('seat' in action && action.seat === mySeat) return 40
  switch (action.type) {
    case 'RESOLVE_TRICK':
      return 1200
    case 'SET_TRUMP':
      return 700
    case 'NEXT_HAND':
      return 500
    case 'PLAY':
      return 550
    case 'BID':
    case 'PASS':
      // A long bot auction shouldn't drag: quicken deep bidding runs.
      return index > 8 && log[index - 1]?.type !== 'PLAY' ? 250 : 450
    default:
      return 400
  }
}

function seatOf(snap: SessionState, playerId: string): Seat | null {
  return snap.roster.find((p) => p.id === playerId)?.seat ?? null
}

function playersFrom(roster: RosterEntry[]): PlayerConfig[] {
  return ([0, 1, 2, 3] as Seat[]).map((seat) => {
    const p = roster.find((entry) => entry.seat === seat)
    return { seat, name: p?.name ?? `Seat ${seat + 1}`, isBot: p?.isBot ?? true }
  })
}

function pairName(roster: RosterEntry[], team: 0 | 1): string {
  const names = roster
    .filter((p) => p.seat !== null && p.seat % 2 === team)
    .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
    .map((p) => p.name)
  return names.join(' & ') || (team === 0 ? 'North–South' : 'East–West')
}

function freshGame(snap: SessionState): GameState {
  return createGame({
    players: playersFrom(snap.roster),
    seed: snap.seed,
    rules: { targetGamePoints: snap.rules.targetGamePoints, minBid: snap.rules.minBid },
  })
}
