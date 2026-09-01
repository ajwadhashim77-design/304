import { useMemo, type CSSProperties } from 'react'

import { sortHand } from '../game/cards'
import { nameOf } from '../game/engine'
import { teamOf } from '../game/rules'
import type { CardId, Seat } from '../game/types'
import { PlayingCard } from './components/PlayingCard'
import {
  BidPanel,
  ContractStrip,
  HandOverPanel,
  PassGate,
  Scoreboard,
  TrickLog,
  TrumpMark,
  TrumpPicker,
} from './components/Panels'
import type { GameApi } from './useGame'

const POSITIONS = ['south', 'west', 'north', 'east'] as const

/** A human seat whose player has lost their connection (online games only). */
function isAway(api: GameApi, seat: Seat): boolean {
  const entry = api.online?.roster.find((p) => p.seat === seat)
  return Boolean(entry && !entry.isBot && !entry.connected)
}

export function GameTable({ api, onNewMatch, onQuit }: {
  api: GameApi
  onNewMatch: () => void
  onQuit: () => void
}) {
  const { state, actor, moves, revealed, needsPass, setup } = api

  // Everything is drawn from the point of view of whoever is holding the phone.
  const viewer: Seat = revealed ?? actor
  const relative = (seat: Seat) => POSITIONS[(seat - viewer + 4) % 4]

  const handInView: CardId[] = useMemo(
    () => (revealed === null ? [] : sortHand(state.hands[revealed], state.trump)),
    [revealed, state.hands, state.trump],
  )

  // The bidder is committing on four cards, so those four have to be on screen
  // while they bid. Only the trump picker replaces the fan, because it *is* the
  // hand, rendered bigger and tappable.
  const showHand =
    revealed !== null && (state.phase === 'playing' || state.phase === 'bidding')
  const playable = new Set(revealed === actor ? moves.playable : [])
  const trickPlays = state.currentTrick?.plays ?? []
  const lastTrick = state.tricks[state.tricks.length - 1]

  return (
    <div className="room">
      <header className="room__bar">
        <button className="btn btn--ghost" onClick={onQuit} aria-label="Leave the table">
          ←
        </button>
        <div className="room__meta">
          <span className="room__hand">
            Hand {state.handNumber}
            {api.online && <span className="room__code"> · {api.online.code}</span>}
          </span>
          <ContractStrip state={state} />
        </div>
        <Scoreboard state={state} teamNames={setup.teamNames} />
      </header>

      <main className="felt">
        <div className="felt__rail">
          <div className="felt__surface">
            {state.players.map((player) => {
              const pos = relative(player.seat)
              const onTurn = actor === player.seat && state.phase !== 'hand-over'
              const wonLast = lastTrick?.winner === player.seat && trickPlays.length === 0

              return (
                <div key={player.seat} className={`seat seat--${pos}`}>
                  <div
                    className={[
                      'nameplate',
                      `nameplate--team${teamOf(player.seat)}`,
                      onTurn && 'is-turn',
                      state.declarer === player.seat && 'is-declarer',
                      wonLast && 'is-winner',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className="nameplate__name">{player.name}</span>
                    <span className="nameplate__tag">
                      {isAway(api, player.seat)
                        ? 'away'
                        : state.declarer === player.seat
                          ? `bid ${state.contract}`
                          : player.isBot
                            ? 'bot'
                            : ''}
                    </span>
                    {onTurn && <span className="nameplate__pulse" aria-hidden />}
                  </div>

                  <div className="seat__cards" aria-hidden>
                    {Array.from({ length: state.hands[player.seat].length }).map((_, i) => (
                      <span key={i} className="pipcard" />
                    ))}
                  </div>
                </div>
              )
            })}

            {/* The trick itself sits in a tight diamond in the middle, so the
                four cards read as one pile rather than four lonely corners. */}
            <div className="trick">
              {state.players.map((player) => {
                const played = trickPlays.find((p) => p.seat === player.seat)
                return (
                  <div key={player.seat} className={`slot slot--${relative(player.seat)}`}>
                    {played && <PlayingCard id={played.cardId} small />}
                  </div>
                )
              })}
            </div>

            <TrumpMark state={state} viewer={viewer} />

            <div className="felt__centre">
              <span className="felt__brand">304</span>
              {state.phase === 'playing' && trickPlays.length === 0 && lastTrick && (
                <p className="felt__note">
                  {nameOf(state, lastTrick.winner as Seat)} took {lastTrick.points ?? 0}
                </p>
              )}
              {state.phase === 'bidding' && <p className="felt__note">Bidding</p>}
            </div>
          </div>
        </div>

        <TrickLog state={state} />
      </main>

      <footer className="dock">
        {state.phase === 'bidding' && revealed === actor && <BidPanel api={api} />}
        {state.phase === 'choosing-trump' && revealed === actor && <TrumpPicker api={api} />}

        {showHand && (
          <>
            {moves.canCallTrump && revealed === actor && (
              <button className="btn btn--call" onClick={api.callTrump}>
                Call for trump
              </button>
            )}
            {revealed === actor && state.phase === 'playing' && moves.reason && (
              <p className="dock__hint">{moves.reason}</p>
            )}
            <div className="fan" style={{ '--n': handInView.length } as CSSProperties}>
              {handInView.map((id, i) => {
                const isConcealed = id === state.concealedCardId && !state.concealedReturned
                return (
                  <PlayingCard
                    key={id}
                    id={id}
                    style={{ '--i': i } as CSSProperties}
                    onClick={playable.has(id) ? () => api.play(id) : undefined}
                    muted={state.phase === 'playing' && !playable.has(id)}
                    concealed={isConcealed}
                    highlight={playable.has(id)}
                    title={
                      isConcealed
                        ? 'Your face-down trump — back in play once somebody calls'
                        : undefined
                    }
                  />
                )
              })}
            </div>
          </>
        )}

        {showHand && setup.mode === 'pass-and-play' && (
          <button className="dock__hide" onClick={api.hide}>
            Hide my cards
          </button>
        )}
      </footer>

      {needsPass && <PassGate api={api} />}
      {(state.phase === 'hand-over' || state.phase === 'match-over') && (
        <HandOverPanel api={api} onNewMatch={onNewMatch} />
      )}
    </div>
  )
}
