/**
 * The room server as a Cloudflare Worker: one Durable Object per room code,
 * using the WebSocket Hibernation API so an idle table costs nothing.
 *
 *   npx wrangler deploy
 *
 * Same Room class and protocol as the local Node server (`node.ts`); this file
 * is only plumbing. It is deliberately self-contained type-wise (the handful
 * of Workers platform types are declared below) so the app's tsconfig never
 * needs Cloudflare's type package — wrangler does its own bundling.
 */
import { decodeClient, encode, normalizeCode, type ServerMessage } from './protocol'
import { Room, type RoomSnapshot } from './room'

// --- just enough of the Workers platform types -----------------------------

interface CfWebSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  deleteAll(): Promise<void>
}

interface DurableObjectState {
  storage: DurableObjectStorage
  acceptWebSocket(ws: CfWebSocket): void
  getWebSockets(): CfWebSocket[]
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

interface Env {
  ROOMS: DurableObjectNamespace
}

declare const WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket }

// --- worker entry ----------------------------------------------------------

const INFO = JSON.stringify({ ok: true, service: '304-room-server' })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/ws\/([A-Za-z0-9]{3,12})$/)

    if (match && request.headers.get('Upgrade') === 'websocket') {
      const code = normalizeCode(match[1])
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
      return stub.fetch(request)
    }

    return new Response(INFO, {
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      },
    })
  },
}

// --- the room object -------------------------------------------------------

interface Attachment {
  playerId: string
}

export class RoomDO {
  private room: Room | null = null

  constructor(private ctx: DurableObjectState) {}

  private async ensureRoom(code: string): Promise<Room> {
    if (this.room) return this.room
    const snapshot = await this.ctx.storage.get<RoomSnapshot>('room')
    this.room = new Room(code, this.hooks(), snapshot)
    // Sockets that survived hibernation come back already bound; the restored
    // roster starts all-disconnected, so mark their seats live again.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.playerId) this.room.markConnected(attachment.playerId)
    }
    return this.room
  }

  private hooks() {
    return {
      send: (playerId: string, msg: ServerMessage) => {
        for (const ws of this.ctx.getWebSockets()) {
          const attachment = ws.deserializeAttachment() as Attachment | null
          if (attachment?.playerId === playerId) {
            try {
              ws.send(encode(msg))
            } catch {
              /* socket already gone; close event will tidy up */
            }
          }
        }
      },
      persist: (snapshot: RoomSnapshot) => {
        void this.ctx.storage.put('room', snapshot)
      },
      now: () => Date.now(),
      random: () => Math.random(),
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const code = normalizeCode(url.pathname.split('/').pop() ?? 'ROOM')
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ensureRoom(code)
    })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.serializeAttachment(null)
    this.ctx.acceptWebSocket(server)

    // Workers' Response takes `webSocket` in its init; TS's DOM lib doesn't
    // know the field, hence the cast.
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    const room = this.room ?? (await this.ensureRoom('ROOM'))
    const msg = decodeClient(message)
    if (!msg) return

    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment?.playerId) {
      const result = room.hello(msg)
      if (!result.ok) {
        ws.send(encode({ t: 'gone', reason: result.error } satisfies ServerMessage))
        ws.close(1008, result.error)
        return
      }
      // An older tab holding this seat is superseded by the new socket.
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue
        const otherAttachment = other.deserializeAttachment() as Attachment | null
        if (otherAttachment?.playerId === result.playerId) other.close(4000, 'superseded')
      }
      ws.serializeAttachment({ playerId: result.playerId } satisfies Attachment)
      room.welcome(result.playerId)
      return
    }

    room.handleMessage(attachment.playerId, msg)
  }

  async webSocketClose(ws: CfWebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment?.playerId || !this.room) return
    const stillHere = this.ctx
      .getWebSockets()
      .some((other) => {
        if (other === ws) return false
        const a = other.deserializeAttachment() as Attachment | null
        return a?.playerId === attachment.playerId
      })
    if (!stillHere) this.room.handleClose(attachment.playerId)
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }
}
