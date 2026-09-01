import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

import type { Seat } from '../game/types'
import { OnlineSession } from '../net/online'
import type { RosterEntry } from '../../server/protocol'
import { GameTable } from './GameTable'
import { useOnlineGame } from './useOnlineGame'

/**
 * The whole online flow: pick a name → create or join → lobby → table.
 * The session object outlives the screens; React just watches it.
 */
export function OnlineFlow({
  onExit,
  initialCode = '',
}: {
  onExit: () => void
  initialCode?: string
}) {
  const [session, setSession] = useState<OnlineSession | null>(null)

  if (!session) {
    return (
      <OnlineEntry
        initialCode={initialCode}
        onCreate={(name) => {
          const s = new OnlineSession(name)
          s.create()
          setSession(s)
        }}
        onJoin={(name, code) => {
          const s = new OnlineSession(name)
          s.join(code)
          setSession(s)
        }}
        onBack={onExit}
      />
    )
  }

  return (
    <SessionScreens
      session={session}
      onLeave={() => {
        session.leave()
        setSession(null)
      }}
      onExit={() => {
        session.leave()
        onExit()
      }}
    />
  )
}

function SessionScreens({
  session,
  onLeave,
  onExit,
}: {
  session: OnlineSession
  onLeave: () => void
  onExit: () => void
}) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const toasts = <Toasts session={session} />

  if (snap.status === 'connecting') {
    return (
      <Shell onBack={onLeave}>
        <p className="online__pulse">Finding the table…</p>
      </Shell>
    )
  }

  if (snap.status === 'rejected' || snap.status === 'closed') {
    return (
      <Shell onBack={onLeave}>
        <p className="online__error">{snap.error ?? 'That didn’t work.'}</p>
        <button className="btn btn--gold" onClick={onLeave}>
          Try again
        </button>
      </Shell>
    )
  }

  if (snap.status === 'lobby') {
    return (
      <>
        <LobbyScreen session={session} onLeave={onLeave} />
        {toasts}
      </>
    )
  }

  // playing (or dropped mid-game, which renders the table plus a banner)
  return (
    <>
      <OnlineTable session={session} onExit={onExit} dropped={snap.status === 'dropped'} />
      {toasts}
    </>
  )
}

function OnlineTable({
  session,
  onExit,
  dropped,
}: {
  session: OnlineSession
  onExit: () => void
  dropped: boolean
}) {
  const api = useOnlineGame(session)
  return (
    <>
      <GameTable api={api} onNewMatch={() => session.start()} onQuit={onExit} />
      {dropped && (
        <div className="overlay">
          <div className="panel">
            <p className="panel__eyebrow">Connection lost</p>
            <h2 className="panel__title">You dropped off the table</h2>
            <p className="panel__body">Your seat is being held. Rejoin when you're ready.</p>
            <button className="btn btn--gold" onClick={() => session.reconnect()}>
              Rejoin the table
            </button>
            <button className="dock__hide" onClick={onExit}>
              Leave the game
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// --- entry -----------------------------------------------------------------

function OnlineEntry({
  onCreate,
  onJoin,
  onBack,
  initialCode,
}: {
  onCreate: (name: string) => void
  onJoin: (name: string, code: string) => void
  onBack: () => void
  initialCode: string
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState(initialCode.toUpperCase())
  const ready = name.trim().length > 0

  return (
    <Shell onBack={onBack}>
      <label className="online__field">
        <span>Your name</span>
        <input
          value={name}
          maxLength={14}
          placeholder="AJ"
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="online__split">
        <div className="online__card">
          <h2>Open a table</h2>
          <p>You get a five-letter code. Up to three friends join with it; bots fill the rest.</p>
          <button className="btn btn--gold" disabled={!ready} onClick={() => onCreate(name)}>
            Create table
          </button>
        </div>

        <div className="online__card">
          <h2>Join a table</h2>
          <p>Type the code from whoever opened it.</p>
          <input
            className="online__code-input"
            value={code}
            maxLength={5}
            placeholder="ABCDE"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready && code.trim().length >= 4) onJoin(name, code)
            }}
          />
          <button
            className="btn btn--gold"
            disabled={!ready || code.trim().length < 4}
            onClick={() => onJoin(name, code)}
          >
            Join
          </button>
        </div>
      </div>
    </Shell>
  )
}

// --- lobby -----------------------------------------------------------------

const SEAT_LABEL = ['South', 'West', 'North', 'East']

function LobbyScreen({ session, onLeave }: { session: OnlineSession; onLeave: () => void }) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const isHost = session.isHost()
  const humans = snap.roster.filter((p) => !p.isBot)

  return (
    <Shell onBack={onLeave} wide>
      <div className="lobby__codebox">
        <span className="lobby__codelabel">Table code</span>
        <span className="lobby__code" data-code={snap.code}>
          {snap.code.split('').map((ch, i) => (
            <b key={i}>{ch}</b>
          ))}
        </span>
        <span className="lobby__hint">
          Friends open the game, choose Online, and join with this code.
        </span>
        <CopyRow code={snap.code} />
      </div>

      <section className="setup__block">
        <h2 className="setup__label">Seats &amp; teams</h2>
        <p className="setup__note">
          South &amp; North are partners; West &amp; East are partners. Empty seats get a bot when
          the game starts.
        </p>
        <div className="lobby__seats">
          {([0, 2, 1, 3] as Seat[]).map((seat) => (
            <SeatRow
              key={seat}
              seat={seat}
              roster={snap.roster}
              humans={humans}
              isHost={isHost}
              myId={snap.playerId}
              onAssign={(playerId) => session.moveSeat(playerId, seat)}
            />
          ))}
        </div>
      </section>

      <section className="setup__block">
        <h2 className="setup__label">House rules</h2>
        <div className="rules">
          <label className="rules__field">
            <span>Match to</span>
            <select
              value={snap.rules.targetGamePoints}
              disabled={!isHost}
              onChange={(e) => session.setRules({ targetGamePoints: Number(e.target.value) })}
            >
              {[3, 5, 7, 9].map((n) => (
                <option key={n} value={n}>
                  {n} game points
                </option>
              ))}
            </select>
          </label>
          <label className="rules__field">
            <span>Minimum bid</span>
            <select
              value={snap.rules.minBid}
              disabled={!isHost}
              onChange={(e) => session.setRules({ minBid: Number(e.target.value) })}
            >
              {[100, 120, 130, 150].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {snap.error && <p className="online__error">{snap.error}</p>}

      {isHost ? (
        <button className="btn btn--gold btn--wide" onClick={() => session.start()}>
          Deal — bots fill the empty seats
        </button>
      ) : (
        <p className="online__pulse">
          Waiting for {snap.roster.find((p) => p.isHost)?.name ?? 'the host'} to deal…
        </p>
      )}
    </Shell>
  )
}

/**
 * Corner notices for table comings and goings: joins and leaves in the lobby,
 * drops and returns mid-game. Derived client-side by diffing roster updates.
 */
interface Toast {
  id: number
  text: string
}

function Toasts({ session }: { session: OnlineSession }) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [toasts, setToasts] = useState<Toast[]>([])
  const prev = useRef<Map<string, RosterEntry> | null>(null)
  const nextId = useRef(1)

  useEffect(() => {
    const humans = snap.roster.filter((p) => !p.isBot)
    const current = new Map(humans.map((p) => [p.id, p]))
    const before = prev.current
    prev.current = current
    if (before === null) return // don't announce the roster you walked in on

    const notices: string[] = []
    for (const [id, p] of current) {
      if (p.id === snap.playerId) continue
      const was = before.get(id)
      if (!was) notices.push(`${p.name} joined the table`)
      else if (!was.connected && p.connected) notices.push(`${p.name} is back`)
      else if (was.connected && !p.connected) notices.push(`${p.name} lost their connection`)
    }
    for (const [id, p] of before) {
      if (id !== snap.playerId && !current.has(id)) notices.push(`${p.name} left the table`)
    }
    if (notices.length === 0) return

    const added = notices.map((text) => ({ id: nextId.current++, text }))
    setToasts((t) => [...t, ...added].slice(-3))
    for (const toast of added) {
      window.setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== toast.id)),
        3600,
      )
    }
  }, [snap.roster, snap.playerId])

  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.text}
        </div>
      ))}
    </div>
  )
}

/** Copy the bare code, or a link that opens the game with the code filled in. */
function CopyRow({ code }: { code: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)

  const copy = async (what: 'code' | 'link') => {
    const text = what === 'code' ? code : inviteLink(code)
    const ok = await writeClipboard(text)
    setCopied(ok ? what : null)
    if (ok) window.setTimeout(() => setCopied(null), 1800)
  }

  return (
    <div className="lobby__copy">
      <button className="copybtn" onClick={() => void copy('code')}>
        {copied === 'code' ? 'Copied ✓' : 'Copy code'}
      </button>
      <button className="copybtn copybtn--gold" onClick={() => void copy('link')}>
        {copied === 'link' ? 'Link copied ✓' : 'Copy invite link'}
      </button>
    </div>
  )
}

function inviteLink(code: string): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('join', code)
  return url.toString()
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older browsers / odd contexts: the hidden-textarea fallback.
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

function SeatRow({
  seat,
  roster,
  humans,
  isHost,
  myId,
  onAssign,
}: {
  seat: Seat
  roster: RosterEntry[]
  humans: RosterEntry[]
  isHost: boolean
  myId: string
  onAssign: (playerId: string) => void
}) {
  const occupant = roster.find((p) => p.seat === seat)
  const team = seat % 2

  return (
    <div className={`seatrow seatrow--team${team}`}>
      <span className="seatrow__label">{SEAT_LABEL[seat]}</span>
      {isHost ? (
        <select
          className="seatrow__pick"
          value={occupant && !occupant.isBot ? occupant.id : 'bot'}
          onChange={(e) => {
            if (e.target.value !== 'bot') onAssign(e.target.value)
          }}
        >
          <option value="bot">Bot</option>
          {humans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === myId ? ' (you)' : ''}
            </option>
          ))}
        </select>
      ) : (
        <span className="seatrow__name">
          {occupant && !occupant.isBot ? occupant.name : 'Bot'}
          {occupant?.id === myId ? ' (you)' : ''}
        </span>
      )}
      <span className="seatrow__team">{team === 0 ? 'N–S' : 'E–W'}</span>
    </div>
  )
}

function Shell({
  children,
  onBack,
  wide,
}: {
  children: ReactNode
  onBack: () => void
  wide?: boolean
}) {
  return (
    <div className="setup">
      <div className={wide ? 'setup__inner' : 'setup__inner setup__inner--narrow'}>
        <header className="online__head">
          <button className="btn btn--ghost" onClick={onBack} aria-label="Back">
            ←
          </button>
          <div>
            <p className="setup__eyebrow">Online table</p>
            <h1 className="online__title">304</h1>
          </div>
        </header>
        {children}
      </div>
    </div>
  )
}
