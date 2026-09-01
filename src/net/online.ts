/**
 * The browser's side of the room protocol: one WebSocket, one subscription.
 *
 * The session holds only what the server sent — roster, rules, seed, the
 * ordered action log — and React reads it through useSyncExternalStore. All
 * game meaning comes from replaying the log through the engine; that happens
 * in the useOnlineGame hook, not here.
 */
import {
  decodeServer,
  encode,
  normalizeCode,
  randomCode,
  type ClientMessage,
  type LobbyRules,
  type RosterEntry,
} from '../../server/protocol'
import type { GameAction, Seat } from '../game/types'
import { roomSocketUrl } from './config'

export type SessionStatus =
  | 'connecting'
  | 'lobby'
  | 'playing'
  | 'dropped'   // connection lost mid-game; token can reclaim the seat
  | 'rejected'  // server said no (bad code, full table, started game)
  | 'closed'

export interface SessionState {
  status: SessionStatus
  code: string
  playerId: string
  roster: RosterEntry[]
  rules: LobbyRules
  seed: number
  actions: GameAction[]
  /** Bumped every time a fresh deal begins, so the UI can reset pacing. */
  matchNonce: number
  error: string | null
}

type Listener = () => void

const STORAGE_PREFIX = '304:room:'

export class OnlineSession {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private snapshot: SessionState
  private token: string | null = null
  private intent: ClientMessage | null = null
  private createRetries = 0

  constructor(public readonly name: string) {
    this.snapshot = {
      status: 'connecting',
      code: '',
      playerId: '',
      roster: [],
      rules: { targetGamePoints: 5, minBid: 130 },
      seed: 0,
      actions: [],
      matchNonce: 0,
      error: null,
    }
  }

  // --- React plumbing -----------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionState => this.snapshot

  private patch(partial: Partial<SessionState>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }

  // --- lifecycle ----------------------------------------------------------

  create(): void {
    this.createRetries = 0
    this.openAs({ t: 'create', name: this.name }, randomCode())
  }

  join(codeInput: string): void {
    const code = normalizeCode(codeInput)
    const stored = safeStorageGet(STORAGE_PREFIX + code)
    this.token = stored
    this.openAs({ t: 'join', name: this.name, ...(stored ? { token: stored } : {}) }, code)
  }

  /** After a drop: reclaim the seat with the stored token. */
  reconnect(): void {
    if (!this.snapshot.code) return
    this.openAs(
      { t: 'join', name: this.name, ...(this.token ? { token: this.token } : {}) },
      this.snapshot.code,
    )
  }

  leave(): void {
    this.intent = null
    this.ws?.close()
    this.ws = null
    this.patch({ status: 'closed' })
  }

  private openAs(intent: ClientMessage, code: string): void {
    this.intent = intent
    this.ws?.close()
    this.patch({ status: 'connecting', code, error: null })

    let ws: WebSocket
    try {
      ws = new WebSocket(roomSocketUrl(code))
    } catch {
      this.patch({ status: 'rejected', error: 'Could not reach the card room server' })
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (this.intent) ws.send(encode(this.intent))
    }
    ws.onmessage = (event) => this.handle(String(event.data))
    ws.onclose = () => {
      if (this.ws !== ws) return // superseded by a newer connection
      if (this.snapshot.status === 'playing') this.patch({ status: 'dropped' })
      else if (this.snapshot.status === 'connecting') {
        this.patch({ status: 'rejected', error: this.snapshot.error ?? 'Could not reach the card room server' })
      } else if (this.snapshot.status === 'lobby') {
        this.patch({ status: 'dropped' })
      }
    }
    ws.onerror = () => {
      /* the close handler does the reporting */
    }
  }

  // --- inbound ------------------------------------------------------------

  private handle(raw: string): void {
    const msg = decodeServer(raw)
    if (!msg) return

    switch (msg.t) {
      case 'welcome': {
        this.token = msg.token
        safeStorageSet(STORAGE_PREFIX + msg.code, msg.token)
        this.patch({ code: msg.code, playerId: msg.playerId })
        return
      }
      case 'lobby': {
        // Mid-game this doubles as a roster refresh (connect/disconnect dots).
        this.patch({
          roster: msg.roster,
          rules: msg.rules,
          status: this.snapshot.status === 'playing' ? 'playing' : 'lobby',
        })
        return
      }
      case 'begin': {
        this.patch({
          status: 'playing',
          seed: msg.seed,
          roster: msg.roster,
          rules: msg.rules,
          actions: [],
          matchNonce: this.snapshot.matchNonce + 1,
        })
        return
      }
      case 'sync': {
        this.patch({
          status: 'playing',
          seed: msg.seed,
          roster: msg.roster,
          rules: msg.rules,
          actions: [...msg.actions],
          matchNonce: this.snapshot.matchNonce + 1,
        })
        return
      }
      case 'act': {
        if (msg.seq !== this.snapshot.actions.length) {
          this.send({ t: 'resync' })
          return
        }
        this.patch({ actions: [...this.snapshot.actions, msg.action] })
        return
      }
      case 'gone': {
        // A fresh create can collide with an existing code — roll a new one.
        if (msg.reason === 'code-taken' && this.intent?.t === 'create' && this.createRetries < 5) {
          this.createRetries++
          this.openAs(this.intent, randomCode())
          return
        }
        this.patch({ status: 'rejected', error: msg.reason })
        return
      }
      case 'err': {
        this.patch({ error: msg.msg })
        return
      }
      case 'pong':
        return
    }
  }

  // --- outbound -----------------------------------------------------------

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg))
  }

  act(action: GameAction): void {
    this.send({ t: 'act', action })
  }

  moveSeat(playerId: string, seat: Seat): void {
    this.send({ t: 'seat', playerId, seat })
  }

  setRules(rules: Partial<LobbyRules>): void {
    this.send({ t: 'rules', rules })
  }

  start(): void {
    this.send({ t: 'start' })
  }

  me(): RosterEntry | undefined {
    return this.snapshot.roster.find((p) => p.id === this.snapshot.playerId)
  }

  isHost(): boolean {
    return this.me()?.isHost ?? false
  }
}

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode etc. — reconnect just won't survive a reload */
  }
}
