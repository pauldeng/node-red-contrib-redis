# Reference Map

This document is the fastest entry point for humans and coding agents working on current branch.

## Read order by task

For any task, start with the entry point for your agent:

- Codex: `../AGENTS.md` and
  `../.codex/skills/node-red-contrib-redis-maintainer/SKILL.md`
- Claude: `../CLAUDE.md` and
  `../.claude/skills/node-red-contrib-redis-maintainer/SKILL.md`

`AGENTS.md` is canonical and `CLAUDE.md` imports it, so both agents read the same guidance.

Then read:

1. `ARCHITECTURE.md`
2. `NODE_GUIDE.md`
3. `CHANGE_WORKFLOW.md`
4. `TESTING.md`
5. `TROUBLESHOOTING.md`

## Repository layout

Top-level implementation:

- `../package.json`
- `../redis.js`
- `../redis.html`

Tests (Mocha spec files). Run the Docker-managed matrix with `npm test`; do not
rely on this list staying exhaustive — confirm with `ls test/*_spec.js`.

Node behavior and lifecycle:

- `../test/redis_in_spec.js` — `redis-in` blocking pops, pub/sub, streams
- `../test/redis_out_spec.js` — `redis-out` payload shaping
- `../test/redis_command_spec.js` — `redis-command` basic SET/GET/DEL flow
- `../test/redis_status_spec.js` — status + shutdown across **all** node types
- `../test/redis_lua_conn_spec.js` — Lua connection isolation across config nodes
- `../test/redis_lua_ui_spec.js` — Lua editor/library UI (static HTML parse, no Redis needed)
- `../test/redis_credentials_spec.js` — `redis-config` secret merge from the `secrets` credential (single/cluster/sentinel/legacy/env) plus guarded end-to-end auth
- `../test/deployment_bad_port_spec.js` — unreachable-host port helper (`REDIS_BAD_PORT` loud failure / auto-pick; no Redis needed)

Command-family coverage (all drive `redis-command` via `client.call`):

- `../test/bit_commands_spec.js`
- `../test/geo_commands_spec.js`
- `../test/hash_commands_spec.js`
- `../test/hyperloglog_commands_spec.js`
- `../test/key_commands_spec.js`
- `../test/list_commands_spec.js`
- `../test/scripting_commands_spec.js`
- `../test/server_commands_spec.js`
- `../test/set_commands_spec.js`
- `../test/sorted_set_commands_spec.js`
- `../test/stream_commands_spec.js`
- `../test/string_commands_spec.js`
- `../test/redis_8_10_commands_spec.js` — representative coverage (Array, Vector Sets,
  `INCREX`, `XNACK`, and the bundled `JSON`/`BF`/`CF`/`CMS`/`TOPK`/`TDIGEST`/`TS` modules) for
  Redis data-type families with no existing family spec, Search/JSONPath/Time Series
  additions, a regression suite for three Redis 8.10 ACL/argument-validation fixes, plus the
  safe `BACKUP HELP` path and the live `redis-command` datalist-vs-`COMMAND LIST`
  completeness check; each case self-skips via `COMMAND INFO` (or a syntax probe, see
  `test/helpers/capability.js`) when the connected server lacks that feature — including when
  run against Valkey, which does not bundle Redis's modules or 8.10-era commands
- `../test/ioredis_v6_characterization_spec.js` — pins the legacy (pre-v6, RESP2-equivalent)
  reply shapes for `HRANDFIELD WITHVALUES`, `VSIM WITHSCORES`, `XREAD`, `XREADGROUP`, and the
  ten ioredis "sorted-set pair" commands (`zdiff`/`zinter`/`zpopmax`/`zpopmin`/`zunion`/
  `zrandmember`/`zrange`/`zrangebyscore`/`zrevrange`/`zrevrangebyscore`) sent through
  `redis-command` in uppercase, verified against ioredis v6 + RESP3 with the
  `CASE_SENSITIVE_TRANSFORM_COMMANDS` dispatch-set extension in `redis.js`

Deployment topology coverage:

- `../test/redis_cluster_deployment_spec.js` — Cluster auth, same-slot/cross-slot behavior, pub/sub, blocking list, Lua fallback, same-slot FCALL + read-only Lua, Redis 7.2 cluster-prone commands; reused verbatim for the `valkey-cluster-auth` deployment (`REDIS_DEPLOYMENT`-gated), with Redis-8.10-only cases self-skipping there
- `../test/redis_sentinel_deployment_spec.js` — Sentinel discovery/auth, pub/sub, blocking list, Lua, FCALL + read-only Lua, failover/reconnect, Redis 7.2 cluster-prone commands; reused verbatim for `valkey-sentinel-auth`
- `../test/redis_unix_socket_deployment_spec.js` — the `single-unix` deployment: `redis-config`'s connection-test endpoint and a `redis-command` round-trip over a Unix socket with TCP disabled
- `../test/memorydb_deployment_spec.js` — opt-in AWS MemoryDB cluster/auth (JSON and env-var optionsType), same-slot/cross-slot, Lua, read-only Lua + FCALL (gated on engine function support), and Redis 7.2 cluster-prone command coverage

Browser editor coverage:

- `../test/playwright/redis-editor.spec.js` — real Node-RED editor coverage for
  `redis-config`, Lua library save metadata, `redis-in` field visibility, and
  `redis-command` typedInput initialization
- `../test/playwright/helpers/node-red-editor.js` — Playwright Node-RED editor helpers

Helper:

- `../test/helpers/capability.js` — `isCommandSupported`/`isCallSyntaxSupported` self-skip checks for Redis-8.10-only test cases
- `../test/helpers/cleanup.js`
- `../test/helpers/cluster-prone.js`
- `../test/helpers/deployment.js`
- `../test/helpers/topology.js`
- `../test/helpers/wait.js`

Docker test deployments:

- `../scripts/ensure-docker-ubuntu.sh`
- `../scripts/deployment-runner.js` — shared Docker-deployment mechanics used by `npm test`
- `../scripts/run-deployment-tests.js`
- `../scripts/run-playwright-tests.js`
- `../test/deployments/`
- `../test/deployments/playwright-editor/`

Examples:

- `../examples/redis-list-queue.json`
- `../examples/redis-lua-script.json`
- `../examples/redis-fcall.json`
- `../examples/redis-script-function-management.json`
- `../examples/redis-priority-queue.json`
- `../examples/redis-psubscribe.json`
- `../examples/redis-pub-sub.json`
- `../examples/redis-set-and-get.json`
- `../examples/redis-streams.json`

User-facing docs:

- `../README.md` — public npm/GitHub readme; keep in sync when node types or fields change
- `../CHANGELOG.md` — released and unreleased user-visible changes; ships in the package

Agent docs:

- `../AGENTS.md` - canonical shared agent guide (`CLAUDE.md` imports it)
- `../.codex/skills/node-red-contrib-redis-maintainer/SKILL.md` - symlink to the shared maintainer skill text
- `../CLAUDE.md`
- `../.claude/skills/node-red-contrib-redis-maintainer/SKILL.md`

## Where to look by feature

### Config and connection options

Read:

- `../redis.html` `redis-config`
- `../redis.js` `RedisConfig`
- `ARCHITECTURE.md`

### Blocking inputs, pub/sub, streams

Read:

- `../redis.js` `RedisIn`
- `../redis.html` `redis-in`
- `../test/redis_in_spec.js`
- `../test/redis_status_spec.js`

### Write commands

Read:

- `../redis.js` `RedisOut`
- `../redis.html` `redis-out`
- `../test/redis_out_spec.js`

### Generic commands

Read:

- `../redis.js` `RedisCmd`
- `../redis.html` `redis-command`
- `../test/stream_commands_spec.js` for advanced command coverage

### Lua

`redis-lua-script` has two modes: Script (`EVAL`/`EVAL_RO`, stored `EVALSHA`/`EVALSHA_RO`
with `NOSCRIPT` recovery) and Function (`FUNCTION LOAD REPLACE` on ready + `FCALL`/`FCALL_RO`,
cluster-aware load on all masters, "function not found" reload-and-retry). Management
(`FUNCTION *`/`SCRIPT *`) stays in `redis-command`.

Read:

- `../redis.js` `RedisLua`
- `../redis.html` `redis-lua-script`
- `../test/redis_lua_ui_spec.js`
- `../test/scripting_commands_spec.js` for runtime read-only/function behavior
- `../test/playwright/redis-editor.spec.js` for real editor/library behavior
- `../test/redis_status_spec.js`

### Context injection

Read:

- `../redis.js` `RedisInstance`
- `../redis.html` `redis-instance`
- `NODE_GUIDE.md`

### Shutdown and status

Read:

- `../redis.js` `attachStatusListeners`, `gracefulQuit`, `disconnect`
- `../test/redis_status_spec.js`

## What each project doc covers

- `ARCHITECTURE.md` — runtime/editor design, connection ownership, shutdown model
- `NODE_GUIDE.md` — node-by-node behavior and extension guidance
- `CHANGE_WORKFLOW.md` — minimal-change rules and edit checklist
- `TESTING.md` — Docker-managed Redis deployment matrix, test layout, and regression strategy
- `TROUBLESHOOTING.md` — common local Redis, test, stream, Lua, and sandbox failures
- `superpowers/specs/` — retained design specs for major behavior changes

## Quick warnings

Do not start with refactoring.
Start with the exact node type and exact spec file.

Do not change public fields casually:

- node type names
- `defaults` property names
- message field names
- tested DOM ids

Do not change connection-id logic casually.
It is central to subscriber mode, blocking behavior, status, and shutdown.

## Connection-id quick reference

The single most breakable thing in this repo. Each node picks a connection id and
`getConn`/`disconnect` refcount it via `usedConn` — a connection only closes when its
refcount reaches 0.

| Node               | Connection id (`redis.js`) | Shared?             | Shutdown path                |
| ------------------ | -------------------------- | ------------------- | ---------------------------- |
| `redis-in`         | `n.id`                     | dedicated per node  | forced disconnect (blocking) |
| `redis-out`        | `n.server`                 | shared by config id | graceful quit                |
| `redis-command`    | `block ? n.id : n.server`  | conditional         | graceful quit                |
| `redis-lua-script` | `block ? n.id : n.server`  | conditional         | graceful quit                |
| `redis-instance`   | `n.id`                     | dedicated per node  | graceful quit                |

All three shared-connection keys use `n.server` — the config-node **id string** referenced by
the flow property — never the resolved config node's display `name`. Two historical bugs both
stemmed from confusing these: (1) `redis-lua-script` once keyed by `n.server.name` directly,
which is `undefined` (`n.server` is just the id string, not the resolved node), so every
non-blocking Lua node collapsed onto one pool key `undefined`; (2) all three shared paths then
keyed by `this.server.name` — the resolved config node's _display name_, which defaults to
`"Local"` and is user-editable — so two differently-configured config nodes that happened to
share a name (the common case, since `"Local"` is the default) silently shared one client
across different servers/databases. The fix keys by `n.server`, the config-node id, which is
unique and immutable regardless of display name (regression tests:
`test/redis_lua_conn_spec.js`, `test/redis_out_spec.js`, `test/redis_command_spec.js` — each
has a "shares the default name 'Local'" case). The `block ? n.id : n.server` split for
`redis-command`/`redis-lua-script` is proven server-side: `test/scripting_commands_spec.js` and
`test/redis_sentinel_deployment_spec.js` set an ioredis `connectionName` and count named
`CLIENT LIST` entries (non-block nodes pool onto one connection; each block node adds its own).
Always confirm intent with a human before changing any id key — it underpins subscriber mode,
blocking behavior, status, and shutdown.
