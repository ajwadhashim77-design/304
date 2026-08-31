import { useState } from 'react'

import { DEFAULT_RULES } from '../game/rules'
import type { PlayerConfig, Seat } from '../game/types'
import type { TableMode, TableSetup } from './useGame'

const SUGGESTED = ['Nimal', 'Kavi', 'Ruwan', 'Dilani']

export function SetupScreen({ onStart }: { onStart: (setup: TableSetup) => void }) {
  const [mode, setMode] = useState<TableMode>('pass-and-play')
  const [names, setNames] = useState<string[]>(SUGGESTED)
  const [teamNames, setTeamNames] = useState<[string, string]>(['Us', 'Them'])
  const [target, setTarget] = useState(DEFAULT_RULES.targetGamePoints)
  const [minBid, setMinBid] = useState(DEFAULT_RULES.minBid)

  const setName = (seat: number, value: string) =>
    setNames((prev) => prev.map((n, i) => (i === seat ? value : n)))

  const start = () => {
    const players: PlayerConfig[] = [0, 1, 2, 3].map((seat) => ({
      seat: seat as Seat,
      name: (names[seat] || SUGGESTED[seat]).trim().slice(0, 14),
      isBot: mode === 'solo' && seat !== 0,
    }))
    onStart({
      mode,
      players,
      teamNames,
      rules: { targetGamePoints: target, minBid },
    })
  }

  return (
    <div className="setup">
      <div className="setup__inner">
        <header className="setup__head">
          <p className="setup__eyebrow">Sri Lankan card room</p>
          <h1 className="setup__title">304</h1>
          <p className="setup__tag">
            Thirty-two cards. Two teams. Three hundred and four points on the table, and a
            trump nobody can see.
          </p>
        </header>

        <section className="setup__block">
          <h2 className="setup__label">Table</h2>
          <div className="segmented">
            <button
              className={mode === 'pass-and-play' ? 'is-active' : ''}
              onClick={() => setMode('pass-and-play')}
            >
              Play with friends
              <small>Four of you, one device</small>
            </button>
            <button className={mode === 'solo' ? 'is-active' : ''} onClick={() => setMode('solo')}>
              Practice
              <small>You and three bots</small>
            </button>
          </div>
        </section>

        <section className="setup__block">
          <h2 className="setup__label">Seats &amp; teams</h2>
          <p className="setup__note">Partners sit opposite. North–South play East–West.</p>

          <div className="seating">
            <div className="seating__cell seating__cell--n">
              <SeatField
                seat={2}
                team={0}
                value={names[2]}
                bot={mode === 'solo'}
                onChange={setName}
              />
            </div>
            <div className="seating__cell seating__cell--w">
              <SeatField
                seat={1}
                team={1}
                value={names[1]}
                bot={mode === 'solo'}
                onChange={setName}
              />
            </div>
            <div className="seating__cell seating__cell--table">
              <span className="seating__felt">304</span>
            </div>
            <div className="seating__cell seating__cell--e">
              <SeatField
                seat={3}
                team={1}
                value={names[3]}
                bot={mode === 'solo'}
                onChange={setName}
              />
            </div>
            <div className="seating__cell seating__cell--s">
              <SeatField seat={0} team={0} value={names[0]} bot={false} onChange={setName} />
            </div>
          </div>

          <div className="teamnames">
            {[0, 1].map((t) => (
              <label key={t} className={`teamnames__field teamnames__field--${t}`}>
                <span>Team {t + 1}</span>
                <input
                  value={teamNames[t]}
                  maxLength={16}
                  onChange={(e) =>
                    setTeamNames((prev) => {
                      const next: [string, string] = [...prev]
                      next[t] = e.target.value
                      return next
                    })
                  }
                />
              </label>
            ))}
          </div>
        </section>

        <section className="setup__block">
          <h2 className="setup__label">House rules</h2>
          <div className="rules">
            <label className="rules__field">
              <span>Match to</span>
              <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                {[3, 5, 7, 9].map((n) => (
                  <option key={n} value={n}>
                    {n} game points
                  </option>
                ))}
              </select>
            </label>
            <label className="rules__field">
              <span>Minimum bid</span>
              <select value={minBid} onChange={(e) => setMinBid(Number(e.target.value))}>
                {[100, 120, 130, 150].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="setup__note">
            A contract of 250 or more is worth double, win or lose. All eight tricks pays a
            bonus point.
          </p>
        </section>

        <button className="btn btn--gold btn--wide" onClick={start}>
          Deal
        </button>

        <p className="setup__foot">
          Bluetooth and online rooms are next. The rules engine already speaks in actions, so
          the table can be shared across devices without changing how the game plays.
        </p>
      </div>
    </div>
  )
}

function SeatField({
  seat,
  team,
  value,
  bot,
  onChange,
}: {
  seat: number
  team: number
  value: string
  bot: boolean
  onChange: (seat: number, value: string) => void
}) {
  return (
    <label className={`seatfield seatfield--team${team}`}>
      <span className="seatfield__tag">
        {['South (you)', 'West', 'North', 'East'][seat]}
        {bot && ' · bot'}
      </span>
      <input
        value={value}
        maxLength={14}
        disabled={bot}
        placeholder={SUGGESTED[seat]}
        onChange={(e) => onChange(seat, e.target.value)}
      />
    </label>
  )
}
