import { Server } from 'node:http'
import { Server as WSServer } from 'ws'

import { AdmissionPolicy, admitUpgrade, parseAdmissionPolicy, refuseUpgrade } from '../admission'
import { getLogger } from '../logger'
import { UniProxyConnection, UniProxyConnectionParameters } from './uniproxy/uniproxy-connection'

const logger = getLogger()

// The peer ended the connection itself: 1000 normal closure, 1001 going away, 1005 closed with no status code.
// The speaker closes a connection after every exchange and every wake word (its spotter-log socket half a second
// after it opens) and the deploy checks close theirs, so those are not warnings: the dashboard flags every WARN
// that falls into a dialog. Anything else (1006: the link dropped without a close frame; 1002, 1003, 1007, 1008,
// 1009, 1011: protocol, payload or server trouble) still is.
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005])

interface UniProxyRouter {
  connections: Map<string, Set<UniProxyConnection>>
}

export function closeLogLine (code: number, reason: Buffer, deviceId: string,
  ageMs: number): { level: 'info' | 'warn', message: string } {
  const normal = NORMAL_CLOSE_CODES.has(code)
  // The device id is a request header and the reason is peer text: neither goes into the log as it came.
  const device = deviceId.replaceAll(/[^\w.-]/g, '?').slice(0, 40)
  const why = reason.length > 0 ? ` reason=${JSON.stringify(reason.toString('utf8').slice(0, 80))}` : ''
  return {
    level: normal ? 'info' : 'warn',
    message: `UniProxy WebSocket closed${normal ? ' (normal)' : ' abnormally'}: code=${code} device=${device}${why} ` +
      `age=${ageMs}ms`
  }
}

export function registerUniproxyAliceYandexNetRouter (parameters: UniProxyConnectionParameters,
  server: Server, admission: AdmissionPolicy = parseAdmissionPolicy()): UniProxyRouter {
  const wsServer = new WSServer({ noServer: true })
  const knownStations = async (): Promise<Set<string>> => {
    const infos = await parameters.storage.getStationInfos()
    return new Set(infos.map(info => info.duid))
  }

  server.on('upgrade', (request, socket, head) => {
    // The local TLS proxy forwards both the bare service path and the
    // host-prefixed form; accept either.
    if (request.url && (request.url === '/uni.ws' || request.url === '/uniproxy.alice.yandex.net/uni.ws' || request.url === '/uni.ws-with-prefix' || request.url === '/uniproxy.alice.yandex.net/uni.ws-with-prefix')) {
      // Admission runs before the upgrade: a refused client never becomes a connection and none of its frames is
      // decoded. The http module drops its own socket error handler on upgrade and ws adds one only in
      // handleUpgrade, so until then (and for a refused client) a reset must be ignored here: unhandled, it stops
      // the server.
      const ignoreSocketError = (): void => {}
      socket.on('error', ignoreSocketError)
      admitUpgrade(admission, request, knownStations)
        .then(admitted => {
          if (admitted) {
            socket.removeListener('error', ignoreSocketError)
            wsServer.handleUpgrade(request, socket, head, client => {
              wsServer.emit('connection', client, request)
            })
          } else {
            refuseUpgrade(socket)
          }
        })
        .catch((error: unknown) => {
          logger.warn(`UniProxy upgrade failed: ${String(error)}`)
          refuseUpgrade(socket)
        })
    }
  })

  const router: UniProxyRouter = {
    connections: new Map()
  }

  wsServer.on('connection', (websocket, request) => {
    logger.debug('Got WebSocket connection')

    const deviceId = String(request.headers['x-uprx-device-id'] ?? '')
    if (!deviceId) { websocket.close(1008, 'missing device id'); return }
    const platform = String(request.headers['x-uprx-device-model']) ?? 'unknown'
    if (!router.connections.has(deviceId)) {
      router.connections.set(deviceId, new Set())
    }

    const set = router.connections.get(deviceId)
    if (!set) {
      throw new Error('wut?')
    }

    const connection = new UniProxyConnection(websocket, deviceId, platform, parameters)
    const openedAt = Date.now()
    websocket.on('close', (code, reason) => {
      set.delete(connection)
      const line = closeLogLine(code, reason, deviceId, Date.now() - openedAt)
      logger[line.level](line.message)
    })
    websocket.on('error', error => {
      set.delete(connection)
      logger.warn(`UniProxy WebSocket error: ${error}`)
    })
    set.add(connection)
  })

  return router
}
