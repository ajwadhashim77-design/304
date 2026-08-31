import type { GameAction, GameState, Seat } from '../game/types'

/**
 * The seam that multiplayer will slot into.
 *
 * The engine is a pure reducer over a seeded deal, so a table only ever needs
 * to agree on two things: the seed, and the ordered list of actions. Every
 * device replays them and arrives at identical state. No hand data crosses the
 * wire, which also means a peer physically cannot read another player's cards.
 *
 * Implementations planned:
 *   - `LocalTransport`  — pass-and-play on one device. Shipped, below.
 *   - `BleTransport`    — one phone advertises as host, others connect as
 *                         centrals; actions are JSON over a GATT characteristic
 *                         with the host as the ordering authority. Needs the
 *                         Expo shell (react-native-ble-plx), so it lands with
 *                         the native build.
 *   - `SocketTransport` — room code over a small WebSocket relay; the same
 *                         host-orders-actions model, different pipe.
 */

export interface TableMessage {
  /** Monotonic sequence number assigned by the host. */
  seq: number
  action: GameAction
}

export interface TransportEvents {
  onAction: (message: TableMessage) => void
  onPeerChange?: (peers: PeerInfo[]) => void
  onError?: (error: Error) => void
}

export interface PeerInfo {
  id: string
  name: string
  seat: Seat | null
  connected: boolean
}

export interface Transport {
  readonly kind: 'local' | 'ble' | 'socket'
  /** True when this device assigns sequence numbers. */
  readonly isHost: boolean
  connect(events: TransportEvents): Promise<void>
  /** Submit an action. The host validates, orders and echoes it back. */
  send(action: GameAction): void
  disconnect(): void
  peers(): PeerInfo[]
}

/**
 * One device, four players, cards hidden behind a pass-the-phone gate.
 * There is no network here — actions loop straight back — but going through the
 * same interface means the UI never learns whether it is local or remote.
 */
export class LocalTransport implements Transport {
  readonly kind = 'local' as const
  readonly isHost = true
  private events: TransportEvents | null = null
  private seq = 0
  private roster: PeerInfo[]

  constructor(names: string[]) {
    this.roster = names.map((name, i) => ({
      id: `local-${i}`,
      name,
      seat: i as Seat,
      connected: true,
    }))
  }

  async connect(events: TransportEvents): Promise<void> {
    this.events = events
    events.onPeerChange?.(this.roster)
  }

  send(action: GameAction): void {
    this.events?.onAction({ seq: this.seq++, action })
  }

  disconnect(): void {
    this.events = null
  }

  peers(): PeerInfo[] {
    return this.roster
  }
}

/**
 * Replay a list of actions onto a starting state. This is what a late-joining
 * or reconnecting peer will call to catch up, and it is why actions rather than
 * snapshots are the unit of sync.
 */
export function replay(
  initial: GameState,
  actions: GameAction[],
  reduce: (state: GameState, action: GameAction) => GameState,
): GameState {
  return actions.reduce(reduce, initial)
}
