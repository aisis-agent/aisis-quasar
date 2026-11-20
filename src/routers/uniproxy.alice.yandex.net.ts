import { Server } from 'node:http'
import { Server as WSServer } from 'ws'

import { AdmissionPolicy, admitUpgrade, parseAdmissionPolicy, refuseUpgrade } from '../admission'
import { getLogger } from '../logger'
import { UniProxyConnection, UniProxyConnectionParameters } from './uniproxy/uniproxy-connection'

const logger = getLogger()

interface UniProxyRouter {
  connections: Map<string, Set<UniProxyConnection>>
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
    websocket.on('close', () => {
      set.delete(connection)
      logger.warn('UniProxy WebSocket closed')
    })
    websocket.on('error', error => {
      set.delete(connection)
      logger.warn(`UniProxy WebSocket error: ${error}`)
    })
    set.add(connection)
  })

  return router
}
