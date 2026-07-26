# Validation of `REVIEW_2026-07-26.md`

**Date:** 2026-07-26
**Validates:** `docs/REVIEW_2026-07-26.md`
**Branch:** `claude-review` (clean at `e748c31`)
**Code changed by this validation:** none. Findings and a prioritized fix list only.

## How this was verified

Independent re-verification, not a re-read of the original report:

- Every bug was reproduced against a live Redis 8.8 using throwaway specs written outside the
  repository and deleted afterwards. Observed output is quoted inline.
- Line coverage was measured with a separate `NODE_V8_COVERAGE` run and an independent range
  reducer, then cross-checked against every line number the report cites.
- `npm test` (full Docker matrix) and `npm run test:playwright` were run to completion.
- Dependency currency was checked against the live npm registry; `npm audit`, `prettier --check`,
  and the `.then()` counts were re-run rather than trusted.

## Verdict

The report is substantially accurate and unusually well-verified. All five bugs reproduce, every
line number and version spot-checked was correct, the coverage figure lands within 0.3% of an
independent measurement, and the test counts matched exactly.

The defects are: one materially overstated impact (P1), one false attribution (C1), several
arithmetic and itemization slips in the best-practices section, four missed findings (one
security-relevant), and a decisions section that manufactures eight decision gates for what is
really about six small fixes.

## Metrics re-verified

| Metric                             | Report                          | Independently measured                                                        |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `single-noauth`                    | 322 passing, 1 pending          | 322 passing, 1 pending — exact                                                |
| `single-auth`                      | 323 passing                     | 323 passing — exact                                                           |
| `cluster-auth`                     | 8 passing                       | 8 passing — exact                                                             |
| `sentinel-auth`                    | 6 passing                       | 6 passing — exact                                                             |
| `npm test` exit code               | 0                               | 0                                                                             |
| `npm run test:playwright`          | 9 passed                        | 8 passed, 1 skipped without MemoryDB credentials                              |
| `redis.js` line coverage           | 88.7% (100/885 uncovered)       | 88.4% (93/804 uncovered) — same conclusion, different line-counting heuristic |
| `npm audit --omit=dev`             | 0 vulnerabilities               | 0 vulnerabilities                                                             |
| Full `npm audit`                   | 17 (3 low, 4 moderate, 10 high) | identical, and all seven newly named packages present                         |
| Dependency currency table (8 rows) | —                               | all 8 rows correct against the registry                                       |

Every uncovered line number the report cites appears in the independently measured uncovered set.

## Claims confirmed

Reproduced with live probes:

| Claim                             | Verdict                      | Evidence                                                                                                                                                                           |
| --------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 subscribe error swallowed      | Valid                        | `node.error = []`, `node.warn = []`, status `green/connected` under an ACL user lacking `subscribe`                                                                                |
| B2 `SCRIPT LOAD` failure unlogged | Valid                        | 0 `node.error` calls; the claimed asymmetry confirmed — Function mode does log the compile error                                                                                   |
| B3 phantom empty `ARGV`           | Valid                        | `#ARGV` = 1 with an absent payload, expected 0                                                                                                                                     |
| B4 object → `"[object Object]"`   | Valid                        | `[1,"[object Object]"]`, matching the report exactly                                                                                                                               |
| B5 stale `retrying` status        | Valid, stronger than claimed | Full recovery cycle reproduced (NOGROUP → `XGROUP CREATE` → message delivered) with the status still yellow; also reproduced on the `blpop` branch, which the report only inferred |
| S1 unthrottled error logging      | Valid, quantified            | 14 `node.error` calls in 5 seconds against an unreachable host, unbounded                                                                                                          |
| S2 refcount re-arm gap            | Valid as written             | Independently traced; also unreachable                                                                                                                                             |

Verified by inspection: U1, U2, D1, D2, D3, D4, C1's core fact that `extractSecrets` is dead, C2's
per-file breakdown, C3's total of 25 files, C4, C5.

## Claims wrong or overstated

**P1's impact is wrong.** The report states that in cluster mode "every message whose key routes to
a shard other than the one that received the `SCRIPT LOAD` pays a `NOSCRIPT` round-trip plus a full
script-body resend." The `EVAL` fallback caches the script on the shard that executes it, so the
cost is one extra round-trip **per shard per script lifetime**, not per message — at most N extra
round-trips ever, until a `SCRIPT FLUSH` or restart. The asymmetry against `loadLibraryOn` is real;
the throughput framing is not.

**C1 attributes the sync instruction to a file that does not contain it.** `CLAUDE.md` never
mentions `extractSecrets` or `mergeSecrets`. The instruction lives in `docs/ARCHITECTURE.md:118`,
`docs/NODE_GUIDE.md:48-49`, and the two source comments. "byte-for-byte" is the report's own
phrasing, not any document's.

**C2's total is 60, not 58.** The per-file breakdown is exactly right and sums to 60.

**C3's itemization is wrong and self-inconsistent**, though the total of 25 is correct. Eight of
nine examples fail (`redis-streams.json` passes, so "all 9 examples" is false), and the failing
test-tree files are 6 specs plus 2 helpers — not "8 test specs" plus the two helpers named
separately, which would total 28. C3 also says "all 8 `docs/superpowers` files" while D3 correctly
says ten exist; eight fail.

**"The three dev packages are patch-level behind" is imprecise.** `lint-staged` 17.1.0→17.2.0 and
`playwright` 1.61.1→1.62.0 are minor bumps. More usefully, `package.json` already uses `^` ranges
permitting all three, so D-8 is a `package-lock.json` refresh, not a manifest edit.

**"666 runtime assertions across five topologies" is inflated.** That is 322+323+8+6+7 summed, which
double-counts: `single-noauth` and `single-auth` run the identical spec list. Distinct cases are
roughly 344, and they are test cases, not assertions.

**B1's trigger list is padded.** The severity is fair — any least-privilege ACL user granted
`+@read +@write` lacks `@pubsub` and so cannot subscribe, which is ordinary on managed Redis. But
Redis accepts effectively any string as a channel name, so "an invalid channel" is not a real
failure mode, and "a subscriber-mode restriction" cannot apply on a dedicated subscriber
connection. One real trigger, stated three ways.

Minor line-number slips where the substance is fine: `loadLibrary` is defined at 969 (985 is its
`node.error` line); the blocking branch's `attempt = 0` is 677, not 676; the `Params` `JSON.parse`
is 875, not 876.

## Findings the report missed

**Redis URL credentials are not redacted and reach the log.** `redactValue` returns strings
unchanged, so when options resolve to a connection string the password survives. With
`optionsType: env` set to `redis://appuser:sup3rs3cret@127.0.0.1:6398`, the failing
`/redis-config/test` response contained the full URL in its `options` field, and
`logConnectionTestError` wrote the same string into the Node-RED error log. Object options redact
correctly (`"password":"[redacted]"`), making this the same class of asymmetry the report catches in
B2. URL-from-env is a supported and tested configuration (`redis_status_spec.js` covers it), and
leaking the password into logs contradicts the intent stated at `docs/ARCHITECTURE.md:116-118`. The
report's coverage section touches redaction but only to note it is unasserted.

**The suite silently depends on port 6399 being closed.** `test/helpers/deployment.js:32` hardcodes
`127.0.0.1:6399` as the "unreachable" host. With something else listening there, `npm test` failed
with 6 failures — every "shows red/error status when Redis is unreachable" case, plus the
verbose-error endpoint test receiving HTTP 200 instead of 500. `scripts/run-deployment-tests.js`
pre-flights 6379 with `waitForRedis` but never verifies the bad port is refused. Re-running with
`REDIS_BAD_PORT=6398` reproduced the report's numbers exactly. Worth fixing because the suite gives
a confidently wrong answer rather than a clear error.

**Two minor items, listed for completeness rather than action.** `redis-out` `xadd` silently coerces
a nested object field value to `"[object Object]"` (observed: `["flat","ok","nested","[object
Object]"]`) — the same class as B4 with less reach and no correct alternative, since stream fields
are strings. And `test/hash_commands_spec.js:192` is titled "should HGETALL return all fields and
values as an object" while asserting a flat Array; the flat-array behavior is correct and documented
at `docs/NODE_GUIDE.md:176-178`, so only the title is wrong.

Checked and **not** a bug, since it bounds B1's scope: ioredis auto-resubscribes after a dropped
connection (verified with a server-side `CLIENT KILL TYPE pubsub`; messages resumed). The one-shot
`subscribe` call is safe across reconnects, so B1 is limited to subscribe-time failures.

## Triage

### Drop

- **P2** (re-parsing `Params` per message) is not a performance issue. `JSON.parse` on a short
  config string costs about a microsecond, on a path that only runs when `msg.payload` is absent,
  immediately before a Redis round-trip costing hundreds of microseconds to milliseconds. Moving it
  to the constructor also requires stashing and replaying the error to preserve the `done(err)`
  contract — behavior risk for an unmeasurable gain.
- **S2** is disqualified by its own text ("could not reach it… not because it is a live bug"). A
  guard for an unreachable state cannot be justified by a test, and this repo is test-first. A code
  comment at most.
- **C4** states outright that `CLAUDE.md` documents the behavior as deliberate. A finding whose
  conclusion is "nothing to do".
- **P1**, once the impact claim is corrected, leaves nothing to act on: self-healing, already
  covered by the cluster spec, and a fix adds fan-out and partial-failure semantics for no
  measurable gain.
- **C5**'s dead links resolve for anyone reading on npm or GitHub; the defect is visible only when
  browsing `node_modules` by hand.

### Downgrade

| Claim                     | Report says               | Closer to                                                                                                                        |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| B2 `SCRIPT LOAD` unlogged | medium                    | low — the node already shows red "script not loaded" and the compile error surfaces on the first message via the `EVAL` fallback |
| B3 phantom `ARGV`         | medium                    | low-medium — only bites scripts branching on `#ARGV == 0`; a script ignoring `ARGV` is unaffected                                |
| B4 `"[object Object]"`    | medium, blocking decision | low, and not a decision                                                                                                          |
| C2 60 `.then()` chains    | finding plus decision D-4 | one line; the finding's own conclusion is "do not change the code"                                                               |
| Coverage 88.7%            | headline metric           | vanity number; the specific untested branches are the content                                                                    |

B4 is the clearest over-processing: the report escalates it to a blocking decision, then supplies
the reasoning that settles it — a flow receiving `"[object Object]"` in `ARGV[1]` is already broken,
so nothing can depend on it. Reject it exactly like the existing `keyval > 0` guard.

## Fix list

Ordered by value. The first five are actual defects.

### 1. Redis URL credentials leak into the log — `redis.js:96` (`redactValue`)

Add URL-userinfo scrubbing so string options are handled like object options already are. The only
finding that persists a secret outside the encrypted credential, which is the purpose of the
`secrets` feature.

### 2. SUBSCRIBE/PSUBSCRIBE failures silently swallowed — `redis.js:576`, `redis.js:595`

```js
client[node.command](node.topic, (err, count) => {});
```

Convert both to `await` inside `try`/`catch`, report through `node.error`, and set a red status.
Reachable on any managed Redis using least-privilege ACLs; today the node stays green forever while
receiving nothing. Also removes the last two callback-style ioredis calls, which `CLAUDE.md` bans.

### 3. Blocking-input status never clears after recovery — `redis.js:627`, `redis.js:677`

Both loops reset `attempt = 0` on a successful iteration but leave the yellow `retrying` status. Add
a status reset alongside the existing `attempt = 0`. Reproduced on both branches.

### 4. Lua argument shaping when Keys is 0 — `redis.js:1044`

```js
const argsWith = (head) => [head, node.keyval].concat(msg.payload);
```

Guard once in `argsWith` so it covers `eval`, `evalsha`, and `fcall` together. Treat `null` the same
as absent — both reproduce. Reject non-array objects the way `keyval > 0` already does at line 1038.

### 5. `SCRIPT LOAD` failure never reaches the log — `redis.js:994`

Add `node.error(err)` in the catch, matching `loadLibrary` at line 985.

### 6. The suite assumes port 6399 is closed — `test/helpers/deployment.js:32`, `scripts/run-deployment-tests.js`

Add a pre-flight check next to the existing `waitForRedis` that fails loudly if the bad port accepts
a connection, or select the port dynamically.

### 7. Stale audit record — `docs/TESTING.md:202-225`

Update the counts to 17 (3 low, 4 moderate, 10 high) and add `axios`, `brace-expansion`, `fast-uri`,
`tar`, `npm`, `node-red-admin`, `body-parser`. The reasoning about why the suggested fixes are
downgrades remains correct.

### 8. `wait.js` missing from both helper lists — `docs/TESTING.md:152-157`, `docs/REFERENCE_MAP.md:77-82`

Required by four specs and listed nowhere. `docs/TESTING.md:190` requires keeping these current.

### 9. Document the keyless-payload contract — `redis.html` Lua help

Ships with item 4: the help says "Must be an array when Keys is greater than 0" and never states
what is expected when Keys is 0, which is exactly where the bug lives.

### 10. Optional — delete the dead runtime `extractSecrets` — `redis.js:392-431`

Never called at runtime; the only caller uses the editor copy at `redis.html:199`. Removing it drops
40 lines plus the mirror-sync mandate in `docs/ARCHITECTURE.md:118`, `docs/NODE_GUIDE.md:48-49`, and
both source comments. No behavior change, so easy to review and easy to defer.

## Tests to add

Items 2–5 each need a reproducing spec first, per the repository's test-first rule. Four of the
report's coverage gaps are worth closing in the same pass because they are free once the file is
open:

- `redis.js:957` — `inflightLoad` coalescing of concurrent reloads
- `redis.js:1079` — the anchored non-`NOSCRIPT` rethrow (must not trigger recovery)
- `redis.js:1186-1197` — `gracefulQuit`'s timeout and quit-rejects fallbacks
- `redis.js:656-661` — the xreadgroup NOGROUP warning, which comes with item 3

`957` and `1079` are deliberate correctness mechanisms carrying explanatory comments and no
assertions anywhere.

The remaining coverage items in the original report — mid-reconnect attach, five `redis-config`
micro-branches, `redis-instance` with a hand-edited `location`, "roughly 850 lines of editor JS" —
are enumeration rather than prioritization.
