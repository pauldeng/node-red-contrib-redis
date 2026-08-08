# Node Guide

This guide explains the branch-specific behavior of each node type and where to extend it safely.

## `redis-config`

Purpose:

- store Redis options
- select cluster mode

Key implementation points:

- editor uses typedInput for `options`
- runtime evaluates `options` using `optionsType`
- env-string values are verified, then parsed as JSON when possible
- cluster mode constructs `new Redis.Cluster(options)`
- parsed option arrays are treated as Redis Cluster startup-node lists even if the
  saved UI mode flag is stale from a previous JSON single-node configuration
- cluster startup-node `username`/`password` values are also passed as ioredis
  `redisOptions` so discovered cluster nodes authenticate correctly
- `dnsLookupStrategy: "identity"` on a cluster startup node enables identity DNS lookup
  and TLS for AWS MemoryDB/ElastiCache-style configuration endpoints
- the editor Test connection button posts the current form values to a runtime admin
  endpoint, creates a temporary client, connects, runs `PING`, expects `PONG`, and
  disconnects with `QUIT` without adding the client to the shared connection pool
- saved environment-variable connection configs reopen on the ConnString tab with the
  variable name selected; saved JSON configs reopen on the Connection tab
- while environment-variable connection options are selected, the Connection tab is
  read-only and becomes editable again when JSON is selected

Safe changes:

- clearer help text
- stricter validation
- better examples for JSON/env input

Be careful with:

- `optionsType`
- env parsing
- cluster option shape
- never commit cloud Redis endpoints or credentials in tests, examples, or docs

Secret storage:

- in JSON mode, passwords are extracted into a `text`-type `secrets` credential (encrypted,
  out of `flows.json`) and merged back into `options` at runtime (`mergeSecrets`) and on editor
  load; `extractSecrets` (editor-only) strips them on save. The `mergeSecrets` copies in
  `redis.js` and `redis.html` must stay in sync
- a legacy password still embedded in `options` keeps working (merge is a no-op without a
  credential) and migrates to the credential when the config is reopened and saved
- `env` mode is untouched — the secret stays in the environment

## `redis-in`

Purpose:

- receive values from Redis or blocking Redis commands

Current command families:

- list blocking pops
- sorted-set blocking pops
- `subscribe`
- `psubscribe`
- `xreadgroup`

Message patterns:

- pub/sub emits `topic` and `payload`
- pattern subscriptions also emit `pattern`
- blocking pops emit Redis key as `topic`
- `xreadgroup` emits `stream`, `messageId`, and `payload`
- `xreadgroup` Topic is `<stream-key>:<id>`, split at the _final_ colon (stream IDs can
  never contain one), so the stream key itself may contain colons; a Topic with no colon,
  an empty stream key, or an empty id is a configuration error (`node.error`, red status)

Payload handling:

- when `obj` is true, JSON or field-object parsing is attempted
- when parsing fails, raw values are forwarded
- `xreadgroup` returns an object map when `obj` is true, otherwise a flat field/value array

Recovery:

- blocking loops (blpop/brpop/bzpop/xreadgroup) retry every error with capped backoff
  (250ms→5s, jitter) and keep running; only node close stops them
- retries log via `node.warn` and show a yellow `retrying` status; a persistent failure
  (e.g. WRONGTYPE) stays visible instead of stopping silently
- pub/sub is unaffected — ioredis re-subscribes automatically after reconnect
- the very first `subscribe`/`psubscribe` waits for the client's `ready` event before
  issuing the command (immediately if already `ready`); this keeps behavior identical
  whether or not the config sets ioredis's `enableOfflineQueue: false`, which otherwise
  rejects a command sent before `ready` instead of queuing it. A `lazyConnect` client is
  started explicitly before that wait. Every reconnect after this first one is still
  covered by ioredis's own re-subscription.

Shutdown rules:

- always remove listeners
- always clear status
- force disconnect for blocking shutdown
- cancel any pending retry backoff on close

Read before editing:

- `../test/redis_in_spec.js`
- `../test/redis_status_spec.js`

## `redis-out`

Purpose:

- write focused values to Redis

Branch-specific payload shaping:

- `xadd`
  - object payload becomes flattened field/value pairs
  - array payload is passed through
  - primitive payload is wrapped as `["value", String(payload)]`
- `zadd`
  - object payload expects `{ score, member }`
  - array payload supports flat `[score, member, ...]`
  - object members are JSON-stringified when `obj` is true
- list push operations accept plain or JSON-stringified payloads depending on `obj`

Error handling:

- the write is awaited; `done()` resolves only after Redis acknowledges it
- a failed write calls `done(err)`, so the message reaches a `catch` node and is marked errored
- no write is fire-and-forget, so a failure cannot become an unhandled promise rejection

Read before editing:

- `../test/redis_out_spec.js`

## `redis-command`

Purpose:

- run generic Redis commands and return the result in `msg.payload`

Behavior:

- `msg.topic` overrides the configured topic/key
- `msg.payload` overrides static params when provided
- static params come from JSON typedInput
- `block` forces a dedicated connection id
- non-blocking (shared) connections are pooled by the config node's **id** (`n.server`),
  never its display name — two config nodes with the same name (the default is `"Local"`)
  point at independent clients

`msg.payload` explicit-argument rules — `msg.payload` is treated as explicit only when
`!== undefined && !== null`:

| `msg.payload`                        | Historical behavior                                                                                               | Current behavior                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `0`, `false`, `""`                   | dropped (`if (msg.payload)` truthiness bug); fell back to static Params or a bare/topic-only call                 | sent as the literal argument                                                                  |
| a truthy number (e.g. `5`) or `true` | silently ignored (the dispatch `switch` had no `number`/`boolean` case); also fell back to a bare/topic-only call | sent as the literal argument                                                                  |
| non-empty array                      | spread as arguments                                                                                               | unchanged                                                                                     |
| non-empty plain object               | passed as one argument so ioredis's per-command transforms apply (e.g. `HSET`/`MSET` field-value mapping)         | unchanged                                                                                     |
| empty array `[]`                     | truthy but failed the `length > 0` check, so it silently suppressed Params and contributed zero extra arguments   | unchanged — still an explicit zero-argument payload                                           |
| empty object `{}`                    | same as `[]`: suppressed Params, zero extra arguments                                                             | unchanged — still an explicit zero-argument payload; never stringified to `"[object Object]"` |
| `undefined`, `null`, or absent       | falls back to configured static Params                                                                            | unchanged                                                                                     |

Malformed static Params (invalid JSON) now report `done(err)`/`node.error` instead of
silently degrading to a bare/topic-only call.

Static Params contract (used only when `msg.payload` is absent, `undefined`, or `null`):
Params is JSON, evaluated with `JSON.parse`, and the parsed value decides the argument
shape — a saved array expands into multiple arguments (the normal multi-argument form); a
saved string, number, or boolean is a single argument, including falsy `0`, `false`, and
`""`; a saved `null` contributes no static argument at all (ioredis would otherwise
stringify a raw `null` into a literal empty-string argument on the wire — `null` keeps its
historical meaning of "nothing configured" instead).

The object-field/value argument transform for **HSET**/**MSET**/**HMSET**/**MSETNX**, and the
legacy flat-array reply shape for **HRANDFIELD** `WITHVALUES`, **VSIM** `WITHSCORES`,
**XREAD**, **XREADGROUP**, and the ten ioredis "sorted-set pair" commands (`ZDIFF`, `ZINTER`,
`ZPOPMAX`, `ZPOPMIN`, `ZUNION`, `ZRANDMEMBER`, `ZRANGE`, `ZRANGEBYSCORE`, `ZREVRANGE`,
`ZREVRANGEBYSCORE`), all apply regardless of the saved command's case — ioredis only
registers these argument/reply transforms under the exact lowercase spelling, so this node
normalizes dispatch for those eighteen command names only (`CASE_SENSITIVE_TRANSFORM_COMMANDS`
in `redis.js`); every other command (including **HGETALL**, whose case-sensitive reply
transformer this node deliberately bypasses, returning a flat array instead of an object) is
sent with whatever case was saved.

The **Command** field is a free-text input backed by a `<datalist>` of suggestions derived
from the Redis 8.8 command catalog (retired RedisAI/RedisGraph/RedisGears entries removed;
administrative, replication, connection-lifecycle, and destructive commands such as
`FLUSHALL`, `SHUTDOWN`, `QUIT`, and `FT.DROPINDEX` are deliberately not suggested — see the
`DATALIST_EXCLUSIONS` list in `../test/redis_8_8_data_types_spec.js` for the exact,
reasoned set, mostly identified by the server's own `@admin`/`@dangerous` ACL categories).
It still accepts any command name, suggested or not — including new Redis 8.8 commands
(`INCREX`, `XNACK`, the Array family `AR*`, Vector Sets `V*`) and bundled-module commands
(`JSON.*`, `BF.*`, `CF.*`, `CMS.*`, `TOPK.*`, `TDIGEST.*`, `TS.*`) — via the same generic
`client.call(command, ...)` dispatch. `redis_8_8_data_types_spec.js` also runs a
full-coverage check against a live Redis 8.8's `COMMAND LIST` (every supported command is
either suggested or in the exclusion list, and nothing suggested is unsupported); a cheap
no-Redis spot check of representative entries lives in `redis_lua_ui_spec.js`.

Use this node for:

- commands not modeled by `redis-out`
- Redis modules and advanced commands
- stream command coverage already exercised in tests
- `FUNCTION` and `SCRIPT` management subcommands (LOAD, LIST, FLUSH, EXISTS, KILL, …);
  the `redis-lua-script` node only executes

Read before editing:

- `../test/redis_command_spec.js`
- `../test/redis_8_8_data_types_spec.js`
- `../test/stream_commands_spec.js`
- `../test/redis_status_spec.js`

## `redis-lua-script`

Purpose:

- execute Lua scripts against Redis

Behavior (command resolved from `mode` + `stored` + `readonly`):

| mode     | stored | readonly | on ready                | on input     | recovery                                   |
| -------- | ------ | -------- | ----------------------- | ------------ | ------------------------------------------ |
| script   | no     | no       | —                       | `EVAL`       | —                                          |
| script   | no     | yes      | —                       | `EVAL_RO`    | —                                          |
| script   | yes    | no       | `SCRIPT LOAD`           | `EVALSHA`    | `NOSCRIPT` → `EVAL`                        |
| script   | yes    | yes      | `SCRIPT LOAD`           | `EVALSHA_RO` | `NOSCRIPT` → `EVAL_RO`                     |
| function | n/a    | no       | `FUNCTION LOAD REPLACE` | `FCALL`      | "function not found" → reload → retry once |
| function | n/a    | yes      | `FUNCTION LOAD REPLACE` | `FCALL_RO`   | "function not found" → reload → retry once |

- Function mode treats the editor as a Redis Functions library source (`#!lua name=…`);
  the node `FUNCTION LOAD REPLACE`s it on every connection `ready`, on all masters in
  cluster mode, so an `FCALL` routed to any shard can resolve. An empty library source in
  Function mode is a configuration error.
- This node is execution-only. `FUNCTION *` and `SCRIPT *` management subcommands stay in
  `redis-command`.

Input expectations:

- if `keyval > 0`, `msg.payload` must be an array
- if `keyval` is 0: omit `payload` (or pass `null` / `[]`) for zero `ARGV`; an array
  expands into `ARGV` entries; a scalar or `Buffer` is one `ARGV`; a plain object is
  rejected (`Payload is not Array`) instead of being coerced to `"[object Object]"`
- result is always returned in `msg.payload`

Critical editor behaviors:

- library type must remain `lua`
- extension must remain `.lua`
- checkbox metadata for `stored` and `block` must use explicit get/set handling
- `mode` uses get/set so Open Library re-applies field visibility; `fname` is mandatory in
  Function mode (editor `validate` + runtime fail-fast)
- switching a pristine node (untouched starter content) to Function mode seeds a working
  `#!lua name=…` + `redis.register_function` template and pre-fills the function name;
  user-edited code is never replaced

Read before editing:

- `../test/redis_lua_ui_spec.js`
- `../test/redis_status_spec.js`

## `redis-instance`

Purpose:

- place a live Redis client into Node-RED context

Behavior:

- stores the client under `flow` or `global` context based on configuration
  (the editor offers only these two; the runtime does `this.context()[node.location]`,
  and there is no `node` accessor on `this.context()`)
- clears the stored reference on close
- shares most lifecycle expectations with other nodes

Use cases:

- advanced Function-node logic
- custom Redis calls not modeled by built-in nodes

Be careful with:

- context location names
- topic/key used as the context key
- close cleanup

## Editor guidance

Node icon (`icons/redis-logo.png`):

- the workspace renders **SVG icons at the full 30px box** but scales raster icons to
  ≤20px and centers them — so the icon must stay a high-resolution PNG (512px) to match
  the palette's look; the vector source lives at `docs/assets/redis-logo.svg`
- never place a same-named `.svg` next to the `.png` in `icons/` — Node-RED serves the
  SVG in preference, silently reintroducing the oversized workspace icon

When adding fields in `redis.html`:

- use stable `defaults` names
- add validation in the editor when possible
- keep runtime fallback validation too
- update help text for new fields
- verify typedInput wiring and hidden type fields

## Example flows

Use existing example flows as the first source of user-facing patterns:

- list queue
- priority queue
- pub/sub
- pattern subscription
- set/get
- Lua script
- Redis Functions (`FCALL`)
- `FUNCTION`/`SCRIPT` management via `redis-command`
- streams

If a new feature is hard to discover, add or update one example flow.
