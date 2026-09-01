import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { botAction } from '../src/game/bots'
import { DECK_POINTS } from '../src/game/cards'
import { createGame, needsResolve, reduce } from '../src/game/engine'
import type { GameAction, GameState, PlayerConfig, Seat } from '../src/game/types'
import { mulberry32 } from '../src/game/rng'
import type { LobbyRules, RosterEntry, ServerMessage } from './protocol'
import { Room } from './room'

/**
 * The harness plays the part of every adapter AND every client at once: it
 * feeds messages into the Room and maintains, per player, a replayed game
 * state built only from what that player was sent — which is exactly what the
 * real browser client does.
 */
class Harness {
  room: Room
  outbox = new Map<string, ServerMessage[]>()
  clients = new Map<string, ClientSim>()
  private clock = 1_000_000

  constructor(seed = 7, code = 'TESTA') {
    const rand = mulberry32(seed)
    this.room = new Room(code, {
      send: (playerId, msg) => {
        this.outbox.get(playerId)?.push(msg)
        this.clients.get(playerId)?.receive(msg)
      },
      persist: () => {},
      now: () => this.clock,
      random: rand,
    })
  }

  tick(ms: number): void {
    this.clock += ms
  }

  addPlayer(name: string, kind: 'create' | 'join', token?: string): string {
    // Register mailboxes under a temporary key so the hello's own sends land.
    const result = this.room.hello({ t: kind, name, ...(token ? { token } : {}) })
    assert.ok(result.ok, `hello failed: ${result.ok === false ? result.error : ''}`)
    if (!this.outbox.has(result.playerId)) {
      this.outbox.set(result.playerId, [])
      this.clients.set(result.playerId, new ClientSim())
    }
    this.room.welcome(result.playerId)
    return result.playerId
  }

  helloExpectFail(name: string, kind: 'create' | 'join'): string {
    const result = this.room.hello({ t: kind, name })
    assert.equal(result.ok, false)
    return result.ok === false ? result.error : ''
  }

  send(playerId: string, msg: Parameters<Room['handleMessage']>[1]): void {
    this.room.handleMessage(playerId, msg)
  }

  client(playerId: string): ClientSim {
    return this.clients.get(playerId)!
  }

  lastLobby(playerId: string): { roster: RosterEntry[]; rules: LobbyRules } {
    const msgs = this.outbox.get(playerId) ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.t === 'lobby') return { roster: m.roster, rules: m.rules }
    }
    throw new Error('no lobby message received')
  }

  errors(playerId: string): string[] {
    return (this.outbox.get(playerId) ?? []).flatMap((m) => (m.t === 'err' ? [m.msg] : []))
  }
}

/** A client as the protocol sees it: seed + ordered actions, replayed. */
class ClientSim {
  seed = 0
  roster: RosterEntry[] = []
  rules: LobbyRules | null = null
  actions: GameAction[] = []
  myId = ''

  receive(msg: ServerMessage): void {
    if (msg.t === 'welcome') this.myId = msg.playerId
    if (msg.t === 'begin') {
      this.seed = msg.seed
      this.roster = msg.roster
      this.rules = msg.rules
      this.actions = []
    }
    if (msg.t === 'sync') {
      this.seed = msg.seed
      this.roster = msg.roster
      this.rules = msg.rules
      this.actions = [...msg.actions]
    }
    if (msg.t === 'act') {
      assert.equal(msg.seq, this.actions.length, 'action arrived out of order')
      this.actions.push(msg.action)
    }
  }

  mySeat(): Seat | null {
    return this.roster.find((p) => p.id === this.myId)?.seat ?? null
  }

  state(): GameState {
    const players: PlayerConfig[] = [0, 1, 2, 3].map((seat) => {
      const p = this.roster.find((entry) => entry.seat === seat)
      return { seat, name: p?.name ?? `Seat ${seat + 1}`, isBot: p?.isBot ?? true }
    })
    let state = createGame({
      players,
      seed: this.seed,
      rules: {
        targetGamePoints: this.rules?.targetGamePoints ?? 5,
        minBid: this.rules?.minBid ?? 130,
      },
    })
    for (const action of this.actions) state = reduce(state, action)
    return state
  }
}

describe('the lobby', () => {
  it('gives the creator the table, a token and seat 0', () => {
    const h = new Harness()
    const host = h.addPlayer('AJ', 'create')
    const lobby = h.lastLobby(host)
    const me = lobby.roster.find((p) => p.id === host)!
    assert.equal(me.isHost, true)
    assert.equal(me.seat, 0)
    const welcome = h.outbox.get(host)!.find((m) => m.t === 'welcome')
    assert.ok(welcome && welcome.t === 'welcome' && welcome.token.length > 8)
  })

  it('seats joiners clockwise and refuses a fifth human', () => {
    const h = new Harness()
    h.addPlayer('AJ', 'create')
    h.addPlayer('Ru', 'join')
    h.addPlayer('Kavi', 'join')
    const d = h.addPlayer('Dil', 'join')
    assert.deepEqual(
      h.lastLobby(d).roster.map((p) => p.seat).sort(),
      [0, 1, 2, 3],
    )
    assert.match(h.helloExpectFail('Late', 'join'), /full/i)
  })

  it('rejects joining a table that does not exist', () => {
    const h = new Harness()
    assert.match(h.helloExpectFail('AJ', 'join'), /No table/i)
  })

  it('lets only the host move seats, and swaps occupants', () => {
    const h = new Harness()
    const host = h.addPlayer('AJ', 'create')
    const ru = h.addPlayer('Ru', 'join')

    h.send(ru, { t: 'seat', playerId: ru, seat: 2 })
    assert.equal(h.errors(ru).length, 1, 'guest seat-move should be refused')

    h.send(host, { t: 'seat', playerId: ru, seat: 0 })
    const roster = h.lastLobby(host).roster
    assert.equal(roster.find((p) => p.id === ru)?.seat, 0)
    assert.equal(roster.find((p) => p.id === host)?.seat, 1, 'host swapped into the old seat')
  })

  it('renames duplicate joiners instead of confusing the table', () => {
    const h = new Harness()
    h.addPlayer('AJ', 'create')
    const second = h.addPlayer('AJ', 'join')
    const name = h.lastLobby(second).roster.find((p) => p.id === second)?.name
    assert.equal(name, 'AJ 2')
  })
})

describe('starting a game', () => {
  it('fills every empty seat with a bot and deals', () => {
    const h = new Harness()
    const host = h.addPlayer('AJ', 'create')
    h.send(host, { t: 'start' })

    const client = h.client(host)
    assert.equal(client.roster.length, 4)
    assert.equal(client.roster.filter((p) => p.isBot).length, 3)
    const state = client.state()
    // Three bots act instantly; the deal must have advanced to the only human
    // (or all the way through bidding if the human opens).
    assert.ok(state.handNumber >= 1)
    assert.ok(client.seed > 0)
  })

  it('only the host can start', () => {
    const h = new Harness()
    h.addPlayer('AJ', 'create')
    const ru = h.addPlayer('Ru', 'join')
    h.send(ru, { t: 'start' })
    assert.equal(h.errors(ru).length, 1)
  })

  it('locks rules and seats once play begins', () => {
    const h = new Harness()
    const host = h.addPlayer('AJ', 'create')
    h.send(host, { t: 'rules', rules: { targetGamePoints: 3 } })
    h.send(host, { t: 'start' })
    h.send(host, { t: 'rules', rules: { targetGamePoints: 9 } })
    h.send(host, { t: 'seat', playerId: host, seat: 3 })
    assert.equal(h.errors(host).length, 2)
    assert.equal(h.client(host).rules?.targetGamePoints, 3)
  })
})

describe('playing across the wire', () => {
  it('rejects moves for a seat you do not hold, and trick-sweeping from clients', () => {
    const h = new Harness()
    const host = h.addPlayer('AJ', 'create')
    h.send(host, { t: 'start' })

    h.send(host, { t: 'act', action: { type: 'RESOLVE_TRICK' } })
    const mySeat = h.client(host).mySeat()!
    const otherSeat = ((mySeat + 1) % 4) as Seat
    h.send(host, { t: 'act', action: { type: 'PASS', seat: otherSeat } })
    assert.equal(h.errors(host).length, 2)
  })

  it('plays a whole match with two humans and two bots, all replicas agreeing', () => {
    const h = new Harness(99)
    const host = h.addPlayer('AJ', 'create')
    const friend = h.addPlayer('Ru', 'join')
    h.send(host, { t: 'rules', rules: { targetGamePoints: 3 } })
    h.send(host, { t: 'start' })

    const humans = [host, friend]
    let guard = 0
    while (guard++ < 3000) {
      const state = h.client(host).state()
      if (state.phase === 'match-over') break

      if (state.phase === 'hand-over') {
        h.send(host, { t: 'act', action: { type: 'NEXT_HAND' } })
        continue
      }
      if (needsResolve(state)) {
        // The server sweeps synchronously, so a full trick should never be
        // left on the table between our sends.
        assert.fail('server left a completed trick unresolved')
      }

      const actorSeat = state.phase === 'choosing-trump' ? (state.declarer as Seat) : state.turn
      const actor = humans.find((id) => h.client(id).mySeat() === actorSeat)
      assert.ok(actor, `no human holds seat ${actorSeat}, but the server is waiting on it`)
      const action = botAction(state, actorSeat)
      assert.ok(action)
      h.send(actor!, { t: 'act', action: action! })
    }

    const hostState = h.client(host).state()
    const friendState = h.client(friend).state()
    assert.equal(hostState.phase, 'match-over')
    assert.deepEqual(hostState.gamePoints, friendState.gamePoints)
    assert.deepEqual(hostState.log, friendState.log, 'replicas diverged')
    for (const hand of hostState.history) {
      assert.equal(hand.cardPoints[0] + hand.cardPoints[1], DECK_POINTS)
    }
    assert.equal(h.errors(host).length, 0)
    assert.equal(h.errors(friend).length, 0)
  })

  it('lets a dropped player reclaim their seat with the token and catch up', () => {
    const h = new Harness(5)
    const host = h.addPlayer('AJ', 'create')
    const friend = h.addPlayer('Ru', 'join')
    const friendToken = (() => {
      const w = h.outbox.get(friend)!.find((m) => m.t === 'welcome')
      return w && w.t === 'welcome' ? w.token : ''
    })()
    h.send(host, { t: 'start' })

    // Advance a little, then the friend's connection dies.
    const advance = () => {
      const state = h.client(host).state()
      const actorSeat = state.phase === 'choosing-trump' ? (state.declarer as Seat) : state.turn
      const actor = [host, friend].find((id) => h.client(id).mySeat() === actorSeat)
      if (actor) h.send(actor, { t: 'act', action: botAction(h.client(host).state(), actorSeat)! })
    }
    advance()
    h.room.handleClose(friend)

    advance()

    const back = h.addPlayer('Ru', 'join', friendToken)
    assert.equal(back, friend, 'token must reclaim the same player identity')
    const syncs = h.outbox.get(friend)!.filter((m) => m.t === 'sync')
    assert.ok(syncs.length > 0, 'a rejoining player gets a full sync')
    assert.deepEqual(h.client(friend).state().log, h.client(host).state().log)
  })

  it('a mid-game joiner without a token is turned away', () => {
    const h = new Harness()
    const host = h.addPlayer('AJ', 'create')
    h.send(host, { t: 'start' })
    assert.match(h.helloExpectFail('Late', 'join'), /already started/i)
  })

  it('offers a rematch from match-over and deals a fresh seed', () => {
    const h = new Harness(31)
    const host = h.addPlayer('AJ', 'create')
    h.send(host, { t: 'rules', rules: { targetGamePoints: 3 } })
    h.send(host, { t: 'start' })
    const firstSeed = h.client(host).seed

    let guard = 0
    while (h.client(host).state().phase !== 'match-over' && guard++ < 3000) {
      const state = h.client(host).state()
      if (state.phase === 'hand-over') {
        h.send(host, { t: 'act', action: { type: 'NEXT_HAND' } })
        continue
      }
      const actorSeat = state.phase === 'choosing-trump' ? (state.declarer as Seat) : state.turn
      if (h.client(host).mySeat() !== actorSeat) assert.fail('server stalled on a bot seat')
      h.send(host, { t: 'act', action: botAction(state, actorSeat)! })
    }

    h.send(host, { t: 'start' })
    assert.notEqual(h.client(host).seed, firstSeed)
    assert.notEqual(h.client(host).state().phase, 'match-over')
  })
})
