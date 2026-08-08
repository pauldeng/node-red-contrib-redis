# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking changes

- **`ioredis` is now v6.** RESP3 is the default wire protocol between this package and Redis;
  ioredis's default `legacy` reply mapping keeps existing Node-RED payload shapes stable (see
  Fixed, below, for the dispatch-side half of that). `redis-instance` exposes the ioredis v6
  client, a deliberate semver-major change to the raw client this package hands out.

### Added

- `redis-config` **Single** mode gains a **Transport** selector: **TCP** (the default,
  unchanged) or **Unix socket**. Unix socket serializes as `{path, username?, password?, db?}`
  and removes stale `host`/`port`/`family`/`tls`; switching back to TCP removes the saved
  `path`, since ioredis gives it precedence over `host`/`port`. Scoped to local standalone
  Single connections only — not offered for Cluster, Sentinel, or alongside TLS. No runtime or
  saved-flow schema change was needed; ioredis already accepts `{path: "/path/to/redis.sock"}`.
  Empty socket paths cannot be tested or saved, and existing TCP `family` options survive
  opening the editor or temporarily switching transports.

### Fixed

- `redis-command`'s uppercase-dispatch normalization (previously scoped to
  `HSET`/`HMSET`/`MSET`/`MSETNX`) now also covers `HRANDFIELD`, `VSIM`, `XREAD`, `XREADGROUP`,
  and the ten ioredis "sorted-set pair" commands (`ZDIFF`/`ZINTER`/`ZPOPMAX`/`ZPOPMIN`/
  `ZUNION`/`ZRANDMEMBER`/`ZRANGE`/`ZRANGEBYSCORE`/`ZREVRANGE`/`ZREVRANGEBYSCORE`). ioredis v6
  registers these commands' RESP3-to-legacy reply mapping under the exact lowercase spelling
  only; without this, their replies would have silently switched from the pre-v6 flat
  `[member, score, ...]` array shape to RESP3's native nested pairs whenever the editor's
  suggested uppercase spelling was saved. `HGETALL` remains a deliberate exception — its
  case-sensitive reply transformer is still bypassed, so it keeps returning a flat array.
- `redis-in` `subscribe`/`psubscribe` now wait for the client's `ready` event before issuing
  the initial SUBSCRIBE/PSUBSCRIBE (immediately if already `ready`). Previously, a config with
  ioredis's `enableOfflineQueue: false` could reject that very first command because it was
  sent before the client was ready, permanently failing to subscribe. A `lazyConnect` client
  is started explicitly before waiting for `ready`. Every reconnect after the first is
  unaffected — ioredis's own re-subscription already covers it.

## [2.0.0] - 2026-07-26

First release since `1.4.0`. Read the **Breaking changes** section before upgrading: existing
flows keep working, but several nodes now surface errors that previous versions discarded.

### Breaking changes

- **Node-RED 5 and Node.js 22.9 are now required.** `package.json` declares
  `engines.node >= 22.9` and `node-red.version >= 5.0.0`, so the palette will not offer this
  release to older installs. These are the versions the test matrix actually exercises;
  Node-RED 4 is untested rather than known-broken.
- **`redis-out` now reports write failures.** Writes are awaited and errors are passed to
  `done()`, so a `WRONGTYPE`, an ACL denial, or a lost connection reaches the node's error
  path and can be handled by a _catch_ node. Previous versions discarded these silently, so
  flows that appeared to succeed may now log errors that were always happening.
- **Shared connections are keyed by config-node id, not display name.** Two `redis-config`
  nodes that happened to share a name — the common case, since `Local` is the default —
  previously collapsed onto one client, silently pointing some nodes at the wrong server or
  database. Nodes that were incorrectly sharing a connection now get the correct one.
- **`redis-command` argument handling is explicit about falsy values.** A `msg.payload` of
  `0`, `false`, or `""` is now sent as a real argument instead of being dropped. An empty
  array or empty object means "no extra arguments". A saved `Params` of `null` contributes no
  argument. Malformed `Params` JSON is reported as an error instead of being silently ignored.
- **`redis-lua-script` with Keys=0 no longer invents an empty ARGV.** An absent or `null`
  `msg.payload` contributes zero `ARGV` entries (previously one empty string). A non-array
  object payload is rejected with `Payload is not Array` instead of being coerced to the
  literal `"[object Object]"`. A scalar or `Buffer` payload is still sent as a single `ARGV`.
- **`redis-in` `xreadgroup` splits its Topic at the last colon.** `<stream-key>:<id>` now
  allows colons inside the stream key (`app:events:log:>`). Single-colon topics behave exactly
  as before.
- **`HSET`/`MSET`/`HMSET`/`MSETNX` accept object payloads regardless of saved letter case.**
  Every other command, including `HGETALL`, is sent with the case that was saved; uppercase
  `HGETALL` therefore returns a flat array rather than an object. See `docs/NODE_GUIDE.md`.
- **`async` is no longer a dependency.** `ioredis` is now the only production dependency.

### Added

- `redis-in`: `XREADGROUP` support for stream consumer groups, with `groupname`/`consumername`
  fields and optional JSON field mapping.
- `redis-in`: blocking consumers (`BLPOP`/`BRPOP`/`BZPOPMIN`/`BZPOPMAX`/`XREADGROUP`)
  auto-recover from transient errors using capped exponential backoff with jitter, and exit
  promptly on redeploy.
- `redis-in`: a refused `SUBSCRIBE`/`PSUBSCRIBE` (for example an ACL user without pubsub
  access) is now reported through the node's error path and shown as a red status. Earlier
  versions left the node green and permanently silent.
- `redis-lua-script`: a failed stored `SCRIPT LOAD` (for example a Lua compile error) is
  reported through `node.error`, matching Function-mode `FUNCTION LOAD` failure reporting.
- `redis-lua-script`: **Function mode** — treats the editor content as a Redis Functions
  library, runs `FUNCTION LOAD REPLACE` on deploy and reconnect, and invokes a registered
  function with `FCALL`. Cluster deployments load on every master, and a library flushed out
  of band is reloaded once and retried, with concurrent reloads coalesced into one load.
- `redis-lua-script`: **Read-only** option selecting `EVAL_RO`/`EVALSHA_RO`/`FCALL_RO`.
- `redis-lua-script`: **Stored Script** option using `SCRIPT LOAD` plus `EVALSHA`, with
  automatic `EVAL` fallback when Redis reports `NOSCRIPT`.
- `redis-config`: Cluster, Sentinel, and AWS (MemoryDB/ElastiCache) connection modes with
  provider auto-detection, a redesigned editor that keeps the form and the JSON in sync, and
  an option to read connection options from an environment variable.
- `redis-config`: a **Test connection** button that runs a real `PING` and returns a verbose,
  credential-redacted log.
- `redis-config`: passwords are stored in an encrypted `secrets` credential instead of
  `flows.json`. A legacy password embedded in `options` keeps working and migrates to the
  credential the next time the config is opened and saved.
- Real connection status (`connected`/`connecting`/`reconnecting`/`disconnected`) on every
  node type, and graceful `QUIT` on shutdown for non-blocking connections.
- Example flows under `examples/` for pub/sub, list queues, priority queues, streams, Lua
  scripts, and Redis Functions.
- A Docker-managed test matrix (`npm test`) covering standalone with and without auth,
  Cluster, Sentinel, and opt-in AWS MemoryDB, plus a real-browser editor suite
  (`npm run test:playwright`).

### Fixed

- `redis-lua-script` used an unresolved `n.server` as its connection id, collapsing every
  non-blocking Lua node onto a single pool key.
- Blocking `redis-in` connections queued `QUIT` behind an in-flight command on shutdown and
  never released the socket; they now disconnect immediately.
- Monaco editor model leak when reopening a `redis-lua-script` node.
- JSONata evaluation of environment-variable options in `redis-config`.
- `redis-in` editor fields now show and hide correctly for the selected command, and
  `groupname`/`consumername` are validated as required for `xreadgroup`.
- Deprecated jQuery `.size()` call and several incorrect or missing editor labels and icons.

### Security

- Passwords are kept out of `flows.json` (see Added, `redis-config`).
- **Known issue:** a password embedded in a Redis connection **URL**
  (`redis://user:pass@host`) is not redacted by the connection-test error path, so it can
  appear in the `/redis-config/test` response and in the Node-RED log. Object-form options
  (`{"password": "…"}`) are redacted correctly. Prefer object-form options, or a `secrets`
  credential, when the log destination is not trusted.

### Packaging

- The published tarball is restricted to `redis.js`, `redis.html`, `icons/`, `examples/`, and
  the README assets — tests, deployment infrastructure, and agent/development docs are no
  longer shipped.
