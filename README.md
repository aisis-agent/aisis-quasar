# aisis-quasar

A fork of [v3rt3p/quasar-server](https://github.com/v3rt3p/quasar-server) (Emulator of the Yandex.Station
Quasar backend, by Egor Koleda / radioegor146 and contributors) with the changes that run in the
[AISIS](https://github.com/alex-mextner/aisis) home voice stack: a rooted Yandex Station Mini talks to this
server instead of Yandex's cloud, and AISIS answers what it hears.

## Upstream, license, attribution

- Upstream: <https://github.com/v3rt3p/quasar-server>, base commit `fefcd58` (2026-11-04, "fix: music-service nulls").
  The upstream history is kept unchanged up to that commit; everything after it is the aisis patch series.
- License: **GNU GPL v3** (`LICENSE`, unchanged). Upstream's `package.json` still says `MIT`; the repository's
  `LICENSE` is the GPL-3.0 text, and the patches here are published under the same GPL-3.0. See `NOTICE`.
- The upstream protocol definitions are the git submodule `protos` (`v3rt3p/quasar-protos`); the generated
  `src/protos` is committed as upstream does.

## What the aisis patches add

| Area | Files |
|---|---|
| Streaming STT hand-off, Opus/Ogg and voice-input fixes | `src/backend/stt/gigaam.ts`, `src/codecs/*`, `src/routers/uniproxy/*` |
| Fast local intent layer (Home Assistant: lights, sockets, AC, volume, state queries) before the LLM | `src/backend/ha-intents.ts`, `entity-index.ts`, `intent-catalog.ts`, `fuzzy-ru.ts`, `settings-voice.ts`, `tv-app-intents.ts`, `music-*.ts`, `turn-memory.ts`, `end-dialog.ts`, `negation.ts` |
| Intent grammar hook (asks the AISIS adapter first) and ASR correction | `src/backend/grammar-hook.ts`, `asr-correct.ts` |
| Room of the speaker that heard a phrase, spotter clips | `src/backend/speaker-room.ts`, `src/routers/uniproxy/spotter-clips.ts` |
| Weather questions answered by weather-cli, not the HA weather entity | `src/backend/entity-index.ts` |
| Volume 0 (mute) through directives | `src/routers/alice/base-provider.ts` |
| Who may connect: address admission for the HTTP and WebSocket surface, loopback bind | `src/admission.ts`, `src/main.ts`, `src/routers/uniproxy.alice.yandex.net.ts` |
| Russian intent corpus and runners (offline routing tests) | `src/backend/corpus/` |

Home Assistant access is configured at run time, never in the image build: pass `-e AISIS_HA_URL=… -e AISIS_HA_TOKEN=…`, or mount
a config file at the absolute path the code reads, `-v "$PWD/ha.config.json:/src/ha.config.json:ro"` (copy `ha.config.example.json`; any
`ha.config.json` is gitignored and excluded from the Docker build context). Without either the layer is disabled. Use a `.local` name only
where mDNS resolves; in the container use an address or a DNS name.

No credentials are stored in this repository (checked with gitleaks over the whole patch series). Two things in it name a home:
`src/environment.ts` still defaults the STT and TTS URLs (`STT_GIGAAM_URL`, `TTS_OPENAI_BASE_URL`) to the upstream author's LAN
host, so set both explicitly; and a comment in `src/backend/speaker-room.ts` names two Station device ids.

## Who may connect

Upstream answers every client that can reach its port. On a shared LAN that means anyone can open `/uni.ws` with any `x-uprx-device-id` and run text turns through
the Home Assistant fast-intent layer, ask `GET /quasar.yandex.net/glagol/token?device_id=…` for a control token for any device, or read every speaker's private key
from `GET /quasar.yandex.net/glagol/device_list`. `src/admission.ts` decides per request, from the address the request really came from:

| Variable | Default | Meaning |
|---|---|---|
| `BIND_HOST` | `127.0.0.1` | interface of the HTTP/WebSocket server (the function-state server stays on loopback whatever this says). The AISIS stack reaches a colour through an nginx switch on the same host; a container that publishes ports needs `0.0.0.0` |
| `AISIS_ALLOWED_CLIENTS` | none | comma separated IPs and CIDR ranges admitted besides loopback (the TLS front the speakers connect through). Unset: nobody |
| `AISIS_EDGE_TOKEN` | unset | when set, every non-loopback client must also send it as `x-aisis-edge-token` |
| `AISIS_ADMISSION` | `enforce` | `log` refuses nothing and logs what enforcement would refuse (a rollout aid) |

The client is the `X-Real-IP` of a loopback peer (a reverse proxy on the same host must set it from the address it accepted: nginx `proxy_set_header X-Real-IP $remote_addr;`
replaces a client-sent copy) or the peer itself on a direct connection; headers of a non-loopback peer are never believed. This host is always admitted. A WebSocket from
anyone else must also name a station already in the database (the WebSocket's `x-uprx-device-id`, an HTTP request's `device_id` query parameter: the routes that take one create the station on first sight), so a text turn cannot provision and impersonate a device: provision a new speaker from this host with
`GET http://127.0.0.1:<PORT>/quasar.yandex.net/get_sync_info?device_id=<id>&platform=<platform>`. A refusal is HTTP 403, logged once a minute per reason.
Check: `node_modules/.bin/tsx src/routers/check_admission.mts` (the policy on fake requests, the router and the middleware with real clients, the wiring in `main.ts`).

## Branches and tags

`master` follows upstream; `aisis` is the default branch and carries the patch series.
Each tag marks the source of a production image of the AISIS stack:

| Tag | Image | Contents |
|---|---|---|
| `aisis-upstream-20261106` | `aisis-quasar:upstream-20261106` | upstream `fefcd58` + first local patches |
| `aisis-upstream-20261106b` | `aisis-quasar:upstream-20261106b` | + HA fast-intent layer, sentence splitter |
| `aisis-restore-20261107` | `aisis-quasar:restore-20261107` | + intent corpus, fillers, semantic shadow |
| `aisis-pre-weather-20261117` | `aisis-quasar:volume-zero-predeploy-standby-*` (`77d5109e0e43`) | grammar hook, speaker room, settings, music, TV apps (the stack before the weather change) |
| `aisis-bg-weather-via-cli-20261117` | `aisis-quasar:bg-weather-via-cli-20261117` | + weather via weather-cli |
| `aisis-volume-zero-e859a37b` | `aisis-quasar:volume-zero-e859a37b` | + volume 0 |
| `aisis-bg-admission-safety-20261120` | `aisis-quasar:bg-admission-safety-20261120` | + admission (loopback + voice front only), resource bounds, negation and per-station state, close-code logging, observed-outcome wording (current production image) |

The early commits were recovered from the images because the working tree was never committed
(alex-mextner/aisis#108); their author dates are the image build dates. `src/` at each tag is byte-identical to `/src` of the
image it names (compared file by file, `ha.config.json` aside); the root files are upstream's plus `rig.yaml`, `.dockerignore`
and, after the last tag, the docs, `NOTICE` and CI.

## Build

Same as upstream: the `Dockerfile` installs with pnpm and runs `pnpm start` (`tsx src/main.ts`).

```sh
git clone --recurse-submodules https://github.com/alex-mextner/aisis-quasar
git -C aisis-quasar archive aisis-volume-zero-e859a37b | docker build -t aisis-quasar:from-source -
docker run --rm -e AISIS_HA_URL -e AISIS_HA_TOKEN aisis-quasar:from-source   # plus the ports, Postgres and keys quasar-server needs
```

`git archive` packs the tracked files of the tag only, so nothing untracked in your working tree (a local `.env.local`, a `ha.config.json` holding a Home
Assistant token) can end up in the image. Do not check a historical tag out and `docker build` the directory: the `.dockerignore` of the tags up to
`aisis-volume-zero-e859a37b` excludes only a top-level `ha.config.json`, not `.env.local` or a nested `ha.config.json` (`COPY . .` in the `Dockerfile` copies
whatever is left); the exclusions `**/ha.config.json` and `**/.env.local` come with the `aisis` branch. `docker build .` on the branch head is safe.

AISIS builds its production images from a checkout of a tag of this repository
(see `services/yandex-station/README.md` in the AISIS repository for the blue/green deploy and the
corpus-receipt protocol). Offline routing check, no Home Assistant needed:

```sh
pnpm install --frozen-lockfile --ignore-scripts
node_modules/.bin/tsx src/backend/corpus/run_corpus.mts    # exits 1 unless every row routes as expected
node_modules/.bin/tsx src/backend/corpus/run_dialogs.mts   # multi-turn dialogs, exits 1 on any failure
node_modules/.bin/tsx src/backend/corpus/run_safety.mts    # negation and per-station state, exits 1 on any failure
```

CI runs all three, the admission check and the resource-bound checks.

## Contributing

Issues and pull requests are welcome. Keep changes small; behaviour of the fast-intent layer must keep the corpus
runner green. Changes that belong to the emulator itself are better sent to upstream first.
