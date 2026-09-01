/**
 * One table: lobby → seats → deal → relay. Pure logic, no I/O.
 *
 * The adapters own the sockets: the Cloudflare Durable Object in production,
 * the zero-dependency Node server for local play and tests. Both hand messages
 * in and route messages out by player id, so this class can be unit-tested by
 * driving it with plain function calls.
 *
 * The room is the authority. It validates every action against the engine,
 * assigns sequence numbers, and plays the bots itself — clients only ever
 * submit their own moves and replay the ordered log.
 */
import { botAction } from '../src/game/bots'
import { createGame, needsResolve, reduce } from '../src/game/engine'
import type { GameAction, GameState, PlayerConfig, Seat } from '../src/game/types'
import {
  MAX_HUMANS,
  cleanName,
  type ClientMessage,
  type LobbyRules,
  type RosterEntry,
  type ServerMessage,
} from './protocol'

const SEATS: Seat[] = [0, 1, 2, 3]
const BOT_NAMES = ['Sunil', 'Amara', 'Kamal', 'Priya', 'Ruwan', 'Dilani']
/** A room nobody has touched for this long can be reclaimed by a new party. */
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000
/** Hard ceiling on server-driven actions per human action; a full match is well under this. */
const AUTOMATION_LIMIT = 400

interface PlayerRecord extends RosterEntry {
  /** Secret. Lets a dropped player reclaim their seat. Never broadcast. */
  token: string
}

export interface RoomSnapshot {
  code: string
  stage: 'lobby' | 'playing'
  players: PlayerRecord[]
  rules: LobbyRules
  seed: number
  actions: GameAction[]
  lastActivity: number
}

export interface RoomHooks {
  send(playerId: string, msg: ServerMessage): void
  persist(snapshot: RoomSnapshot): void
  now(): number
  random(): number
}

export type HelloResult =
  | { ok: true; playerId: string; token: string }
  | { ok: false; error: string }

const DEFAULT_RULES: LobbyRules = { targetGamePoints: 5, minBid: 130 }

export class Room {
  private stage: 'lobby' | 'playing' = 'lobby'
  private players: PlayerRecord[] = []
  private rules: LobbyRules = { ...DEFAULT_RULES }
  private seed = 0
  private actions: GameAction[] = []
  private state: GameState | null = null
  private lastActivity: number

  constructor(
    public readonly code: string,
    private hooks: RoomHooks,
    snapshot?: RoomSnapshot,
  ) {
    this.lastActivity = hooks.now()
    if (snapshot) {
      this.stage = snapshot.stage
      this.players = snapshot.players.map((p) => ({ ...p, connected: false }))
      this.rules = { ...DEFAULT_RULES, ...snapshot.rules }
      this.seed = snapshot.seed
      this.actions = [...snapshot.actions]
      this.lastActivity = snapshot.lastActivity
      if (this.stage === 'playing') this.state = this.replay()
    }
  }

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      stage: this.stage,
      players: this.players.map((p) => ({ ...p })),
      rules: { ...this.rules },
      seed: this.seed,
      actions: [...this.actions],
      lastActivity: this.lastActivity,
    }
  }

  isEmptyShell(): boolean {
    return this.players.length === 0
  }

  isStale(): boolean {
    return this.hooks.now() - this.lastActivity > ROOM_TTL_MS
  }

  hasLivePlayers(): boolean {
    return this.players.some((p) => !p.isBot && p.connected)
  }

  // --- joining ------------------------------------------------------------

  /**
   * The first message on every connection: claim a fresh room, join one, or
   * reclaim a seat with a token. Returns the player identity the adapter
   * should bind to the socket.
   */
  hello(msg: ClientMessage): HelloResult {
    if (msg.t !== 'create' && msg.t !== 'join') {
      return { ok: false, error: 'Say hello first' }
    }

    // A party that walks into a long-dead room takes the table over.
    if (this.players.length > 0 && this.isStale() && !this.hasLivePlayers()) {
      this.resetToEmpty()
    }

    if (msg.t === 'create') {
      if (this.players.length > 0) return { ok: false, error: 'code-taken' }
      const host = this.addHuman(cleanName(msg.name), true)
      this.afterChange()
      return { ok: true, playerId: host.id, token: host.token }
    }

    // join
    if (msg.token) {
      const existing = this.players.find((p) => !p.isBot && p.token === msg.token)
      if (existing) {
        existing.connected = true
        if (msg.name) existing.name = this.dedupeName(cleanName(msg.name), existing.id)
        this.afterChange()
        return { ok: true, playerId: existing.id, token: existing.token }
      }
    }

    if (this.players.length === 0) return { ok: false, error: 'No table with that code' }
    if (this.stage === 'playing') {
      return { ok: false, error: 'That game has already started' }
    }
    if (this.humans().length >= MAX_HUMANS) {
      return { ok: false, error: 'That table is full' }
    }

    const player = this.addHuman(cleanName(msg.name), false)
    this.afterChange()
    return { ok: true, playerId: player.id, token: player.token }
  }

  /** Called by the adapter once a hello succeeded and the socket is bound. */
  welcome(playerId: string): void {
    const player = this.byId(playerId)
    if (!player) return
    player.connected = true
    this.hooks.send(playerId, {
      t: 'welcome',
      v: 1,
      code: this.code,
      playerId,
      token: player.token,
    })
    if (this.stage === 'playing') {
      this.hooks.send(playerId, this.syncMessage())
    } else {
      this.broadcastLobby()
    }
    this.persist()
  }

  handleClose(playerId: string): void {
    const player = this.byId(playerId)
    if (!player) return
    player.connected = false

    if (this.stage === 'lobby') {
      // A lobby seat is not worth holding for someone who closed the tab.
      this.players = this.players.filter((p) => p.id !== playerId)
      if (player.isHost) {
        const next = this.humans().find((p) => p.connected)
        if (next) next.isHost = true
      }
      this.reseatLobby()
      this.broadcastLobby()
    } else {
      // Mid-game the seat is kept; the token on their device reclaims it.
      this.broadcast(this.syncRosterOnly())
    }
    this.persist()
  }

  // --- lobby & game messages ----------------------------------------------

  handleMessage(playerId: string, msg: ClientMessage): void {
    const player = this.byId(playerId)
    if (!player) return
    this.lastActivity = this.hooks.now()

    switch (msg.t) {
      case 'ping':
        this.hooks.send(playerId, { t: 'pong' })
        return
      case 'resync':
        if (this.stage === 'playing') this.hooks.send(playerId, this.syncMessage())
        else this.broadcastLobby()
        return
      case 'seat':
        return this.handleSeat(player, msg.playerId, msg.seat)
      case 'rules':
        return this.handleRules(player, msg.rules)
      case 'start':
        return this.handleStart(player)
      case 'act':
        return this.handleAct(player, msg.action)
      case 'create':
      case 'join':
        this.hooks.send(playerId, { t: 'err', msg: 'Already at the table' })
        return
    }
  }

  private handleSeat(sender: PlayerRecord, targetId: string, seat: Seat): void {
    if (!sender.isHost) return this.err(sender.id, 'Only the host moves seats')
    if (this.stage !== 'lobby') return this.err(sender.id, 'Seats are locked once the game starts')
    if (!SEATS.includes(seat)) return this.err(sender.id, 'No such seat')
    const target = this.byId(targetId)
    if (!target || target.isBot) return this.err(sender.id, 'No such player')

    const occupant = this.players.find((p) => p.seat === seat)
    const oldSeat = target.seat
    target.seat = seat
    if (occupant && occupant.id !== target.id) occupant.seat = oldSeat
    this.afterChange()
    this.broadcastLobby()
    this.persist()
  }

  private handleRules(sender: PlayerRecord, partial: Partial<LobbyRules>): void {
    if (!sender.isHost) return this.err(sender.id, 'Only the host sets the rules')
    if (this.stage !== 'lobby') return this.err(sender.id, 'Rules are locked once the game starts')
    if (typeof partial.targetGamePoints === 'number' && [3, 5, 7, 9].includes(partial.targetGamePoints)) {
      this.rules.targetGamePoints = partial.targetGamePoints
    }
    if (typeof partial.minBid === 'number' && [100, 120, 130, 150].includes(partial.minBid)) {
      this.rules.minBid = partial.minBid
    }
    this.broadcastLobby()
    this.persist()
  }

  private handleStart(sender: PlayerRecord): void {
    if (!sender.isHost) return this.err(sender.id, 'Only the host deals')

    const rematch = this.stage === 'playing' && this.state?.phase === 'match-over'
    if (this.stage === 'playing' && !rematch) {
      return this.err(sender.id, 'The game is already on')
    }

    if (this.stage === 'lobby') this.fillWithBots()

    this.stage = 'playing'
    this.seed = Math.floor(this.hooks.random() * 0xffffffff) >>> 0
    this.actions = []
    this.state = this.freshGame()

    this.broadcast({
      t: 'begin',
      seed: this.seed,
      roster: this.publicRoster(),
      rules: { ...this.rules },
    })
    this.persist()
    this.runAutomation()
  }

  private handleAct(sender: PlayerRecord, action: GameAction): void {
    if (this.stage !== 'playing' || !this.state) {
      return this.err(sender.id, 'No game in progress')
    }
    if (sender.seat === null) return this.err(sender.id, 'You are not seated')

    if (action.type === 'RESOLVE_TRICK') {
      // The table sweeps its own tricks.
      return this.err(sender.id, 'The table handles that')
    }
    if (action.type === 'NEXT_HAND') {
      if (this.state.phase !== 'hand-over') return this.err(sender.id, 'The hand is still on')
    } else if ('seat' in action && action.seat !== sender.seat) {
      return this.err(sender.id, 'You can only play your own seat')
    }

    if (!this.apply(action)) {
      return this.err(sender.id, 'Not a legal move right now')
    }
    this.persist()
    this.runAutomation()
  }

  // --- the authoritative log ----------------------------------------------

  /** Apply an action if the engine accepts it; broadcast on success. */
  private apply(action: GameAction): boolean {
    if (!this.state) return false
    const logBefore = this.state.log.length
    const next = reduce(this.state, action)
    const rejected = next.log.slice(logBefore).some((line) => line.startsWith('⚠︎'))
    if (rejected) return false

    this.state = next
    this.actions.push(action)
    this.broadcast({ t: 'act', seq: this.actions.length - 1, action })
    return true
  }

  /**
   * Sweep tricks and play every bot seat until it is a human's turn (or the
   * hand is over). Runs instantly server-side; clients pace the playback.
   */
  private runAutomation(): void {
    for (let i = 0; i < AUTOMATION_LIMIT; i++) {
      const state = this.state
      if (!state) return

      if (needsResolve(state)) {
        if (!this.apply({ type: 'RESOLVE_TRICK' })) return
        continue
      }

      // Humans deal the next hand from the table; if nobody is connected the
      // game simply waits here until a token-holder comes back.
      if (state.phase === 'hand-over' || state.phase === 'match-over') break

      const actorSeat: Seat = state.phase === 'choosing-trump' ? (state.declarer as Seat) : state.turn
      const actor = this.players.find((p) => p.seat === actorSeat)
      if (!actor?.isBot) break

      const action = botAction(state, actorSeat)
      if (!action || !this.apply(action)) return
    }
    this.persist()
  }

  private replay(): GameState {
    let state = this.freshGame()
    for (const action of this.actions) state = reduce(state, action)
    return state
  }

  private freshGame(): GameState {
    const players: PlayerConfig[] = SEATS.map((seat) => {
      const p = this.players.find((entry) => entry.seat === seat)
      return { seat, name: p?.name ?? `Seat ${seat + 1}`, isBot: p?.isBot ?? true }
    })
    return createGame({
      players,
      seed: this.seed,
      rules: { targetGamePoints: this.rules.targetGamePoints, minBid: this.rules.minBid },
    })
  }

  // --- roster plumbing -----------------------------------------------------

  private addHuman(name: string, isHost: boolean): PlayerRecord {
    const player: PlayerRecord = {
      id: `p${Math.floor(this.hooks.random() * 1e9).toString(36)}${this.players.length}`,
      token: Array.from({ length: 4 }, () => Math.floor(this.hooks.random() * 1e9).toString(36)).join(''),
      name: this.dedupeName(name, ''),
      seat: this.firstFreeSeat(),
      isBot: false,
      isHost,
      connected: true,
    }
    this.players.push(player)
    return player
  }

  private fillWithBots(): void {
    this.players = this.players.filter((p) => !p.isBot)
    const used = new Set(this.players.map((p) => p.name))
    let nameIx = 0
    for (const seat of SEATS) {
      if (this.players.some((p) => p.seat === seat)) continue
      while (used.has(BOT_NAMES[nameIx % BOT_NAMES.length])) nameIx++
      const name = BOT_NAMES[nameIx % BOT_NAMES.length]
      used.add(name)
      this.players.push({
        id: `bot-${seat}`,
        token: '',
        name,
        seat,
        isBot: true,
        isHost: false,
        connected: true,
      })
    }
  }

  private reseatLobby(): void {
    // Keep chosen seats, but make sure nobody is left floating seatless.
    for (const p of this.players) {
      if (p.seat === null) p.seat = this.firstFreeSeat()
    }
  }

  private afterChange(): void {
    this.lastActivity = this.hooks.now()
    if (!this.players.some((p) => p.isHost) && this.humans().length > 0) {
      this.humans()[0].isHost = true
    }
  }

  private resetToEmpty(): void {
    this.stage = 'lobby'
    this.players = []
    this.rules = { ...DEFAULT_RULES }
    this.seed = 0
    this.actions = []
    this.state = null
  }

  private firstFreeSeat(): Seat | null {
    for (const seat of SEATS) {
      if (!this.players.some((p) => p.seat === seat)) return seat
    }
    return null
  }

  private dedupeName(name: string, selfId: string): string {
    let candidate = name
    let n = 2
    while (this.players.some((p) => p.id !== selfId && p.name === candidate)) {
      candidate = `${name} ${n++}`
    }
    return candidate
  }

  private humans(): PlayerRecord[] {
    return this.players.filter((p) => !p.isBot)
  }

  private byId(id: string): PlayerRecord | undefined {
    return this.players.find((p) => p.id === id)
  }

  publicRoster(): RosterEntry[] {
    return this.players.map(({ token: _token, ...entry }) => ({ ...entry }))
  }

  /**
   * Adapter hook for reconnection plumbing (e.g. sockets that survived a
   * Durable Object hibernation): mark a seat live again without a fresh hello.
   */
  markConnected(playerId: string, connected = true): void {
    const player = this.byId(playerId)
    if (player) player.connected = connected
  }

  // --- outbound ------------------------------------------------------------

  private syncMessage(): ServerMessage {
    return {
      t: 'sync',
      seed: this.seed,
      roster: this.publicRoster(),
      rules: { ...this.rules },
      actions: [...this.actions],
    }
  }

  /** Roster changed mid-game (someone dropped or came back). */
  private syncRosterOnly(): ServerMessage {
    return { t: 'lobby', roster: this.publicRoster(), rules: { ...this.rules } }
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', roster: this.publicRoster(), rules: { ...this.rules } })
  }

  private broadcast(msg: ServerMessage): void {
    for (const p of this.players) {
      if (!p.isBot && p.connected) this.hooks.send(p.id, msg)
    }
  }

  private err(playerId: string, msg: string): void {
    this.hooks.send(playerId, { t: 'err', msg })
  }

  private persist(): void {
    this.hooks.persist(this.snapshot())
  }
}
