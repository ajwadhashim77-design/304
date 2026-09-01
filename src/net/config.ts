/**
 * Where the room server lives.
 *
 * Priority: an explicit ?server=ws://… query parameter (handy for testing and
 * for pointing a Pages build at a staging Worker), then localhost during dev,
 * then the deployed Worker.
 */

/** Set this once after `npx wrangler deploy` prints the workers.dev URL. */
export const PRODUCTION_SERVER = 'wss://three-oh-four.ajwadhashim.workers.dev'

export function serverUrl(): string {
  if (typeof window === 'undefined') return PRODUCTION_SERVER
  const override = new URLSearchParams(window.location.search).get('server')
  if (override) return override
  const host = window.location.hostname
  if (host === 'localhost' || host === '127.0.0.1') return 'ws://localhost:8787'
  return PRODUCTION_SERVER
}

export function roomSocketUrl(code: string): string {
  return `${serverUrl().replace(/\/$/, '')}/ws/${code}`
}
