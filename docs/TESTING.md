# Testing

This repository uses Mocha with `node-red-node-test-helper` for runtime coverage and
Playwright for real Node-RED editor coverage. `npm test` manages Redis and Valkey
deployments with Docker so the Mocha suite can verify unauthenticated standalone,
authenticated standalone, Cluster, Sentinel, a Unix-socket-only deployment, and optional
AWS MemoryDB behavior, against both engines.

## Prerequisite

Docker Engine with the Compose plugin must be usable by the current user, or via
passwordless `sudo -n docker`.

`npm test` runs `scripts/ensure-docker-ubuntu.sh` first. On Ubuntu 22.04, 24.04, or
26.04 it checks for `docker` and `docker compose`; if either is missing, it installs Docker
Engine using Docker's official apt repository flow. Installation may prompt for `sudo`.
If Docker is installed but the current shell has not picked up docker-group membership yet,
the runner falls back to `sudo -n docker` when available. On non-Ubuntu hosts, install
Docker yourself before running the suite.

Do not start a separate Redis on the test ports while running `npm test`; the runner owns
one local deployment at a time and tears it down with volumes before continuing.

## Main command

Run all deployment tests:

```bash
npm test
```

Redis and Valkey are each tested at their current `:latest` release — there is no pinned
minimum-supported-version matrix. The runner pulls each unique requested image once before
starting deployments, then reuses that local image for the complete run. It verifies the
expected engine and logs the resolved version from `INFO server` for every deployment, but does
not fail on a specific version.

The runner executes these deployments sequentially:

- `single-noauth`: Redis image on `127.0.0.1:6379`; standalone Mocha specs.
- `single-auth`: Redis image on `127.0.0.1:6379` with ACL username/password; the same
  standalone Mocha specs as `single-noauth`, run again under authentication. This is
  deliberately redundant with `single-noauth`: it protects against connection-keying and
  credential-merge regressions that only manifest when a config carries auth options, across
  the entire command surface, not just the auth-specific specs.
- `cluster-auth`: Redis image, two authenticated Cluster masters with all slots assigned;
  topology specs plus Redis 7.2-supported cluster-prone command coverage.
- `sentinel-auth`: Redis image, three authenticated Redis data nodes plus three Sentinel
  processes; topology specs plus Redis 7.2-supported cluster-prone command coverage.
- `valkey-noauth`/`valkey-auth`: the same full standalone suite against Valkey, noauth and
  authenticated. `valkey-cluster-auth` and `valkey-sentinel-auth` run the topology suites
  against Valkey instead of Redis, reusing the exact same spec files (the Valkey Docker image
  ships `redis-server`/`redis-cli`/`redis-sentinel` as symlinks to its own binaries, so no
  command/entrypoint changes were needed). Redis-8.10-only cases (bundled modules, new
  commands and command options, ACL/argument-validation fixes) self-skip on Valkey via a
  `COMMAND INFO` or syntax-probe capability check — see `test/helpers/capability.js`. The
  live `redis-command` datalist-vs-`COMMAND LIST` completeness audit (which expects an exact
  match) self-skips on Valkey entirely, since Valkey doesn't bundle Redis's modules.
- `single-unix`: a temporary Unix-socket-only deployment (TCP disabled, `port 0`) proving the
  `redis-config` Unix socket transport end-to-end. The socket file lives in a host directory
  created with `fs.mkdtempSync` and bind-mounted in for this one deployment, then removed
  afterward — never committed to the repo.
- `memorydb`: optional AWS MemoryDB topology specs when `MEMORYDB_ENABLED=1`.

Blocking and pub/sub tests wait for Redis-observable state (`CLIENT LIST` and `PUBSUB
NUMSUB`/`NUMPAT`) before producing their test data. The short 25 ms intervals in those helpers
are bounded polling, while longer timers are failure timeouts. This keeps the suite event-driven
without making completion depend on a machine-specific sleep duration.

All default images can be overridden with the `REDIS_STANDALONE_IMAGE` / `REDIS_TOPOLOGY_IMAGE`
(Redis deployments and Playwright) and `VALKEY_STANDALONE_IMAGE` / `VALKEY_TOPOLOGY_IMAGE`
(Valkey deployments) environment variables, which each deployment's `compose.yml` reads with a
`redis:latest` / `valkey/valkey:latest` fallback.

Run the browser editor suite:

```bash
npm run test:playwright
```

The Playwright runner starts its own Docker deployment with no-auth standalone Redis,
authenticated standalone Redis, and a two-node authenticated Redis Cluster. It then starts
real Node-RED editor instances and verifies `redis-config` JSON/env/cluster editing, Lua
library-save metadata, `redis-in` command field visibility, and `redis-command` typedInput
initialization. MemoryDB editor coverage is skipped unless all `MEMORYDB_*` variables are
set.

The raw Mocha command is still available for targeted iteration when you have already
started a compatible Redis yourself:

```bash
npm run test:mocha -- test/redis_in_spec.js
```

To run the raw full Mocha glob against a Redis you started yourself:

```bash
npm run test:mocha:all
```

The raw full glob includes topology specs outside their matching deployment, so Mocha may
report them as pending. `npm test` excludes those topology specs from standalone runs and
executes them only in their own deployment stage.

Standalone specs read connection details from:

- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_USERNAME`
- `REDIS_PASSWORD`

Unreachable-host status tests also need a TCP address that **refuses** connections:

- `REDIS_BAD_HOST` (default `127.0.0.1`)
- `REDIS_BAD_PORT` (optional)

When `REDIS_BAD_PORT` is unset, the suite prefers `6399` if that port is closed, otherwise
it auto-picks a free ephemeral port. If you set `REDIS_BAD_PORT` yourself and something is
listening there, the suite fails immediately with a clear error instead of reporting
unrelated "unreachable Redis" timeouts.

The Docker runner sets the good-host variables automatically for local deployments.

## AWS MemoryDB

MemoryDB tests are opt-in and use environment variables only. Do not commit MemoryDB
endpoints or credentials.

Required variables:

```bash
export MEMORYDB_ENABLED=1
export MEMORYDB_ENDPOINT="clustercfg.example.memorydb.region.amazonaws.com"
export MEMORYDB_PORT="6379"
export MEMORYDB_USERNAME="..."
export MEMORYDB_PASSWORD="..."
```

The MemoryDB `redis-config` simulation uses cluster mode with a single startup node:

```json
[
  {
    "dnsLookupStrategy": "identity",
    "host": "$MEMORYDB_ENDPOINT",
    "port": 6379,
    "username": "$MEMORYDB_USERNAME",
    "password": "$MEMORYDB_PASSWORD"
  }
]
```

The runtime interprets `dnsLookupStrategy: "identity"` as ioredis identity DNS lookup with
TLS enabled for the cluster connection.

## Test layout

Do not assume this list is exhaustive forever; confirm with `ls test/*_spec.js`.

Node behavior and lifecycle:

- `redis_in_spec.js` — `redis-in`: blocking pops, pub/sub, `xreadgroup`
- `redis_out_spec.js` — `redis-out`: `xadd`/`zadd`/list payload shaping
- `redis_command_spec.js` — `redis-command`: basic SET/GET/DEL round-trip
- `redis_status_spec.js` — `node.status` and shutdown across all node types
- `redis_lua_conn_spec.js` — Lua connection isolation across config nodes
- `redis_lua_ui_spec.js` — Lua editor/library UI; static HTML parse, needs no Redis
- `redis_credentials_spec.js` — `redis-config` secret merge from the `secrets` credential; constructor-only (no Redis) plus a guarded end-to-end auth case in the auth stage
- `deployment_bad_port_spec.js` — unreachable-host port helper: loud failure when `REDIS_BAD_PORT` is reachable, auto-pick when default 6399 is occupied (no Redis needed)

Command-family coverage, all driving `redis-command` through `client.call`:

- `bit_`, `geo_`, `hash_`, `hyperloglog_`, `key_`, `list_`, `scripting_`, `server_`,
  `set_`, `sorted_set_`, `stream_`, `string_commands_spec.js`
- Redis 8.10 core coverage stays in those matching command-family specs: `HIMPORT` and ordinary
  hash compatibility; `LMOVEM`/`BLMOVEM` ordering, timeout, and shutdown; `SUNIONCARD`/
  `SDIFFCARD`; `XREAD`/`XREADGROUP` `MAXCOUNT` and `MAXSIZE`; the `script_runner` metadata flag;
  expanded `SLOWLOG GET` replies; and compact-hash metrics. Each of these cases uses
  `test/helpers/capability.js` to self-skip when run against Valkey (or an older Redis)
- `scripting_commands_spec.js` additionally drives the `redis-lua-script` node directly for
  read-only (`EVAL_RO`/`EVALSHA_RO`), Function mode (`FCALL`/`FCALL_RO`, reload recovery), and
  block mode — including a server-side dedicated-connection proof that sets an ioredis
  `connectionName` on the config and counts named connections via `CLIENT LIST`
  (non-block nodes must pool onto one connection; each block node must add its own)
- `redis_8_10_commands_spec.js` — one representative test per Redis data-type family with no
  existing spec home: the Array type, Vector Sets, `INCREX`, `XNACK`, and the bundled modules
  (`JSON.*`, `BF.*`, `CF.*`, `CMS.*`, `TOPK.*`, `TDIGEST.*`, `TS.*`), plus the safe `BACKUP HELP`
  path (`BACKUP`'s other subcommands are `@admin`/`@dangerous` and excluded from the datalist).
  It also covers Redis 8.10's Search additions, JSONPath expression families and native syntax
  errors, Time Series additions including blocking `TS.READ` shutdown and `EXCLUDEEMPTY` in
  both range directions, and a regression suite for three Redis 8.10 bug fixes: the ACL
  key-permission bypass on `SORT`/`GEORADIUS`/`GEORADIUSBYMEMBER`/`XREAD`/`XREADGROUP`, `SET`
  rejecting mutually exclusive `NX`/`XX`/`IF*` options, and `VADD ... CAS SETATTR`'s attribute
  count. Not an exhaustive per-command suite — the generic dispatch path plus one case per
  family is the contract. Each case uses a command or syntax capability check when the
  connected server doesn't support that feature, so those feature blocks also self-skip on
  Valkey or an older Redis. The file also compares the live `redis-command` datalist with
  `COMMAND LIST`: every command the deployed Redis supports must be suggested or named in
  `DATALIST_EXCLUSIONS`, and every suggestion must be supported. That current-target audit
  self-skips when `COMMAND LIST` itself is unsupported (a pre-7.0 subcommand) or when the
  connected server is Valkey (whose command catalog structurally lacks Redis's bundled
  modules); it is not a compatibility-floor check
- `ioredis_v6_characterization_spec.js` — characterization tests pinning the legacy
  (pre-ioredis-v6, RESP2-equivalent) reply shapes for `HRANDFIELD WITHVALUES`, `VSIM
WITHSCORES`, `XREAD`, `XREADGROUP`, and the ten ioredis "sorted-set pair" commands, all sent
  through `redis-command` in uppercase (the case the editor saves/suggests). These commands
  have case-sensitive argument/reply transformers in ioredis v6, so this file is the
  known-good baseline the `CASE_SENSITIVE_TRANSFORM_COMMANDS` dispatch-set extension in
  `redis.js` must keep passing; the `VSIM` case self-skips via `COMMAND INFO` when Vector Sets
  are unsupported

Deployment topology coverage:

- `redis_cluster_deployment_spec.js` — Cluster auth, same-slot success, cross-slot failure,
  pub/sub, blocking list, Lua fallback, same-slot FCALL + read-only Lua, block-mode
  Script/Function execution, Redis 7.2 cluster-prone commands, `SUNIONCARD`/`SDIFFCARD`
  same-slot/cross-slot coverage, and Redis 8.10's RESP3 `FT.SEARCH LIMIT` regression. Reused
  verbatim for `valkey-cluster-auth` (gated by `REDIS_DEPLOYMENT`); the Redis-8.10-only cases
  self-skip there via a `COMMAND INFO` capability check
- `redis_sentinel_deployment_spec.js` — Sentinel discovery/auth, pub/sub, blocking list, Lua, FCALL + read-only Lua, block-mode Script/Function with a `CLIENT LIST` dedicated-connection proof on the discovered master, failover/reconnect, Redis 7.2 cluster-prone commands. Reused
  verbatim for `valkey-sentinel-auth` (gated by `REDIS_DEPLOYMENT`)
- `redis_unix_socket_deployment_spec.js` — the `single-unix` deployment: `redis-config`'s
  connection-test endpoint and a normal `redis-command` round-trip over a Unix socket path,
  with TCP disabled entirely (`port 0`)
- `memorydb_deployment_spec.js` — opt-in AWS MemoryDB cluster/auth (JSON and env-var optionsType)/same-slot/cross-slot/Lua, read-only Lua + FCALL and block-mode coverage (gated on engine function support), and Redis 7.2 cluster-prone command coverage

The block-mode server-side proof (counting `CLIENT LIST` entries by `connectionName`) runs in
the standalone and Sentinel specs only: the cluster config path cannot carry an ioredis
`connectionName`, and the block/shared connection keying in `RedisLua` is topology-independent,
so cluster and MemoryDB keep execution-level block coverage.

Helpers:

- `test/helpers/deployment.js` — active standalone Redis config and direct clients
- `test/helpers/cleanup.js` — pattern cleanup for standalone deployments
- `test/helpers/topology.js` — Node-RED flow invocation helpers for topology specs
- `test/helpers/cluster-prone.js` — shared same-slot and cross-slot Redis 7.2 command matrix for Cluster, Sentinel, and MemoryDB
- `test/helpers/wait.js` — polls node properties and Redis client state (subscriptions and blocked commands) instead of guessing fixed delays
- `test/helpers/capability.js` — `isCommandSupported(command)` (a `COMMAND INFO` check) and
  `isCallSyntaxSupported(args)` (tries the call, treats a syntax error as "unsupported") for
  self-skipping Redis-8.10-only test cases scattered across the command-family specs when run
  against Valkey or an older Redis

Browser editor coverage:

- `test/playwright/redis-editor.spec.js` — real Node-RED editor tests
- `test/playwright/helpers/node-red-editor.js` — Node-RED editor launch and interaction helpers
- `test/deployments/playwright-editor/` — Docker Compose deployment used by `npm run test:playwright`

## How the tests work

Behavioral specs follow one pattern:

1. `helper.load(redisNode, flow, cb)` boots a flow made of plain JS objects, including a
   `redis-config` node and `helper` sink nodes.
2. `helper.getNode(id)` grabs a node instance.
3. Tests drive it with `node.receive(msg)` and assert messages from helper sink nodes.
4. `afterEach` unloads Node-RED, then deletes namespaced Redis keys.

All test keys must be namespaced and explicitly cleaned. Do not use shared-test `FLUSHDB`.
`SCRIPT FLUSH` is acceptable only when a test is specifically exercising script-cache
reload behavior.

Topology specs exercise Redis 7.2-supported commands that are easy to misuse in sharded
or discovered deployments: multi-key string/key commands, set and sorted-set algebra,
HyperLogLog merges, multi-stream reads, multi-key blocking pops, transactions, Lua
scripts, `KEYS`/`SCAN`/`DBSIZE`, and `SELECT`. Cluster and MemoryDB assert both hash-tagged
same-slot success and deliberate cross-slot failures; Sentinel asserts the same command
surface against the discovered primary.

## Regression strategy

When behavior changes, add or adjust the narrowest test in the matching spec that fails
before the change and passes after. Prefer extending an existing spec. If you add, rename,
or remove a spec file, update `REFERENCE_MAP.md`, this file, and the maintainer skill file.

## Dependency audit

Run separately and interpret separately — a clean production audit does not imply a clean
full audit:

```bash
npm audit --omit=dev   # the release acceptance gate: must be 0 vulnerabilities
npm audit               # informational: reports the dev-tooling tree too
```

The invariant that matters does not change between refreshes:

- `npm audit --omit=dev` must report **0 vulnerabilities**. `ioredis` is the only production
  dependency this package ships, so this is the release acceptance gate.
- Full `npm audit` reports findings that are **all** reachable only through
  `devDependencies` used to build, run, or format the repository itself — never through the
  published package. Confirm this with `npm ls <package> --all`: every entry should resolve
  under `node-red` (editor/runtime/admin tooling) or `mocha` (reporter dependencies).

Counts drift as advisories are published, so treat the numbers below as a dated observation
rather than an expected value. As of **2026-07-26**, with `node-red@5.0.1`,
`playwright@1.61.1`, `prettier@3.9.5`, `lint-staged@17.1.0`, `ioredis@5.11.1`, and
`mocha@11.7.6` installed:

- `npm audit --omit=dev` → **0 vulnerabilities**.
- Full `npm audit` → **17 development-tree vulnerabilities** (3 low, 4 moderate, 10 high).
  - Via `node-red`: `axios`, `body-parser`, `fast-uri`, `jsonata`, `tar`, `npm`,
    `node-red-admin`, and the `@node-red/*` packages that depend on them
    (`@node-red/util`, `@node-red/runtime`, `@node-red/registry`, `@node-red/editor-api`,
    `@node-red/nodes`).
  - Via `mocha`: `diff`, `serialize-javascript`, `brace-expansion`. `mocha` itself is
    flagged only because of those.

`node-red@5.0.1` and `mocha@11.7.6` are each already the latest release on npm, so no
non-breaking upgrade currently resolves these — `npm audit`'s suggested fixes are
**downgrades** to much older releases (for example `mocha@11.3.0`) and must not be applied.
Re-check for a newer non-major release before every dependency refresh.
Do not allowlist these findings by severity or by dependency name in tooling config — this
note is the record of why they are currently unresolved, not a suppression.

If the registry's advisory endpoint returns a transient error (`invalid json response body
… /security/advisories/bulk`), retry; it is not a repository problem.
