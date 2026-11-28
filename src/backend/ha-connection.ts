// Direct connection to Home Assistant for the fast-intent layer.
//
// The connection is a JSON file written by the AISIS dashboard (Connect page) and mounted read-only into the container:
//   {"version":1,"url":"http://192.168.0.39:8123","uuid":"…","name":"Home","client_id":"http://host:8781/",
//    "auth":{"kind":"oauth","refresh_token":"…"} | {"kind":"long_lived","token":"…"},"connected_at":1.7e9}
// Path: /run/aisis-ha/connection.json, or AISIS_HA_STORE (a path only). No file, or one that cannot be read -> the layer is
// disabled.
//
// The dashboard re-discovers Home Assistant on the network and rewrites the file atomically when its address changes, so this
// module never discovers anything: it re-reads the file when its mtime/inode change (one stat per call) and once more right after
// a connection failure, then retries the request once if the address changed.
//
// OAuth: an access token is obtained with the refresh token (POST /auth/token), kept in memory until 60 s before it expires,
// renewed once on a 401. Refresh tokens do not rotate. `invalid_grant` means Home Assistant revoked the access: said once in the
// log, and the layer then behaves as if Home Assistant were unreachable until the file carries another credential or address.
//
// Failures are told apart by what they say about a command that was being sent:
//   HaUnreachableError    the connection was never made (refused, no route, DNS) or the access is revoked: nothing reached HA
//   HaConnectionLostError the connection broke after it was made: a POST may or may not have been executed
//   TimeoutError          the caller's signal fired (the whole call, token refresh included)

import { readFileSync, statSync } from 'node:fs'

import { getLogger } from '../logger'

const logger = getLogger()

const DEFAULT_STORE = '/run/aisis-ha/connection.json'
const TOKEN_MARGIN_S = 60
const TOKEN_TIMEOUT_MS = 3000
// Errno codes of the connect phase: the request cannot have reached Home Assistant.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])

type Auth = { kind: 'long_lived', token: string } | { kind: 'oauth', refreshToken: string }

interface Connection {
  auth: Auth
  clientId: string
  url: string
  uuid: string
}

/** Nothing could connect to Home Assistant, or it revoked the access: no command reached it. */
export class HaUnreachableError extends Error {}

/** Home Assistant revoked the access (`invalid_grant`): retrying at another address does not help. */
export class HaRevokedError extends HaUnreachableError {}

/** The connection broke after it was made: a command in flight may or may not have been executed. */
export class HaConnectionLostError extends Error {}

function parseStore (text: string): Connection | null {
  const raw = JSON.parse(text) as {
    auth?: { kind?: string, refresh_token?: string, token?: string }
    client_id?: string
    url?: string
    uuid?: string
    version?: number
  }
  if (raw.version !== 1 || typeof raw.url !== 'string' || raw.url === '') return null
  const url = raw.url.replace(/\/+$/, '')
  const uuid = raw.uuid ?? ''
  if (raw.auth?.kind === 'long_lived' && typeof raw.auth.token === 'string' && raw.auth.token !== '') {
    return { auth: { kind: 'long_lived', token: raw.auth.token }, clientId: raw.client_id ?? '', url, uuid }
  }
  if (raw.auth?.kind === 'oauth' && typeof raw.auth.refresh_token === 'string' && raw.auth.refresh_token !== '' &&
    typeof raw.client_id === 'string' && raw.client_id !== '') {
    return { auth: { kind: 'oauth', refreshToken: raw.auth.refresh_token }, clientId: raw.client_id, url, uuid }
  }
  return null
}

function storePath (): string {
  return process.env.AISIS_HA_STORE || DEFAULT_STORE
}

let cached: Connection | null = null
let cachedKey = ''
let announced: 'disabled' | 'enabled' | null = null

function announce (state: 'disabled' | 'enabled'): void {
  if (announced === state) return
  announced = state
  logger.info(state === 'enabled' ? 'Home Assistant fast intents enabled' : 'Home Assistant fast intents disabled (no usable connection store)')
}

// One stat per call; the file is parsed only when the dashboard replaced it (an atomic rename changes the inode).
function loadConnection (force = false): Connection | null {
  const path = storePath()
  let key: string
  try {
    const stat = statSync(path)
    key = `${path}:${stat.ino}:${stat.mtimeMs}:${stat.size}`
  } catch {
    cached = null
    cachedKey = ''
    announce('disabled')
    return null
  }
  if (!force && key === cachedKey) return cached
  try {
    cached = parseStore(readFileSync(path, 'utf8'))
  } catch {
    cached = null
  }
  cachedKey = key
  announce(cached === null ? 'disabled' : 'enabled')
  return cached
}

/** True when a usable connection store exists; the layer is disabled otherwise. */
export function haConnected (): boolean {
  return loadConnection() !== null
}

/** Current Home Assistant address from the store, null without one. */
export function haBaseUrl (): null | string {
  return loadConnection()?.url ?? null
}

function instanceOf (connection: Connection): string {
  return connection.uuid === '' ? `url:${connection.url}` : `uuid:${connection.uuid}`
}

/** Which Home Assistant is connected: its uuid (it survives an address change), else the address; null without a store. */
export function haInstanceId (): null | string {
  const connection = loadConnection()
  return connection === null ? null : instanceOf(connection)
}

// One fetch, with its failure classified (see the header). `signal` firing is not a transport failure and passes through.
async function transport (request: () => Promise<Response>, what: string, signal: AbortSignal): Promise<Response> {
  try {
    return await request()
  } catch (error) {
    if (signal.aborted) throw error
    const cause = error instanceof Error ? error.cause : undefined
    const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
    if (code !== undefined && CONNECT_CODES.has(code)) throw new HaUnreachableError(`${what}: ${code}`)
    throw new HaConnectionLostError(`${what}: ${String(error)}`)
  }
}

// Resolves with `promise`, or rejects with the caller's own timeout: a shared refresh never runs on one caller's budget.
async function untilAborted<T> (promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

interface AccessToken {
  expiresAt: number
  key: string
  token: string
}

let accessToken: AccessToken | null = null
let refreshing: null | { key: string, promise: Promise<string> } = null
let revokedKey = ''

async function refreshAccessToken (url: string, clientId: string, refreshToken: string, key: string): Promise<string> {
  const signal = AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  const response = await transport(async () => await fetch(`${url}/auth/token`, {
    body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
    signal
  }), `token refresh at ${url}`, signal)
  if (response.status === 400) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    if (body.error === 'invalid_grant') {
      if (revokedKey !== key) logger.error('Home Assistant revoked the access (invalid_grant): the fast-intent layer cannot reach it until the dashboard reconnects')
      revokedKey = key
      accessToken = null
      throw new HaRevokedError('Home Assistant revoked the access')
    }
    throw new Error(`HA token refresh -> 400 ${body.error ?? ''}`.trim())
  }
  if (!response.ok) throw new Error(`HA token refresh -> ${response.status}`)
  const granted = await response.json() as { access_token?: string, expires_in?: number }
  if (typeof granted.access_token !== 'string') throw new Error('HA token refresh: no access_token')
  const lifetimeS = typeof granted.expires_in === 'number' ? granted.expires_in : 1800
  accessToken = { expiresAt: Date.now() + Math.max(0, lifetimeS - TOKEN_MARGIN_S) * 1000, key, token: granted.access_token }
  return granted.access_token
}

// `rejected`: the access token Home Assistant just answered 401 to; a cached token other than that one (a parallel request
// already renewed it) is used as it is.
async function bearerFor (connection: Connection, signal: AbortSignal, rejected?: string): Promise<string> {
  const { auth } = connection
  if (auth.kind === 'long_lived') return auth.token
  // The address is part of the key: a refresh, or a revocation, answered by another address says nothing about this one.
  const key = `${connection.url}|${connection.uuid}|${auth.refreshToken}`
  if (revokedKey === key) throw new HaRevokedError('Home Assistant revoked the access')
  if (accessToken !== null && accessToken.key === key && Date.now() < accessToken.expiresAt && accessToken.token !== rejected) {
    return accessToken.token
  }
  // Parallel requests of one turn share a single refresh.
  let entry = refreshing
  if (entry === null || entry.key !== key) {
    const started = { key, promise: refreshAccessToken(connection.url, connection.clientId, auth.refreshToken, key) }
    entry = started
    refreshing = started
    started.promise.then(() => undefined, () => undefined).then(() => {
      if (refreshing === started) refreshing = null
    })
  }
  return await untilAborted(entry.promise, signal)
}

async function send (connection: Connection, bearer: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return await transport(async () => await fetch(`${connection.url}${path}`, {
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal
  }), `${connection.url}${path}`, signal)
}

async function attempt (connection: Connection, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const bearer = await bearerFor(connection, signal)
  let response = await send(connection, bearer, path, body, signal)
  if (response.status === 401 && connection.auth.kind === 'oauth') {
    await response.body?.cancel()
    response = await send(connection, await bearerFor(connection, signal, bearer), path, body, signal)
  }
  return response
}

/**
 * One authenticated request to Home Assistant (path like `/api/states`; a `body` makes it a JSON POST). `signal` bounds the whole
 * call, token refresh included: when it fires the request rejects with its TimeoutError. When nothing could connect the store is
 * re-read once and, if the address changed, the request is retried against the new one (never after a connection that broke
 * midway: a POST may already have been executed).
 */
export async function haRequest (path: string, body: unknown, signal: AbortSignal, instance?: null | string): Promise<Response> {
  const connection = loadConnection()
  if (connection === null) throw new HaUnreachableError('no Home Assistant connection store')
  // A turn that began on one home never sends its entity ids to another one the dashboard has connected since.
  if (instance !== undefined && instanceOf(connection) !== instance) throw new HaUnreachableError('Home Assistant changed during the turn')
  try {
    return await attempt(connection, path, body, signal)
  } catch (error) {
    if (!(error instanceof HaUnreachableError) || error instanceof HaRevokedError) throw error
    const fresh = loadConnection(true)
    if (fresh === null || fresh.url === connection.url) throw error
    if (instance !== undefined && instanceOf(fresh) !== instance) throw new HaUnreachableError('Home Assistant changed during the turn')
    logger.info(`Home Assistant moved: ${connection.url} -> ${fresh.url}`)
    return await attempt(fresh, path, body, signal)
  }
}

/** Test hook: forget the in-memory store and token state. */
export function resetHaConnection (): void {
  cached = null
  cachedKey = ''
  announced = null
  accessToken = null
  refreshing = null
  revokedKey = ''
}
