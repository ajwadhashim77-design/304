/**
 * The wire protocol between the game client and a room.
 *
 * Sync model: the server never sends game state. It sends the deal's seed and
 * an ordered log of actions; every client replays them through the same pure
 * engine and arrives at identical state. Reconnecting is replaying. (It also
 * means a determined friend could compute your hand from the seed — this is a
 * card table for people you know, not a casino.)
 */
import type { GameAction, Seat } from '../src/game/types'

export const PROTOCOL_VERSION = 1

/** Room codes: 5 characters, no lookalikes (no O/0, I/1/L, S/5...). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789'
export const CODE_LENGTH = 5

export const MAX_HUMANS = 4

export interface RosterEntry {
  id: string
  name: string
  seat: Seat | null
  isBot: boolean
  isHost: boolean
  connected: boolean
}

export interface LobbyRules {
  targetGamePoints: number
  minBid: number
}

// --- client → server -------------------------------------------------------

export type ClientMessage =
  | { t: 'create'; name: string }
  | { t: 'join'; name: string; token?: string }
  | { t: 'seat'; playerId: string; seat: Seat }     // host, lobby only
  | { t: 'rules'; rules: Partial<LobbyRules> }      // host, lobby only
  | { t: 'start' }                                  // host; also rematch
  | { t: 'act'; action: GameAction }
  | { t: 'resync' }
  | { t: 'ping' }

// --- server → client -------------------------------------------------------

export type ServerMessage =
  | { t: 'welcome'; v: number; code: string; playerId: string; token: string }
  | { t: 'lobby'; roster: RosterEntry[]; rules: LobbyRules }
  | { t: 'begin'; seed: number; roster: RosterEntry[]; rules: LobbyRules }
  | { t: 'act'; seq: number; action: GameAction }
  | {
      t: 'sync'
      seed: number
      roster: RosterEntry[]
      rules: LobbyRules
      actions: GameAction[]
    }
  | { t: 'gone'; reason: string }
  | { t: 'err'; msg: string }
  | { t: 'pong' }

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg)
}

export function decodeClient(raw: unknown): ClientMessage | null {
  return decodeAny(raw) as ClientMessage | null
}

export function decodeServer(raw: unknown): ServerMessage | null {
  return decodeAny(raw) as ServerMessage | null
}

function decodeAny(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { t?: unknown }).t === 'string') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function randomCode(rand: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)]
  }
  return code
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function cleanName(input: string): string {
  const name = input.trim().slice(0, 14)
  return name.length > 0 ? name : 'Player'
}
