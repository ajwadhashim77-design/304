import { SUIT_SYMBOL, cardLabel } from '../../game/cards'
import { bidOptions, teamOf } from '../../game/rules'
import { nameOf, teamName } from '../../game/engine'
import type { GameState, Seat } from '../../game/types'
import { PlayingCard } from './PlayingCard'
import type { GameApi } from '../useGame'

/** "Hand the phone to Kavi" — the privacy curtain for pass-and-play. */
export function PassGate({ api }: { api: GameApi }) {
  const { state, actor } = api
  return (
    <div className="overlay">
      <div className="panel panel--gate">
        <p className="panel__eyebrow">Cards down</p>
        <h2 className="panel__title">Pass to {nameOf(state, actor)}</h2>
        <p className="panel__body">
          {teamName(state, teamOf(actor))} · {phaseHint(state)}
        </p>
        <button className="btn btn--gold" onClick={api.reveal}>
          I'm {nameOf(state, actor)} — show my hand
        </button>
      </div>
    </div>
  )
}

function phaseHint(state: GameState): string {
  if (state.phase === 'bidding') return 'Your turn to bid'
  if (state.phase === 'choosing-trump') return 'Choose your trump'
  return 'Your turn to play'
}

export function BidPanel({ api }: { api: GameApi }) {
  const { state, moves, actor } = api
  const options = bidOptions(state)
  const quick = options.slice(0, 6)
  const top = options[options.length - 1]

  return (
    <div className="tray">
      <div className="tray__head">
        <span className="tray__label">
          {state.currentBidder === null
            ? 'Opening bid'
            : `${nameOf(state, state.currentBidder)} holds it at ${state.currentBid}`}
        </span>
        {moves.reason && <span className="tray__hint">{moves.reason}</span>}
      </div>
      <div className="tray__row">
        {quick.map((amount) => (
          <button key={amount} className="chip" onClick={() => api.bid(amount)}>
            {amount}
          </button>
        ))}
        {top !== undefined && !quick.includes(top) && (
          <button className="chip chip--max" onClick={() => api.bid(top)}>
            {top}
          </button>
        )}
        {moves.canPass && (
          <button className="chip chip--pass" onClick={api.pass}>
            Pass
          </button>
        )}
      </div>
      <p className="tray__foot">
        {nameOf(state, actor)} is bidding on four cards. The other four come after the
        contract is settled.
      </p>
    </div>
  )
}

export function TrumpPicker({ api }: { api: GameApi }) {
  const { state, actor } = api
  return (
    <div className="tray">
      <div className="tray__head">
        <span className="tray__label">
          You won the contract at {state.contract}. Pick your trump.
        </span>
      </div>
      <div className="tray__cards">
        {state.hands[actor].map((id) => (
          <PlayingCard key={id} id={id} onClick={() => api.setTrump(id)} highlight />
        ))}
      </div>
      <p className="tray__foot">
        This card goes face down. Its suit is the trump, and nobody else sees it until
        somebody calls for it.
      </p>
    </div>
  )
}

export function HandOverPanel({ api, onNewMatch }: { api: GameApi; onNewMatch: () => void }) {
  const { state, setup } = api
  const result = state.history[state.history.length - 1]
  if (!result) return null

  const declaring = result.declaringTeam
  const won = result.made ? declaring : (1 - declaring)

  return (
    <div className="overlay">
      <div className="panel">
        <p className="panel__eyebrow">Hand {result.handNumber}</p>
        <h2 className="panel__title">
          {result.made ? 'Contract made' : 'Contract broken'}
        </h2>
        <p className="panel__body">
          {nameOf(state, result.declarer)} bid <strong>{result.bid}</strong> on{' '}
          {SUIT_SYMBOL[result.trump]}
          {result.trumpWasRevealed ? '' : ' — never called, so it played out with no trump'}.
        </p>

        <div className="tally">
          {[0, 1].map((team) => (
            <div key={team} className={`tally__row ${team === won ? 'is-winner' : ''}`}>
              <span className="tally__name">
                {setup.teamNames[team]}
                <em>{teamName(state, team)}</em>
              </span>
              <span className="tally__points">{result.cardPoints[team]}</span>
              <span className="tally__game">
                {result.gamePoints[team] > 0 ? `+${result.gamePoints[team]}` : '—'}
              </span>
            </div>
          ))}
        </div>
        {result.capot && <p className="panel__flourish">All eight tricks. Bonus point.</p>}

        {state.phase === 'match-over' ? (
          <>
            <h3 className="panel__winner">
              {setup.teamNames[state.gamePoints[0] > state.gamePoints[1] ? 0 : 1]} win the match
            </h3>
            {api.online && !api.online.isHost ? (
              <p className="panel__body">
                Waiting for {api.online.hostName} to deal a new match…
              </p>
            ) : (
              <button className="btn btn--gold" onClick={onNewMatch}>
                New match
              </button>
            )}
          </>
        ) : (
          <button className="btn btn--gold" onClick={api.nextHand}>
            Deal the next hand
          </button>
        )}
      </div>
    </div>
  )
}

export function Scoreboard({ state, teamNames }: { state: GameState; teamNames: [string, string] }) {
  return (
    <div className="scoreboard">
      {[0, 1].map((team) => (
        <div key={team} className={`scoreboard__team scoreboard__team--${team}`}>
          <span className="scoreboard__name">{teamNames[team]}</span>
          <span className="scoreboard__chip">{state.gamePoints[team]}</span>
          <span className="scoreboard__sub">{state.cardPoints[team]} pts this hand</span>
        </div>
      ))}
    </div>
  )
}

export function ContractStrip({ state }: { state: GameState }) {
  if (state.contract === null || state.declarer === null) {
    return <span className="contract contract--empty">Bidding open</span>
  }
  return (
    <div className="contract">
      <span className="contract__bid">{state.contract}</span>
      <span className="contract__by">by {nameOf(state, state.declarer)}</span>
    </div>
  )
}

/**
 * The trump marker sitting in the middle of the baize: a face-down card until
 * somebody calls, then it turns over. The declarer alone sees a quiet hint of
 * the suit while it is still down.
 */
export function TrumpMark({ state, viewer }: { state: GameState; viewer: Seat }) {
  if (!state.trump || state.phase === 'bidding') return null
  const declarerSees = state.declarer === viewer && !state.trumpRevealed

  if (state.trumpRevealed) {
    return (
      <div className="trumpmark is-open" title={`Trump: ${SUIT_SYMBOL[state.trump]}`}>
        <span className="trumpmark__suit">{SUIT_SYMBOL[state.trump]}</span>
        <span className="trumpmark__label">Trump</span>
      </div>
    )
  }

  return (
    <div className="trumpmark is-shut">
      <span className="trumpmark__back" aria-hidden />
      <span className="trumpmark__label">
        {declarerSees ? `${SUIT_SYMBOL[state.trump]} yours` : 'Face down'}
      </span>
    </div>
  )
}

export function TrickLog({ state }: { state: GameState }) {
  const lines = state.log.slice(-4)
  return (
    <div className="log">
      {lines.map((line, i) => (
        <p key={`${i}-${line}`} className={i === lines.length - 1 ? 'log__line is-new' : 'log__line'}>
          {line}
        </p>
      ))}
    </div>
  )
}

export { cardLabel }
