# Independent Review: Redis 8.8 Project Hardening

**Date:** 2026-07-19  
**Reviewed plan:** `docs/superpowers/plans/2026-07-12-redis-8-8-project-hardening.md`  
**Reviewed prior review:** `docs/superpowers/plans/2026-07-13-review-redis-8-8-project-hardening.md`  
**Implementation reviewed:** uncommitted working-tree changes on `claude-review` relative to
`HEAD` (`1d1bf99`)  
**Review status:** conditions 1–4, 6, and 7 resolved; 5, 8, and 9 partially outstanding.
See [Resolution record (2026-07-26)](#resolution-record-2026-07-26) at the end of this document
for what was verified and how.

## Executive verdict

The main runtime hardening fixes are real, narrow, and pass the repository's Docker-managed
standalone, Cluster, and Sentinel suites. The editor persistence change also passes the real
Playwright suite. The work should not yet be approved because one documented runtime capability
does not work with the editor's normal uppercase commands, the Redis 8.8 suggestions are not
actually current, stream help remains contradictory, required audit/format/package work is
incomplete, and new tests conflict with the repository's asynchronous test rules.

The prior review's statement that every material claim was verified is incorrect. In particular,
its HSET/MSET object-transform conclusion tested lowercase ioredis command lookup while the editor
stores and suggests uppercase command names.

## Human decisions

The maintainer made these decisions after review:

1. **Support object payloads for HSET/MSET.** Uppercase and lowercase saved command names must both
   receive ioredis's field/value object transformation.
2. **Support scalar static Params.** Strings, numbers, and booleans are valid one-argument static
   Params; arrays remain the multi-argument form. `null` should retain the historical meaning of
   no static arguments rather than becoming an empty-string Redis argument.
3. **Include package cleanup in this hardening project.** The prior plan's package-layout deferral
   is rejected. The published tarball must exclude tests, deployment infrastructure, agent files,
   hooks, internal plans, and process/session lock data.

## Findings

### 1. High: uppercase HSET/MSET object payloads do not work

The plan says non-empty objects are preserved for ioredis command-specific transforms, and the
new runtime help explicitly advertises HSET/MSET object-to-field/value mapping. That statement is
only true when the command name passed to ioredis is lowercase.

Facts:

- `redis-command` passes the saved command unchanged to `client.call` (`redis.js:875`).
- The editor's new default is uppercase `SET`, and every datalist suggestion is uppercase
  (`redis.html:1697`, `redis.html:1749`).
- ioredis 5.11.1 looks up an argument transformer by the exact `Command.name`
  (`node_modules/ioredis/built/Command.js:279`).
- Its HSET/MSET transformers are registered only as lowercase `hset`, `hmset`, `mset`, and
  `msetnx` (`node_modules/ioredis/built/Command.js:401-404`).
- The prior review used `client.call("hset", ...)` to approve the claim and did not test the
  uppercase value produced by the UI.

Reproduced through the real Node-RED node against the Docker-managed Redis 8.8 deployment:

```text
HSET uppercase error: ERR wrong number of arguments for 'hset' command
hset lowercase result: 1
```

This behavior predates the current hardening patch, so it is not a new runtime regression.
However, the implementation adds user-facing documentation saying it works and adds no HSET/MSET
object regression test. It is therefore a confirmed defect in the promised public contract.

Required outcome:

- Preserve the saved/editor command value for flow compatibility.
- Normalize the command used for ioredis dispatch so known transformers work regardless of saved
  case, or provide an equivalently small case-insensitive transform path.
- Add focused uppercase and lowercase HSET/MSET object tests through `redis-command`.
- Keep array argument behavior and arbitrary module commands working.

### 2. Medium: scalar static Params changed without a plan decision

The editor describes Params as a JSON array, but Node-RED's JSON TypedInput accepts any valid JSON.
Truthy scalar Params already worked before this patch. The rewrite also makes falsy scalar Params
effective, but this change was not included in the plan's old/new compatibility matrix.

With `msg.payload` absent or `null`:

| Saved Params   | Previous behavior       | Current working tree                            |
| -------------- | ----------------------- | ----------------------------------------------- |
| `["value"]`    | sends `"value"`         | unchanged                                       |
| `"value"`      | sends `"value"`         | unchanged                                       |
| `5`            | sends `5`               | unchanged                                       |
| `true`         | sends `true`            | unchanged                                       |
| `0`            | drops the value         | sends `0`                                       |
| `false`        | drops the value         | sends `false`                                   |
| `""`           | drops the value         | sends an empty string                           |
| `null`         | contributes no argument | ioredis converts it to an empty-string argument |
| malformed JSON | silently drops Params   | reports `done(err)`                             |

The maintainer has now chosen the contract: arrays expand into arguments; string, number, and
boolean Params contribute one argument; `null` contributes none. Malformed JSON must remain a
catchable error.

Required outcome:

- Add table-driven tests for static `0`, `false`, `""`, truthy scalars, `null`, arrays, and malformed
  JSON.
- Update editor help and `docs/NODE_GUIDE.md` to describe arrays as the normal multi-argument form
  and scalars as a supported one-argument form.
- Do not describe an explicit empty `msg.payload` as falling back to Params: `""`, `[]`, and `{}`
  are explicit under the selected message-payload contract.

### 3. Medium: the Redis 8.8 datalist is not current

The plan requires suggestions derived from the Redis 8.8 command catalog. The implementation has
397 suggestions. A comparison against `COMMAND LIST` from the same Docker-managed
`redis:8.8-alpine` deployment used by the tests produced:

```text
Redis command/subcommand rows: 646
Unique normalized command roots: 437
Datalist suggestions: 397
Missing from datalist: 48
Present only in datalist: 8
```

Some missing commands are deliberately omitted administrative or internal commands, which is
reasonable. Public Redis 8.8 commands still missing include:

- `BF.CARD`
- `FT.DROPINDEX`, `FT.HYBRID`, `FT.PROFILE`, `FT._LIST`
- `JSON.CLEAR`, `JSON.MERGE`, `JSON.MSET`, `JSON.NUMPOWBY`, `JSON.TOGGLE`
- `TS.DEL`, `TS.MREVRANGE`, `TS.REVRANGE`

Suggestions not registered by the target deployment include:

- `FT.ADDHASH`
- `FT.DEBUG`
- `FT.OPTIMIZE`
- `FT.SAFEADDHASH`
- `FT.SETPAYLOAD`
- `FT.SYNFORCEUPDATE`
- `JSON._CACHEINFO`
- `JSON._CACHEINIT`

The official Redis 8.8 catalog also lists the public missing commands:
<https://redis.io/docs/latest/commands/redis-8-8-commands/>.

The static UI test checks only selected prefixes and examples, so its title, "keeps the datalist
suggestions current," claims more than it proves (`test/redis_lua_ui_spec.js:292`). This is not a
runtime blocker because the editable input accepts arbitrary commands, and the Playwright
round-trip test for `MYMODULE.CALL` passes.

Required outcome:

- Regenerate suggestions from an authoritative Redis 8.8 source.
- Keep an explicit reviewed exclusion list for dangerous/internal commands.
- Test the complete derived set minus exclusions rather than a handful of spot checks.
- Continue accepting commands outside the datalist.

### 4. Medium: stream documentation and examples are not aligned

The final-colon XREADGROUP parser is correct and its runtime/editor validation is tested. The
documentation update is incomplete:

- XREADGROUP help correctly says a stream key may contain colons (`redis.html:1489-1492`).
- XADD help still says a stream key must not contain a colon when paired with XREADGROUP
  (`redis.html:1663-1664`).
- `examples/redis-streams.json` still uses `taskstream:>` and was not updated to demonstrate a
  namespaced stream key.
- README was not updated to mention the new namespaced-topic behavior.

This directly misses Task 3's help/example requirement and the acceptance criterion that runtime,
help, README, examples, and tests describe the same behavior.

Required outcome:

- Remove the stale XADD limitation.
- Use one namespaced key consistently in the stream example's XGROUP, XADD, and XREADGROUP nodes.
- Add a concise README note if this behavior is intended to be publicly discoverable there.

### 5. Medium: required formatting verification fails

`git diff --check` passes, but Prettier reports formatting issues in touched runtime, editor,
documentation, and test files. A commit hook that will rewrite the files later is not evidence that
the reviewed working tree already passes the plan's formatting verification.

Required outcome:

- Format only the files touched by this project, as the plan requires.
- Re-run Prettier in check mode and record a clean result before approval.
- Re-run focused and full tests after formatting, because formatting changes the actual artifact
  being approved.

### 6. Medium: the full audit result is not documented

`npm audit --omit=dev --json` passes with zero production vulnerabilities, satisfying the release
acceptance criterion. The full `npm audit --json` exits non-zero and reports nine development-tree
vulnerability entries:

- 1 low
- 1 moderate
- 7 high

They are rooted in the current Node-RED and Mocha development trees, including `jsonata`, `diff`,
and `serialize-javascript`. npm proposes invalid downgrades such as Node-RED 0.19.6 or Mocha
11.3.0; the plan correctly says not to apply such remediation blindly. However, Task 5 explicitly
requires documenting the remaining current-upstream findings, and no current document does so.

Required outcome:

- Record the exact audit date, advisory identifiers, affected development paths, why they are not
  production dependencies of this node package, and the upstream condition for removal.
- Keep the production audit result separate from the full development audit.
- Do not add broad severity allowlists or dependency downgrades.

### 7. Medium: the packed artifact publishes internal development state

`npm pack --dry-run --json` reports 90 files and 1,191,726 unpacked bytes. The tarball includes:

- all Mocha and Playwright tests
- Docker deployment configuration
- internal hardening plans/specifications
- Claude/Codex maintainer material
- Husky and lint-staged configuration
- `.claude/scheduled_tasks.lock`, including a live session id, pid, process start value, and
  acquisition timestamp

No private key or production credential was found. The problem is not merely package size: the
artifact exposes machine/session metadata and distributes internal development infrastructure that
the installed Node-RED node does not need.

The maintainer has placed cleanup in scope, overriding the plan's prior package-layout deferral.

Required outcome:

- Add a minimal npm `files` allowlist covering the runtime/editor entrypoints, icons, examples, and
  README-referenced public assets. npm includes `package.json`, README, and LICENSE automatically.
- Confirm tests, deployments, hooks, agent directories, internal plans, and lock files are absent.
- Pack the artifact, install that tarball into a clean real Node-RED 5.0.1 environment, and verify
  node registration plus a representative Redis flow.

### 8. Low: newly added tests violate repository async/test rules

The repository requires async/await with try/catch in tests and discourages fixed sleeps as proof of
completion. Added hardening tests contain 26 new Promise-chain or fixed-delay occurrences. Examples:

- `test/redis_command_spec.js:217-245`, `299-317`, `344-362`, `381-411`, `423-431`
- `test/redis_in_spec.js:442-466`, `480-486`
- `test/redis_out_spec.js:587-617`
- `test/redis_lua_conn_spec.js:168-193`
- `test/redis_8_8_data_types_spec.js:77-79`

The fixed 150-200 ms waits make the suite slower and prove only that an event was or was not
observed within that window. The Promise chains directly contradict the canonical agent guidance.

Required outcome:

- Convert newly added sequencing to async/await with try/finally cleanup.
- Wait on the node's observable input/error completion rather than arbitrary delays.
- Preserve the existing helper framework; do not introduce a new abstraction or dependency.

### 9. Low: regression-test comments describe fixed behavior as current

Several new comments were written before the implementation and not updated afterward. They say
the current implementation pools by display name even though `redis.js` now pools by config id:

- `test/redis_command_spec.js:180-197`
- `test/redis_out_spec.js:556-561`
- `test/redis_lua_conn_spec.js:9-13`

Required outcome: describe these as historical regressions and state the invariant the test now
protects.

## Confirmed sound changes

These changes are supported by source inspection and passing integration evidence:

### Shared connection identity

- Baseline `redis-out`, non-blocking `redis-command`, and non-blocking `redis-lua-script` used the
  editable config display name as their shared pool key.
- The working tree captures `n.server`, the unique config-node id, and uses the same id for acquire
  and release.
- Dedicated ids for `redis-in` and blocking command/Lua nodes remain unchanged.
- Same-name, reference-count, status, blocking-isolation, Cluster, Sentinel, and shutdown paths pass.

### Missing or invalid config handling

- `getConn` now throws a clear error instead of returning `undefined`.
- Callers no longer attach status listeners to an undefined client.
- Constructor tests for dangling config references and unusable options pass.

The implementation logs the invalid-options problem at the config node and again through the
constructor failure. This is noisy but was not observed to break behavior.

### Namespaced XREADGROUP topics

- Baseline destructuring of `topic.split(":")` selected the first colon and broke namespaced keys.
- The working tree splits at the final colon and rejects missing stream/id parts.
- Redis stream IDs do not use colons, so the separator is unambiguous.
- Runtime and editor tests pass.

### Explicit message scalar arguments

- Baseline truthiness checks dropped `0`, `false`, and `""` and ignored truthy numbers/booleans.
- The new `!== undefined && !== null` rule sends those values as Redis arguments.
- `undefined`, `null`, and absent message payloads still select static Params.
- `[]` and `{}` continue to suppress Params and contribute zero additional arguments.
- Redis errors and malformed Params reach the Node-RED error path.

### Generic command editor

- The closed select is replaced by a native editable input and datalist without changing the saved
  `command` property or `node-input-command` id.
- Arbitrary commands save and reopen in the real Node-RED editor.
- Existing lowercase saved commands remain accepted.

### Representative Redis 8.8 data-type coverage

- Existing specs cover strings, bitmaps/bitfields, geospatial indexes, hashes, lists, HyperLogLog,
  sets, sorted sets, streams, and scripting.
- The new standalone-only spec covers Arrays, Vector Sets, INCREX, XNACK, JSON, Bloom, Cuckoo,
  Count-Min Sketch, Top-K, t-digest, and Time Series through the generic command path.
- Capability checks allow unsupported commands to self-skip during local runs.
- Redis 7.2 Cluster/Sentinel stages do not run the Redis 8.8-only family spec.

The represented family list agrees with the official Redis data-type catalog:
<https://redis.io/docs/latest/develop/data-types/>.

### Dependency refresh

- `npm outdated --json` returns `{}` for the installed direct dependency set.
- Node-RED 5.0.1, Playwright 1.61.1, Prettier 3.9.5, and lint-staged 17.1.0 are installed.
- ioredis remains 5.11.1 and Mocha remains 11.7.6.
- The production dependency audit is clean.

## Verification record

### Passed

- `node --version` -> `v26.4.0`. This is newer than the project's Node.js 24 working target; it
  confirms modern-runtime execution but is not exact Node.js 24 compatibility evidence.
- `git diff --check` -> clean.
- `npm test`:
  - standalone unauthenticated: 309 passing, 1 expected pending auth case
  - standalone authenticated: 310 passing
  - Redis 7.2 Cluster authenticated: 8 passing
  - Redis 7.2 Sentinel authenticated: 6 passing
- `npm run test:playwright` -> 8 passing, 1 MemoryDB case skipped.
- `npm audit --omit=dev --json` -> 0 production vulnerabilities.
- `npm outdated --json` -> `{}`.
- `npm pack --dry-run --json` completed and exposed the package-layout finding above.

### Failed

- Full `npm audit --json` -> non-zero, 9 development vulnerability entries.
- Prettier check on touched files -> formatting issues.
- Uppercase HSET with an object payload -> Redis wrong-number-of-arguments error.

### Not run

- AWS MemoryDB runtime tests: `MEMORYDB_ENABLED` and credentials were unavailable.
- Exact Node.js 24 run: the verification host used Node.js 26.4.0.
- Clean installation of the packed tarball into a separate Node-RED 5.0.1 runtime.
- Visual screenshot inspection of the changed command editor at standard and enlarged tray widths.
- Hosted CI, npm registry publication, provenance, or installed published artifact checks.

### Not provable from the current artifacts

The working tree contains all hardening implementation and test changes together without commits.
The final tests pass, but the review cannot verify that each regression test was run and observed to
fail before its corresponding implementation, as required by the plan.

## Approval conditions

Before approval:

1. Implement and test case-insensitive HSET/MSET object support.
2. Implement and document the approved scalar static Params contract, including `null`.
3. Correct and fully verify the Redis 8.8 suggestion set.
4. Align stream runtime, editor help, README, and example flow.
5. Replace new Promise chains/fixed waits and correct stale test comments.
6. Format touched files and rerun focused plus full tests.
7. Document the full development audit without unsafe downgrades.
8. Add the npm package allowlist, inspect the new tarball, and test that tarball in clean Node-RED.
9. Report MemoryDB and exact Node.js 24 verification as either passed or explicitly outstanding.

No architecture split, new dependency, or broad connection-lifecycle refactor is needed to satisfy
these conditions.

## Resolution record (2026-07-26)

Each condition was re-checked against the working tree rather than against the commit messages.
The evidence column names what was inspected so the next reader can repeat the check.

| #   | Condition                             | Status      | Evidence                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Case-insensitive HSET/MSET objects    | Resolved    | `dispatchCommandName` + `ARGUMENT_TRANSFORM_COMMANDS` in `redis.js`; uppercase and lowercase cases in `test/redis_command_spec.js`; documented in `redis.html` and `docs/NODE_GUIDE.md`                                                                                                                                          |
| 2   | Scalar static `Params` incl. `null`   | Resolved    | Explicit-payload logic in `RedisCmd`; `scalarCases` and `scalarParamsCases` in `test/redis_command_spec.js`; contract documented in the `redis-command` help                                                                                                                                                                     |
| 3   | Redis 8.8 suggestion set verified     | Resolved    | `test/redis_8_8_data_types_spec.js` → "redis-command datalist vs. live COMMAND LIST" cross-checks the editor datalist against a live deployment                                                                                                                                                                                  |
| 4   | Stream runtime/help/README/example    | Resolved    | Last-colon topic split in `redis.js`, documented in `redis.html` and `README.md`; `examples/redis-streams.json` present                                                                                                                                                                                                          |
| 5   | Promise chains, fixed waits, comments | **Partial** | Stale test comments corrected. Promise chains are **not** replaced: 60 `.then()` occurrences remain across 20 spec files, plus fixed `setTimeout` waits in `redis_out_spec.js` and `redis_in_spec.js`. `redis.js` itself is clean. Needs a decision — see below                                                                  |
| 6   | Formatting                            | Resolved    | `npx prettier --check .` passes repo-wide as of this change (25 previously drifted files reformatted; example flows verified whitespace-only by parsing before and after)                                                                                                                                                        |
| 7   | Full audit documented, no downgrades  | Resolved    | `docs/TESTING.md` "Dependency audit" refreshed to the current result and restructured around the invariant rather than a fixed count, so it degrades to "dated observation" instead of "wrong"                                                                                                                                   |
| 8   | Package allowlist and tarball         | **Partial** | `files` allowlist present; `npm pack --dry-run` verified as 18 files (`redis.js`, `redis.html`, `icons/`, `examples/`, README assets, `CHANGELOG.md`, `LICENSE`, `README.md`, `package.json`) with no tests, deployment infrastructure, or agent docs. Installing that tarball into a clean Node-RED is **not** recorded as done |
| 9   | MemoryDB and Node.js 24 verification  | **Partial** | Node.js verified: `v24.5.0`, full Docker matrix green. MemoryDB is opt-in via `MEMORYDB_*` and is **outstanding** — not exercised in this environment                                                                                                                                                                            |

### Condition 5 — outstanding decision

Rewriting 60 `.then()` chains across 20 spec files is a purely mechanical diff with no behavior
change and real review cost. The alternative is to narrow the repository rule so the
`async`/`await` requirement is binding on runtime code and on newly added tests, and convert
existing specs opportunistically when they are edited for another reason. Either resolves the
condition; the choice belongs to a human. Until then this condition stays open.

Note that tests added after this record — the subscribe-failure, NOGROUP, `gracefulQuit`
fallback, anchored-`NOSCRIPT`, and load-coalescing cases — are written with `async`/`await`, so
the gap is confined to pre-existing specs.

### Not covered by this record

The credential leak documented under **Security / Known issue** in `CHANGELOG.md` (a password
inside a `redis://user:pass@host` URL is not redacted in the connection-test error path) was
identified during review and deliberately deferred. It is not one of the nine conditions above.
