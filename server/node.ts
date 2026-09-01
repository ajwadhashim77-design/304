/**
 * The room server as a plain Node process — no dependencies at all, including
 * the WebSocket framing, which is hand-rolled below (RFC 6455, text frames).
 *
 *   npm run server        # ws://localhost:8787
 *
 * This is the local twin of the Cloudflare Worker in `worker.ts`: same Room
 * class, same protocol, so a client pointed at ws://localhost:8787 behaves
 * exactly like one pointed at the deployed Worker. It is also what the
 * end-to-end tests run against, and it would serve a small deployment on any
 * Node host as-is.
 */
import { createHash, randomInt } from 'node:crypto'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'

import { decodeClient, encode, normalizeCode, type ServerMessage } from './protocol'
import { Room } from './room'

const PORT = Number(process.env.PORT ?? 8787)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface Table {
  room: Room
  conns: Map<string, WsConn>
}

const tables = new Map<string, Table>()

function table(code: string): Table {
  let t = tables.get(code)
  if (!t) {
    const conns = new Map<string, WsConn>()
    const room = new Room(code, {
      send: (playerId, msg) => conns.get(playerId)?.sendText(encode(msg)),
      persist: () => {}, // memory-only locally; the Worker persists to storage
      now: () => Date.now(),
      random: () => randomInt(0, 2 ** 31) / 2 ** 31,
    })
    t = { room, conns }
    tables.set(code, t)
  }
  return t
}

function dropIfDead(code: string): void {
  const t = tables.get(code)
  if (t && (t.room.isEmptyShell() || (!t.room.hasLivePlayers() && t.room.isStale()))) {
    tables.delete(code)
  }
}

const server = createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify({ ok: true, service: '304-room-server', tables: tables.size }))
})

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = url.pathname.match(/^\/ws\/([A-Za-z0-9]{3,12})$/)
  const key = req.headers['sec-websocket-key']
  if (!match || typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  const code = normalizeCode(match[1])
  const conn = new WsConn(socket)
  let playerId: string | null = null

  conn.onText = (text) => {
    const msg = decodeClient(text)
    if (!msg) return

    const t = table(code)
    if (playerId === null) {
      const result = t.room.hello(msg)
      if (!result.ok) {
        conn.sendText(encode({ t: 'gone', reason: result.error } satisfies ServerMessage))
        conn.close()
        dropIfDead(code)
        return
      }
      playerId = result.playerId
      t.conns.get(playerId)?.close() // an older tab holding this seat is superseded
      t.conns.set(playerId, conn)
      t.room.welcome(playerId)
      return
    }
    t.room.handleMessage(playerId, msg)
  }

  conn.onClose = () => {
    const t = tables.get(code)
    if (t && playerId !== null && t.conns.get(playerId) === conn) {
      t.conns.delete(playerId)
      t.room.handleClose(playerId)
    }
    dropIfDead(code)
  }
})

server.listen(PORT, () => {
  console.log(`304 room server listening on ws://localhost:${PORT}/ws/<CODE>`)
})

// --- a minimal RFC 6455 endpoint ------------------------------------------

class WsConn {
  onText: (text: string) => void = () => {}
  onClose: () => void = () => {}
  private buffer = Buffer.alloc(0)
  private closed = false

  constructor(private socket: Duplex) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      try {
        this.drain()
      } catch {
        this.close()
      }
    })
    const end = () => {
      if (!this.closed) {
        this.closed = true
        this.onClose()
      }
    }
    socket.on('close', end)
    socket.on('error', end)
  }

  sendText(text: string): void {
    if (this.closed) return
    const payload = Buffer.from(text, 'utf8')
    this.socket.write(Buffer.concat([this.header(0x1, payload.length), payload]))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.write(this.header(0x8, 0))
      this.socket.end()
    } catch {
      /* already gone */
    }
    this.onClose()
  }

  /** Server frames are unmasked: FIN + opcode, then a 7/16/64-bit length. */
  private header(opcode: number, length: number): Buffer {
    if (length < 126) return Buffer.from([0x80 | opcode, length])
    if (length < 65536) {
      const h = Buffer.alloc(4)
      h[0] = 0x80 | opcode
      h[1] = 126
      h.writeUInt16BE(length, 2)
      return h
    }
    const h = Buffer.alloc(10)
    h[0] = 0x80 | opcode
    h[1] = 127
    h.writeBigUInt64BE(BigInt(length), 2)
    return h
  }

  private drain(): void {
    while (true) {
      if (this.buffer.length < 2) return
      const fin = (this.buffer[0] & 0x80) !== 0
      const opcode = this.buffer[0] & 0x0f
      const masked = (this.buffer[1] & 0x80) !== 0
      let length = this.buffer[1] & 0x7f
      let offset = 2

      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > 1_000_000n) throw new Error('frame too large')
        length = Number(big)
        offset = 10
      }

      const maskLength = masked ? 4 : 0
      if (this.buffer.length < offset + maskLength + length) return

      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null
      const payload = Buffer.from(
        this.buffer.subarray(offset + maskLength, offset + maskLength + length),
      )
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length)

      switch (opcode) {
        case 0x1: // text — the only data frame this protocol uses
          if (fin) this.onText(payload.toString('utf8'))
          break
        case 0x8: // close
          this.close()
          return
        case 0x9: // ping → pong
          this.socket.write(Buffer.concat([this.header(0xa, payload.length), payload]))
          break
        default:
          break // pong / binary / continuation: ignored
      }
    }
  }
}
