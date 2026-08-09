"use strict";

const { describe, it, before, after } = require("node:test");
const fs = require("fs");
const path = require("path");

// Commands present on this Redis 8.10 deployment (per COMMAND LIST) that are deliberately
// NOT suggested in the redis-command datalist. Each entry names the concrete reason so a
// future audit can tell an intentional omission from a stale one at a glance. Categorized
// by the server's own ACL categories (`COMMAND INFO <name>`) and command semantics, not by
// guesswork.
const DATALIST_EXCLUSIONS = new Set([
  // Administrative / connection-lifecycle / replication internals — dangerous or
  // meaningless through a shared pooled connection (several already excluded pre-dating
  // this project; see commit dc9124f).
  "ASKING",
  "BACKUP", // ACL categories @admin @dangerous on every subcommand but HELP; server-side
  // backup lifecycle (START/SEAL/ABORT/CLEANUP/STATUS/LIST) has no place beside application
  // commands. Still fully callable by typing BACKUP into the free-text command field.
  "DEBUG",
  "FAILOVER",
  "FLUSHALL",
  "FLUSHDB",
  "MONITOR",
  "PFDEBUG", // ACL category @admin
  "PFSELFTEST", // ACL category @admin
  "PSYNC",
  "QUIT", // would close the shared pooled connection out from under other nodes
  "REPLCONF",
  "REPLICAOF",
  "RESET",
  "RESTORE-ASKING", // internal cluster-migration variant of RESTORE
  "SAVE",
  "SHUTDOWN",
  "SLAVEOF",
  "SYNC",
  "TRIMSLOTS", // cluster-slot bulk key removal
  "XIDMPRECORD", // self-described "internal command" (stream IDMP metadata)
  "DIGEST", // undocumented in the public Redis command reference
  // RediSearch/RedisTimeSeries internal or admin-only surfaces.
  "FT.CONFIG", // ACL category @admin (distinct from the internal _FT.CONFIG)
  "FT.DROPINDEX", // ACL category @dangerous
  "FT._LIST", // ACL category @admin
  "FT._ALIASADDIFNX",
  "FT._ALIASDELIFX",
  "FT._ALTERIFNX",
  "FT._CREATEIFNX",
  "FT._DROPIFX",
  "FT._DROPINDEXIFX",
  "_FT.CONFIG", // ACL category @admin
  "_FT.CURSOR",
  "_FT.DEBUG", // ACL category @admin @dangerous; Redis 8.10 adds an internal subcommand
  // under this already-excluded root, so no new top-level entry is needed
  "SEARCH.CLUSTERINFO", // internal cluster coordination, not a user command
  "SEARCH.CLUSTERREFRESH",
  "SEARCH.CLUSTERSET",
  "TIMESERIES.CLUSTERSET",
  "TIMESERIES.REFRESHCLUSTER",
]);

// Representative generic-command coverage for Redis 8.10 data-type families not covered by
// any existing command-family spec: the Array type, Vector Sets, and the probabilistic/search
// modules (JSON, Bloom, Cuckoo, Count-Min Sketch, Top-K, t-digest, Time Series) that ship
// bundled in the standalone `redis:8.10-alpine` image, plus two new standalone commands
// (INCREX, XNACK). This intentionally does not add one test per catalog command — the
// generic `redis-command` dispatch path plus one representative case per family is the
// contract (see docs/TESTING.md).
//
// This file is NOT in the topology-spec exclusion list in scripts/run-deployment-tests.js,
// so the deployment runner only ever includes it in the standalone (single-noauth/single-auth)
// stages — the Cluster and Sentinel topology stages run their own dedicated spec instead. For
// local `npm run test:mocha` iteration against an older or module-less Redis, every family
// (core commands and module-backed ones alike) still self-skips via a `COMMAND INFO`
// capability check.

const helper = require("node-red-node-test-helper");
const redisNode = require("../redis.js");
const { cleanupKeys } = require("./helpers/cleanup");
const { directRedis, redisConfigNode } = require("./helpers/deployment");
const { commandNode, expectError, helperNode, invoke, load } = require("./helpers/topology");

helper.init(require.resolve("node-red"));

const CONFIG = redisConfigNode("config1", "Local");

const FAMILIES = [
  { id: "array", command: "ARSET" },
  { id: "vectorset", command: "VADD" },
  { id: "increx", command: "INCREX" },
  { id: "xnack", command: "XNACK" },
  { id: "json", command: "JSON.SET" },
  { id: "bloom", command: "BF.RESERVE" },
  { id: "cuckoo", command: "CF.RESERVE" },
  { id: "cms", command: "CMS.INITBYDIM" },
  { id: "topk", command: "TOPK.RESERVE" },
  { id: "tdigest", command: "TDIGEST.CREATE" },
  { id: "timeseries", command: "TS.CREATE" },
];

function buildFlow() {
  const flow = [CONFIG];
  FAMILIES.forEach((f) => {
    flow.push(commandNode(f.id, f.command));
    flow.push(helperNode(f.id));
  });
  return flow;
}

async function waitForBlockedTsRead(timeoutMs = 2000) {
  const client = directRedis();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const clients = await client.call("CLIENT", "LIST");
      if (
        clients
          .split("\n")
          .some((line) => /(?:^| )flags=\S*b/.test(line) && line.includes("cmd=ts.read"))
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    client.disconnect();
  }
  throw new Error(`TS.READ was not blocked within ${timeoutMs}ms`);
}

describe("Redis 8.10 data-type families (generic redis-command path)", () => {
  let supportedCommands;

  before(async () => {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
    const probe = directRedis();
    try {
      // COMMAND INFO replies [nil] for an unknown command — a single, uniform capability
      // check that covers both new core commands (ARSET, VADD, INCREX, XNACK) and
      // module-backed ones (JSON.*, BF.*, ...), regardless of which mechanism ships them.
      const infos = await Promise.all(
        FAMILIES.map((f) => probe.call("COMMAND", "INFO", f.command))
      );
      supportedCommands = new Set(
        FAMILIES.filter((f, i) => infos[i][0] !== null).map((f) => f.command)
      );
    } finally {
      probe.disconnect();
    }
    await load(helper, redisNode, buildFlow());
  });

  after(async () => {
    await helper.unload();
    await helper.stopServer();
    await new Promise((resolve, reject) =>
      cleanupKeys("test:8_10:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  function skipIfCommandMissing(t, command) {
    if (!supportedCommands || !supportedCommands.has(command)) {
      t.skip();
      return true;
    }
    return false;
  }

  it(
    "ARSET/ARGET — sets and reads a value at an index in an Array",
    { timeout: 8000 },
    async (t) => {
      if (skipIfCommandMissing(t, "ARSET")) return;
      const key = "test:8_10:array";
      await invoke(helper, "array", { topic: key, payload: [0, "hello"] });

      const client = directRedis();
      try {
        (await client.call("ARGET", key, "0")).should.equal("hello");
      } finally {
        client.disconnect();
      }
    }
  );

  it(
    "VADD/VSIM — adds a vector-set element and finds it by similarity",
    { timeout: 8000 },
    async (t) => {
      if (skipIfCommandMissing(t, "VADD")) return;
      const key = "test:8_10:vectorset";
      await invoke(helper, "vectorset", { payload: [key, "VALUES", 3, 1, 2, 3, "elem1"] });

      const client = directRedis();
      try {
        const results = await client.call("VSIM", key, "VALUES", "3", "1", "2", "3");
        results.should.containEql("elem1");
      } finally {
        client.disconnect();
      }
    }
  );

  it(
    "INCREX — increments a key and sets its expiration atomically",
    { timeout: 8000 },
    async (t) => {
      if (skipIfCommandMissing(t, "INCREX")) return;
      const key = "test:8_10:increx";
      const result = await invoke(helper, "increx", {
        topic: key,
        payload: ["BYINT", 5, "EX", 60],
      });
      parseFloat(result).should.equal(5);

      const client = directRedis();
      try {
        (await client.ttl(key)).should.be.aboveOrEqual(1);
      } finally {
        client.disconnect();
      }
    }
  );

  it(
    "XNACK — releases a claimed stream message back to the group's PEL",
    { timeout: 8000 },
    async (t) => {
      if (skipIfCommandMissing(t, "XNACK")) return;
      const key = "test:8_10:xnack:stream";
      const client = directRedis();
      try {
        await client.xadd(key, "*", "field", "value");
        await client.xgroup("CREATE", key, "grp", "0");
        const read = await client.xreadgroup(
          "GROUP",
          "grp",
          "consumer-1",
          "COUNT",
          1,
          "STREAMS",
          key,
          ">"
        );
        const messageId = read[0][1][0][0];
        const result = await invoke(helper, "xnack", {
          payload: [key, "grp", "FAIL", "IDS", 1, messageId],
        });
        result.should.equal(1);
      } finally {
        client.disconnect();
      }
    }
  );

  it("JSON.SET/JSON.GET — stores and retrieves a JSON document", { timeout: 8000 }, async (t) => {
    if (skipIfCommandMissing(t, "JSON.SET")) return;
    const key = "test:8_10:json";
    await invoke(helper, "json", { payload: [key, "$", JSON.stringify({ a: 1 })] });

    const client = directRedis();
    try {
      const result = await client.call("JSON.GET", key);
      JSON.parse(result).should.deepEqual({ a: 1 });
    } finally {
      client.disconnect();
    }
  });

  it("BF.RESERVE/BF.ADD/BF.EXISTS — Bloom filter membership", { timeout: 8000 }, async (t) => {
    if (skipIfCommandMissing(t, "BF.RESERVE")) return;
    const key = "test:8_10:bloom";
    await invoke(helper, "bloom", { payload: [key, "0.01", "1000"] });

    const client = directRedis();
    try {
      await client.call("BF.ADD", key, "hello");
      (await client.call("BF.EXISTS", key, "hello")).should.equal(1);
    } finally {
      client.disconnect();
    }
  });

  it("CF.RESERVE/CF.ADD/CF.EXISTS — Cuckoo filter membership", { timeout: 8000 }, async (t) => {
    if (skipIfCommandMissing(t, "CF.RESERVE")) return;
    const key = "test:8_10:cuckoo";
    await invoke(helper, "cuckoo", { payload: [key, "1000"] });

    const client = directRedis();
    try {
      await client.call("CF.ADD", key, "hello");
      (await client.call("CF.EXISTS", key, "hello")).should.equal(1);
    } finally {
      client.disconnect();
    }
  });

  it(
    "CMS.INITBYDIM/CMS.INCRBY/CMS.QUERY — Count-Min Sketch frequency estimate",
    { timeout: 8000 },
    async (t) => {
      if (skipIfCommandMissing(t, "CMS.INITBYDIM")) return;
      const key = "test:8_10:cms";
      await invoke(helper, "cms", { payload: [key, "1000", "5"] });

      const client = directRedis();
      try {
        await client.call("CMS.INCRBY", key, "hello", "1");
        (await client.call("CMS.QUERY", key, "hello")).should.eql([1]);
      } finally {
        client.disconnect();
      }
    }
  );

  it("TOPK.RESERVE/TOPK.ADD/TOPK.QUERY — Top-K frequent items", { timeout: 8000 }, async (t) => {
    if (skipIfCommandMissing(t, "TOPK.RESERVE")) return;
    const key = "test:8_10:topk";
    await invoke(helper, "topk", { payload: [key, "10"] });

    const client = directRedis();
    try {
      await client.call("TOPK.ADD", key, "hello");
      (await client.call("TOPK.QUERY", key, "hello")).should.eql([1]);
    } finally {
      client.disconnect();
    }
  });

  it(
    "TDIGEST.CREATE/TDIGEST.ADD/TDIGEST.QUANTILE — t-digest percentile estimate",
    { timeout: 8000 },
    async (t) => {
      if (skipIfCommandMissing(t, "TDIGEST.CREATE")) return;
      const key = "test:8_10:tdigest";
      await invoke(helper, "tdigest", { payload: [key] });

      const client = directRedis();
      try {
        await client.call("TDIGEST.ADD", key, "1", "2", "3", "4", "5");
        const quantile = await client.call("TDIGEST.QUANTILE", key, "0.5");
        parseFloat(quantile[0]).should.be.aboveOrEqual(1);
      } finally {
        client.disconnect();
      }
    }
  );

  it("TS.CREATE/TS.ADD/TS.GET — Time Series data point", { timeout: 8000 }, async (t) => {
    if (skipIfCommandMissing(t, "TS.CREATE")) return;
    const key = "test:8_10:timeseries";
    await invoke(helper, "timeseries", { topic: key });

    const client = directRedis();
    try {
      await client.call("TS.ADD", key, "*", "42");
      const point = await client.call("TS.GET", key);
      parseFloat(point[1]).should.equal(42);
    } finally {
      client.disconnect();
    }
  });
});

// Redis 8.10 bundled-module additions: FT.ALIASLIST, Malay/Tagalog stemming, the
// FT.AGGREGATE COLLECT reducer, and the search-on-timeout `return-strict` policy. Each is
// exercised through the generic redis-command path and self-skips when the bundled search
// module is absent (older local Redis for `npm run test:mocha` iteration).
describe("Redis 8.10 Search module additions (generic redis-command path)", () => {
  let searchSupported;
  const indexes = [
    "test:8_10:ft:alias:idx",
    "test:8_10:ft:ms:idx",
    "test:8_10:ft:tl:idx",
    "test:8_10:ft:collect:idx",
  ];

  before(async () => {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
    const probe = directRedis();
    try {
      searchSupported = (await probe.call("COMMAND", "INFO", "FT.ALIASLIST"))[0] !== null;
    } finally {
      probe.disconnect();
    }
    await load(helper, redisNode, [
      CONFIG,
      commandNode("ftcreate", "FT.CREATE"),
      helperNode("ftcreate"),
      commandNode("ftaliasadd", "FT.ALIASADD"),
      helperNode("ftaliasadd"),
      commandNode("ftaliaslist", "FT.ALIASLIST"),
      helperNode("ftaliaslist"),
      commandNode("hset", "HSET"),
      helperNode("hset"),
      commandNode("ftsearch", "FT.SEARCH"),
      helperNode("ftsearch"),
      commandNode("ftaggregate", "FT.AGGREGATE"),
      helperNode("ftaggregate"),
      commandNode("config", "CONFIG"),
      helperNode("config"),
    ]);
  });

  after(async () => {
    await helper.unload();
    await helper.stopServer();
    if (searchSupported) {
      const client = directRedis();
      try {
        for (const index of indexes) {
          try {
            await client.call("FT.DROPINDEX", index);
          } catch (err) {
            if (!/SEARCH_INDEX_NOT_FOUND/.test(err.message)) {
              throw err;
            }
          }
        }
      } finally {
        client.disconnect();
      }
    }
    await new Promise((resolve, reject) =>
      cleanupKeys("test:8_10:ft:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  function skipIfUnsupported(t) {
    if (!searchSupported) {
      t.skip();
      return true;
    }
    return false;
  }

  // RediSearch indexes a freshly-HSET document asynchronously; a search issued immediately
  // afterward can (rarely, under load) still see 0 results. Poll briefly instead of assuming
  // immediate consistency.
  async function searchUntil(index, query, minTotalResults, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    let result;
    do {
      result = await invoke(helper, "ftsearch", { payload: [index, query] });
      if (result[result.indexOf("total_results") + 1] >= minTotalResults) {
        return result;
      }
    } while (Date.now() < deadline);
    return result;
  }

  it(
    "FT.ALIASLIST returns every alias currently pointing at an index",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const index = "test:8_10:ft:alias:idx";
      await invoke(helper, "ftcreate", {
        payload: [
          index,
          "ON",
          "HASH",
          "PREFIX",
          "1",
          "test:8_10:ft:alias:doc:",
          "SCHEMA",
          "title",
          "TEXT",
        ],
      });
      await invoke(helper, "ftaliasadd", { payload: ["test:8_10:ft:alias:one", index] });
      await invoke(helper, "ftaliasadd", { payload: ["test:8_10:ft:alias:two", index] });

      const aliases = await invoke(helper, "ftaliaslist", { payload: [index] });
      aliases.slice().sort().should.eql(["test:8_10:ft:alias:one", "test:8_10:ft:alias:two"]);
    }
  );

  it(
    "FT.CREATE's LANGUAGE option accepts Malay and Tagalog, and their stemmers match inflected query forms",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const cases = [
        { language: "malay", prefix: "test:8_10:ft:ms:", word: "berjalan", query: "jalan" },
        { language: "tagalog", prefix: "test:8_10:ft:tl:", word: "kumakain", query: "kain" },
      ];
      for (const { language, prefix, word, query } of cases) {
        const index = `${prefix}idx`;
        await invoke(helper, "ftcreate", {
          payload: [
            index,
            "ON",
            "HASH",
            "PREFIX",
            "1",
            prefix,
            "LANGUAGE",
            language,
            "SCHEMA",
            "title",
            "TEXT",
          ],
        });
        await invoke(helper, "hset", { topic: `${prefix}1`, payload: ["title", word] });

        // ioredis's default legacy reply mapping flattens FT.SEARCH's RESP3 map reply to
        // [key, value, key, value, ...]; FT.SEARCH has no dedicated reply transformer.
        const result = await searchUntil(index, query, 1);
        result[result.indexOf("total_results") + 1].should.equal(1);
        const results = result[result.indexOf("results") + 1];
        results[0][results[0].indexOf("id") + 1].should.equal(`${prefix}1`);
      }
    }
  );

  it(
    "FT.AGGREGATE's COLLECT reducer keeps field/value pairs per collected record, unlike TOLIST's flat values",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const index = "test:8_10:ft:collect:idx";
      await invoke(helper, "ftcreate", {
        payload: [
          index,
          "ON",
          "HASH",
          "PREFIX",
          "1",
          "test:8_10:ft:collect:doc:",
          "SCHEMA",
          "cat",
          "TAG",
          "val",
          "NUMERIC",
        ],
      });
      await invoke(helper, "hset", {
        topic: "test:8_10:ft:collect:doc:1",
        payload: ["cat", "a", "val", "1"],
      });
      await invoke(helper, "hset", {
        topic: "test:8_10:ft:collect:doc:2",
        payload: ["cat", "a", "val", "2"],
      });

      const collected = await invoke(helper, "ftaggregate", {
        payload: [
          index,
          "*",
          "GROUPBY",
          "1",
          "@cat",
          "REDUCE",
          "COLLECT",
          "3",
          "FIELDS",
          "1",
          "@val",
          "AS",
          "vals",
        ],
      });
      const listed = await invoke(helper, "ftaggregate", {
        payload: [
          index,
          "*",
          "GROUPBY",
          "1",
          "@cat",
          "REDUCE",
          "TOLIST",
          "1",
          "@val",
          "AS",
          "vals",
        ],
      });

      // Every RESP3 map in the reply is flattened to [key, value, key, value, ...] by ioredis's
      // default legacy reply mapping (module commands have no dedicated transformer); locate
      // fields by name rather than assuming a fixed position.
      function firstGroupVals(reply) {
        const results = reply[reply.indexOf("results") + 1];
        const group = results[0];
        const extra = group[group.indexOf("extra_attributes") + 1];
        return extra[extra.indexOf("vals") + 1];
      }

      firstGroupVals(collected)
        .slice()
        .sort((a, b) => a[1].localeCompare(b[1]))
        .should.eql([
          ["val", "1"],
          ["val", "2"],
        ]);
      firstGroupVals(listed).slice().sort().should.eql(["1", "2"]);
    }
  );

  it(
    "CONFIG SET/GET deterministically accepts search-on-timeout's return, fail, and return-strict policies",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const original = (
        await invoke(helper, "config", { payload: ["GET", "search-on-timeout"] })
      )[1];
      try {
        for (const policy of ["fail", "return-strict", "return"]) {
          await invoke(helper, "config", { payload: ["SET", "search-on-timeout", policy] });
          const current = await invoke(helper, "config", { payload: ["GET", "search-on-timeout"] });
          current[1].should.equal(policy);
        }
      } finally {
        await invoke(helper, "config", { payload: ["SET", "search-on-timeout", original] });
      }
    }
  );
});

// Redis 8.10's JSONPath extensions (RedisJSON): projection expressions, literal array/object
// comparisons, filter negation, size/sizeof/empty, in/nin, arithmetic operators, the ~
// get-keys operator, and a family of new postfix functions. Redis parses JSONPath itself; this
// table only proves each expression passes through the generic redis-command path byte-for-byte
// and that Redis's own result comes back unchanged.
describe("Redis 8.10 JSON module — JSONPath extensions (generic redis-command path)", () => {
  let jsonSupported;
  const KEY = "test:8_10:json:jsonpath";

  before(async () => {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
    const probe = directRedis();
    try {
      jsonSupported = (await probe.call("COMMAND", "INFO", "JSON.SET"))[0] !== null;
    } finally {
      probe.disconnect();
    }
    await load(helper, redisNode, [
      CONFIG,
      commandNode("jsonset", "JSON.SET"),
      helperNode("jsonset"),
      commandNode("jsonget", "JSON.GET"),
      helperNode("jsonget"),
    ]);
    if (jsonSupported) {
      await invoke(helper, "jsonset", {
        payload: [
          KEY,
          "$",
          JSON.stringify({
            a: 1,
            s: "hello world",
            x: "ab",
            y: "cd",
            absval: -5.7,
            arr: [3, 1, 4, 1, 5, 9, 2, 6],
            vals: [1, 2, 3, 4, 5],
            allow: [2, 4],
            strs: ["ab", "abc", "a"],
            objs: [{ x: 1 }, { x: 1, y: 2 }],
            obj: { x: 1, y: 2 },
            items: [[1, 2], [3, 4], { x: 1 }, { y: 2 }],
            sizearrs: [
              [1, 2, 3],
              [1, 2],
              [1, 2, 3, 4],
            ],
            emptyish: [[], {}, "", [1], { x: 1 }, "a"],
            nums: [{ n: -5 }, { n: 3 }, { n: 8 }],
            divs: [{ n: 10, d: 4 }],
            nested: [
              { a: 1, b: 2, c: 3 },
              { a: 1 },
              { single: 42 },
              { vals: [1, 2] },
              { vals: [9, 9] },
            ],
          }),
        ],
      });
      try {
        jsonSupported =
          JSON.stringify(
            JSON.parse(
              await invoke(helper, "jsonget", {
                payload: [KEY, "$.a + 1"],
              })
            )
          ) === "[2]";
      } catch (err) {
        if (err.name !== "ReplyError") {
          throw err;
        }
        jsonSupported = false;
      }
    }
  });

  after(async () => {
    await helper.unload();
    await helper.stopServer();
    await new Promise((resolve, reject) =>
      cleanupKeys("test:8_10:json:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  function skipIfUnsupported(t) {
    if (!jsonSupported) {
      t.skip();
      return true;
    }
    return false;
  }

  async function jsonPath(path) {
    const result = await invoke(helper, "jsonget", { payload: [KEY, path] });
    return JSON.parse(result);
  }

  async function assertPaths(cases) {
    for (const [path, expected] of cases) {
      (await jsonPath(path)).should.eql(expected);
    }
  }

  it(
    "supports a computed arithmetic expression as the entire top-level path",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      await assertPaths([["$.a + 1", [2]]]);
    }
  );

  it("== and != compare array and object literals directly", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.items[?(@ == [1,2])]", [[1, 2]]],
      ['$.items[?(@ == {"x":1})]', [{ x: 1 }]],
      ["$.items[?(@ != [1,2])]", [[3, 4], { x: 1 }, { y: 2 }]],
    ]);
  });

  it("the ! filter negation operator", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([["$.arr[?(!(@ == 1))]", [3, 4, 5, 9, 2, 6]]]);
  });

  it("the size/sizeof operator on strings, arrays, and objects", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.strs[?(@ sizeof 2)]", ["ab"]],
      ["$.sizearrs[?(@ size 3)]", [[1, 2, 3]]],
      ["$.objs[?(@ sizeof 1)]", [{ x: 1 }]],
    ]);
  });

  it("the empty operator", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.emptyish[?(@ empty true)]", [[], {}, ""]],
      ["$.emptyish[?(@ empty false)]", [[1], { x: 1 }, "a"]],
    ]);
  });

  it("the in and nin membership operators", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.vals[?(@ in [2,4])]", [2, 4]],
      ["$.vals[?(@ in $.allow)]", [2, 4]],
      ["$.vals[?(@ nin [2,4])]", [1, 3, 5]],
    ]);
  });

  it("binary arithmetic operators (+, -, *, /, %)", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.nums[?(@.n + 1 == 4)]", [{ n: 3 }]],
      ["$.nums[?(@.n - 1 == 2)]", [{ n: 3 }]],
      ["$.nums[?(@.n * 2 == 16)]", [{ n: 8 }]],
      ["$.divs[?(@.n / @.d == 2.5)]", [{ n: 10, d: 4 }]],
      ["$.divs[?(@.n % @.d == 2)]", [{ n: 10, d: 4 }]],
    ]);
  });

  it("unary arithmetic operators (-, +)", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.nums[?(-@.n == 5)]", [{ n: -5 }]],
      ["$.nums[?(+@.n == -5)]", [{ n: -5 }]],
    ]);
  });

  it("the ~ get-keys operator on objects", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([["$.obj~", ["x", "y"]]]);
  });

  it("length() on strings and arrays", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.s.length()", [11]],
      ["$.arr.length()", [8]],
    ]);
  });

  it("abs(), ceiling(), and floor() on numbers", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.absval.abs()", [5.7]],
      ["$.absval.ceiling()", [-5]],
      ["$.absval.floor()", [-6]],
    ]);
  });

  it("match() and search() on strings", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ['$.s.match("hello.*")', [true]],
      ['$.s.search("world")', [true]],
    ]);
  });

  it("concat() joins strings", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([["$.x.concat($.y)", ["abcd"]]]);
  });

  it("first(), last(), and index() on arrays", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([
      ["$.arr.first()", [3]],
      ["$.arr.last()", [6]],
      ["$.arr.index(2)", [4]],
      ["$.arr.index(-1)", [6]],
    ]);
  });

  it(
    "append() enriches the reply without mutating the stored document",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      // Unlike other path queries, append()'s reply is the single enriched array itself,
      // not wrapped in JSONPath's usual multi-match outer array.
      (await jsonPath("$.arr.append(9)")).should.eql([3, 1, 4, 1, 5, 9, 2, 6, 9]);
      (await jsonPath("$.arr")).should.eql([[3, 1, 4, 1, 5, 9, 2, 6]]);
    }
  );

  it(
    "min(), max(), avg(), and sum() aggregate an array, and stddev() computes a close estimate",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      await assertPaths([
        ["$.arr.min()", [1]],
        ["$.arr.max()", [9]],
        ["$.arr.avg()", [3.875]],
        ["$.arr.sum()", [31]],
      ]);
      const stddev = (await jsonPath("$.arr.stddev()"))[0];
      stddev.should.be.approximately(2.57, 0.1);
    }
  );

  it("keys() on objects", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    await assertPaths([["$.obj.keys()", ["x", "y"]]]);
  });

  it(
    "count() on a nodelist, value() on a single-node nodelist, subsetof(), anyof(), and noneof()",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      await assertPaths([
        ["$.nested[?(count(@.*) == 3)]", [{ a: 1, b: 2, c: 3 }]],
        ["$.nested[?(value(@.single) == 42)]", [{ single: 42 }]],
        ["$.nested[?(@.vals subsetof [1,2,3])]", [{ vals: [1, 2] }]],
        ["$.nested[?(@.vals anyof [1,2,9])]", [{ vals: [1, 2] }, { vals: [9, 9] }]],
        [
          "$.nested[?(@.vals noneof [7,8])]",
          [{ a: 1, b: 2, c: 3 }, { a: 1 }, { single: 42 }, { vals: [1, 2] }, { vals: [9, 9] }],
        ],
      ]);
    }
  );

  it("returns Redis's JSONPath syntax errors unchanged", { timeout: 8000 }, async (t) => {
    if (skipIfUnsupported(t)) return;
    const path = "$.items[?(";
    const nodeError = await expectError(helper, "jsonget", { payload: [KEY, path] });
    const client = directRedis();
    let directError;
    try {
      await client.call("JSON.GET", KEY, path);
    } catch (err) {
      directError = err;
    } finally {
      client.disconnect();
    }

    (directError instanceof Error).should.equal(true);
    nodeError.message.should.equal(directError.message);

    (await jsonPath("$.a")).should.eql([1]);
    helper.getNode("jsonget-node").listenerCount("call:error").should.equal(0);
    helper.getNode("jsonget-helper").listenerCount("input").should.equal(0);
  });
});

// Redis 8.10 Time Series additions: TS.NRANGE/TS.NREVRANGE (multi-series pivot by timestamp),
// TS.READ (immediate and blocking, dispatched with Block Commands for a dedicated connection),
// TS.QUERYLABELS, and EXCLUDEEMPTY on TS.MRANGE/TS.MREVRANGE.
describe("Redis 8.10 Time Series additions (generic redis-command path)", () => {
  let tsSupported;

  before(async () => {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
    const probe = directRedis();
    try {
      const infos = await probe.call(
        "COMMAND",
        "INFO",
        "TS.NRANGE",
        "TS.NREVRANGE",
        "TS.READ",
        "TS.QUERYLABELS"
      );
      tsSupported = infos.every((info) => info !== null);
    } finally {
      probe.disconnect();
    }
    await load(helper, redisNode, [
      CONFIG,
      commandNode("tscreate", "TS.CREATE"),
      helperNode("tscreate"),
      commandNode("tsadd", "TS.ADD"),
      helperNode("tsadd"),
      commandNode("tsnrange", "TS.NRANGE"),
      helperNode("tsnrange"),
      commandNode("tsnrevrange", "TS.NREVRANGE"),
      helperNode("tsnrevrange"),
      commandNode("tsread", "TS.READ"),
      helperNode("tsread"),
      commandNode("tsreadblock", "TS.READ", "config1", { block: true }),
      helperNode("tsreadblock"),
      commandNode("tsquerylabels", "TS.QUERYLABELS"),
      helperNode("tsquerylabels"),
      commandNode("tsmrange", "TS.MRANGE"),
      helperNode("tsmrange"),
      commandNode("tsmrevrange", "TS.MREVRANGE"),
      helperNode("tsmrevrange"),
    ]);
  });

  after(async () => {
    await helper.unload();
    await helper.stopServer();
    await new Promise((resolve, reject) =>
      cleanupKeys("test:8_10:ts:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  function skipIfUnsupported(t) {
    if (!tsSupported) {
      t.skip();
      return true;
    }
    return false;
  }

  it(
    "TS.NRANGE and TS.NREVRANGE pivot multiple series by timestamp",
    { timeout: 10000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const keyA = "test:8_10:ts:nrange:a";
      const keyB = "test:8_10:ts:nrange:b";
      await invoke(helper, "tscreate", { topic: keyA });
      await invoke(helper, "tscreate", { topic: keyB });
      await invoke(helper, "tsadd", { payload: [keyA, "100", "1"] });
      await invoke(helper, "tsadd", { payload: [keyA, "200", "2"] });
      await invoke(helper, "tsadd", { payload: [keyB, "100", "10"] });
      await invoke(helper, "tsadd", { payload: [keyB, "200", "20"] });

      const forward = await invoke(helper, "tsnrange", { payload: ["2", keyA, keyB, "-", "+"] });
      forward.should.eql([
        [100, ["1", "10"]],
        [200, ["2", "20"]],
      ]);

      const backward = await invoke(helper, "tsnrevrange", {
        payload: ["2", keyA, keyB, "-", "+"],
      });
      backward.should.eql([
        [200, ["2", "20"]],
        [100, ["1", "10"]],
      ]);
    }
  );

  it(
    "TS.READ returns samples at or after a timestamp immediately",
    { timeout: 10000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = "test:8_10:ts:read:immediate";
      await invoke(helper, "tscreate", { topic: key });
      await invoke(helper, "tsadd", { payload: [key, "100", "1"] });
      await invoke(helper, "tsadd", { payload: [key, "200", "2"] });

      const result = await invoke(helper, "tsread", { payload: [key, "150"] });
      result.should.eql([[200, "2"]]);
    }
  );

  it(
    "TS.QUERYLABELS lists label names and label values for series matching a filter",
    { timeout: 10000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const keyA = "test:8_10:ts:labels:a";
      const keyB = "test:8_10:ts:labels:b";
      const client = directRedis();
      try {
        await client.call(
          "TS.CREATE",
          keyA,
          "LABELS",
          "region",
          "us",
          "grp",
          "test:8_10:ts:labels"
        );
        await client.call(
          "TS.CREATE",
          keyB,
          "LABELS",
          "region",
          "eu",
          "grp",
          "test:8_10:ts:labels"
        );
      } finally {
        client.disconnect();
      }

      const labels = await invoke(helper, "tsquerylabels", {
        payload: ["LABELS", "FILTER", "grp=test:8_10:ts:labels"],
      });
      labels.slice().sort().should.eql(["grp", "region"]);

      const values = await invoke(helper, "tsquerylabels", {
        payload: ["VALUES", "region", "FILTER", "grp=test:8_10:ts:labels"],
      });
      values.slice().sort().should.eql(["eu", "us"]);
    }
  );

  it(
    "EXCLUDEEMPTY on TS.MRANGE and TS.MREVRANGE drops series with no samples in range",
    { timeout: 10000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const withSample = "test:8_10:ts:mrange:with-sample";
      const withoutSample = "test:8_10:ts:mrange:without-sample";
      const client = directRedis();
      try {
        await client.call("TS.CREATE", withSample, "LABELS", "grp", "test:8_10:ts:mrange");
        await client.call("TS.CREATE", withoutSample, "LABELS", "grp", "test:8_10:ts:mrange");
        await client.call("TS.ADD", withSample, "100", "5");
      } finally {
        client.disconnect();
      }

      for (const command of ["tsmrange", "tsmrevrange"]) {
        const withEmpty = await invoke(helper, command, {
          payload: ["-", "+", "FILTER", "grp=test:8_10:ts:mrange"],
        });
        withEmpty.should.containEql(withSample);
        withEmpty.should.containEql(withoutSample);

        const excludeEmpty = await invoke(helper, command, {
          payload: ["-", "+", "EXCLUDEEMPTY", "FILTER", "grp=test:8_10:ts:mrange"],
        });
        excludeEmpty.should.containEql(withSample);
        excludeEmpty.should.not.containEql(withoutSample);
      }
    }
  );

  it(
    "BLOCK-ing TS.READ (Block Commands) resolves as soon as a qualifying sample arrives",
    { timeout: 10000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = "test:8_10:ts:read:block:arrives";
      await invoke(helper, "tscreate", { topic: key });

      const pending = invoke(
        helper,
        "tsreadblock",
        { payload: [key, "0", "BLOCK", "5000", "1"] },
        6000
      );
      await waitForBlockedTsRead();
      await invoke(helper, "tsadd", { payload: [key, "500", "42"] });

      (await pending).should.eql([[500, "42"]]);
    }
  );

  it(
    "BLOCK-ing TS.READ resolves an empty array after its timeout when no sample ever arrives",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = "test:8_10:ts:read:block:timeout";
      await invoke(helper, "tscreate", { topic: key });

      const result = await invoke(
        helper,
        "tsreadblock",
        { payload: [key, "0", "BLOCK", "1000", "1"] },
        5000
      );
      result.should.eql([]);
    }
  );

  // Last in this suite on purpose: it unloads the flow early to time shutdown, so no
  // later test in this describe block can depend on the flow still being loaded.
  it(
    "BLOCK-ing TS.READ (Block Commands) closes cleanly while still blocked on an empty series",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = "test:8_10:ts:read:block:shutdown";
      await invoke(helper, "tscreate", { topic: key });

      helper.getNode("tsreadblock-node").receive({ payload: [key, "0", "BLOCK", "0", "1"] });

      await waitForBlockedTsRead();
      const started = Date.now();
      await helper.unload();
      (Date.now() - started).should.be.below(1000);
    }
  );
});

// Redis 8.10 fixed three argument-validation/ACL bugs (see the official 8.10 release notes'
// "Bug fixes compared to 8.8.0"): an ACL key-permission bypass on SORT/GEORADIUS/
// GEORADIUSBYMEMBER/XREAD/XREADGROUP, SET silently accepting mutually exclusive NX/XX/IF*
// options, and VADD ... CAS SETATTR recording the wrong attribute count. These tests protect
// each fix at this package's boundary — the node must surface Redis's own stricter errors (or
// corrected behavior) unchanged, never add client-side policy to work around them.
describe("Redis 8.10 ACL and argument-validation regression fixes", () => {
  const ACL_USER = "test_8_10_acl_restricted";
  const ACL_PASSWORD = "test-8-10-acl-pass";
  const ALLOWED_PREFIX = "test:8_10:acl:allowed:";
  const FORBIDDEN_PREFIX = "test:8_10:acl:forbidden:";
  const ACL_CONFIG = redisConfigNode("acl-config", "AclRestricted", {
    username: ACL_USER,
    password: ACL_PASSWORD,
  });

  let regressionSupported;

  before(async () => {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
    const probe = directRedis();
    try {
      // VADD stands in for "this is Redis 8.10", the same signal the vector-set family test
      // above uses; the ACL/SET fixes shipped in the same release.
      regressionSupported = (await probe.call("COMMAND", "INFO", "VADD"))[0] !== null;
      if (regressionSupported) {
        await probe.call(
          "ACL",
          "SETUSER",
          ACL_USER,
          "on",
          `>${ACL_PASSWORD}`,
          `~${ALLOWED_PREFIX}*`,
          "+@all"
        );
      }
    } finally {
      probe.disconnect();
    }
    await load(helper, redisNode, [
      CONFIG,
      ACL_CONFIG,
      commandNode("setup-rpush", "RPUSH"),
      helperNode("setup-rpush"),
      commandNode("setup-geoadd", "GEOADD"),
      helperNode("setup-geoadd"),
      commandNode("setup-xadd", "XADD"),
      helperNode("setup-xadd"),
      commandNode("setup-xgroup", "XGROUP"),
      helperNode("setup-xgroup"),
      commandNode("sort", "SORT", "acl-config"),
      helperNode("sort"),
      commandNode("georadius", "GEORADIUS", "acl-config"),
      helperNode("georadius"),
      commandNode("georadiusbymember", "GEORADIUSBYMEMBER", "acl-config"),
      helperNode("georadiusbymember"),
      commandNode("xread", "XREAD", "acl-config"),
      helperNode("xread"),
      commandNode("xreadgroup", "XREADGROUP", "acl-config"),
      helperNode("xreadgroup"),
      commandNode("set", "SET"),
      helperNode("set"),
      commandNode("vadd", "VADD"),
      helperNode("vadd"),
      commandNode("vgetattr", "VGETATTR"),
      helperNode("vgetattr"),
    ]);
  });

  after(async () => {
    await helper.unload();
    await helper.stopServer();
    if (regressionSupported) {
      const probe = directRedis();
      try {
        await probe.call("ACL", "DELUSER", ACL_USER);
      } finally {
        probe.disconnect();
      }
    }
    await new Promise((resolve, reject) =>
      cleanupKeys("test:8_10:acl:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  function skipIfUnsupported(t) {
    if (!regressionSupported) {
      t.skip();
      return true;
    }
    return false;
  }

  it(
    "SORT rejects a restricted user's out-of-pattern key (ACL bypass fix)",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = `${FORBIDDEN_PREFIX}list`;
      await invoke(helper, "setup-rpush", { topic: key, payload: ["c", "b", "a"] });

      const err = await expectError(helper, "sort", { payload: [key, "ALPHA"] });
      err.message.should.match(/NOPERM/);
    }
  );

  it(
    "GEORADIUS and GEORADIUSBYMEMBER reject a restricted user's out-of-pattern key",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = `${FORBIDDEN_PREFIX}geo`;
      await invoke(helper, "setup-geoadd", { payload: [key, "-122.27", "37.80", "Oakland"] });

      (
        await expectError(helper, "georadius", { payload: [key, "-122.27", "37.80", "100", "km"] })
      ).message.should.match(/NOPERM/);
      (
        await expectError(helper, "georadiusbymember", { payload: [key, "Oakland", "100", "km"] })
      ).message.should.match(/NOPERM/);
    }
  );

  it(
    "XREAD and XREADGROUP reject a restricted user's out-of-pattern key",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = `${FORBIDDEN_PREFIX}stream`;
      await invoke(helper, "setup-xadd", { topic: key, payload: ["*", "field", "value"] });
      await invoke(helper, "setup-xgroup", { payload: ["CREATE", key, "grp", "0"] });

      (
        await expectError(helper, "xread", { payload: ["COUNT", "1", "STREAMS", key, "0"] })
      ).message.should.match(/NOPERM/);
      (
        await expectError(helper, "xreadgroup", {
          payload: ["GROUP", "grp", "consumer1", "COUNT", "1", "STREAMS", key, ">"],
        })
      ).message.should.match(/NOPERM/);
    }
  );

  it(
    "SET rejects mutually exclusive NX/XX and IFEQ option combinations",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = "test:8_10:acl:set:mutex";
      await invoke(helper, "set", { topic: key, payload: "initial" });

      for (const args of [
        [key, "newval", "NX", "IFEQ", "initial"],
        [key, "newval", "XX", "IFEQ", "initial"],
        [key, "newval", "NX", "XX"],
      ]) {
        const err = await expectError(helper, "set", { payload: args });
        err.message.should.match(/ERR syntax error/);
      }
    }
  );

  it(
    "VADD ... CAS SETATTR sets the correct attribute count alongside the vector",
    { timeout: 8000 },
    async (t) => {
      if (skipIfUnsupported(t)) return;
      const key = "test:8_10:acl:vadd:cas";

      const added = await invoke(helper, "vadd", {
        payload: [
          key,
          "VALUES",
          "3",
          "1",
          "2",
          "3",
          "elem1",
          "CAS",
          "SETATTR",
          JSON.stringify({ tag: "x" }),
        ],
      });
      added.should.equal(1);

      const attrs = await invoke(helper, "vgetattr", { payload: [key, "elem1"] });
      JSON.parse(attrs).should.eql({ tag: "x" });
    }
  );
});

// BACKUP is deliberately excluded from the datalist (DATALIST_EXCLUSIONS above) because every
// subcommand but HELP is ACL @admin @dangerous. Cover only the safe, read-only HELP path here —
// never a backup lifecycle mutation (START/SEAL/ABORT/CLEANUP) — while confirming the command
// itself still dispatches normally through the generic redis-command path when typed explicitly.
describe("BACKUP (Redis 8.10 admin command, excluded from datalist suggestions)", () => {
  before(async () => {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
  });

  after(async () => {
    await helper.stopServer();
  });

  it(
    "BACKUP HELP returns help text through the generic command path",
    { timeout: 8000 },
    async (t) => {
      const probe = directRedis();
      let supported;
      try {
        supported = (await probe.call("COMMAND", "INFO", "BACKUP"))[0] !== null;
      } finally {
        probe.disconnect();
      }
      if (!supported) {
        t.skip();
        return;
      }

      await load(helper, redisNode, [
        CONFIG,
        commandNode("backup", "BACKUP"),
        helperNode("backup"),
      ]);
      try {
        const result = await invoke(helper, "backup", { payload: ["HELP"] });
        result.should.be.an.Array();
        result[0].should.match(/BACKUP/);
      } finally {
        await helper.unload();
      }
    }
  );
});

// Full-coverage check for the redis-command datalist: every command this deployed Redis
// reports (root name only, subcommands collapsed) must be either suggested or explicitly
// named in DATALIST_EXCLUSIONS above — no unreviewed gaps, no stale suggestions the server
// doesn't recognize. Complements (does not replace) the cheap no-Redis spot checks in
// test/redis_lua_ui_spec.js. Self-skips when COMMAND LIST itself is unsupported (pre-7.0
// Redis), since this audit is scoped to the current-feature target, not the compatibility
// floor.
function isUnsupportedCommandListError(err) {
  return (
    err instanceof Error &&
    /Unknown subcommand or wrong number of arguments for ['"]LIST['"]/i.test(err.message)
  );
}

describe("COMMAND LIST capability detection", () => {
  it("recognizes the pre-7.0 unsupported-subcommand reply", () => {
    isUnsupportedCommandListError(
      new Error("ERR Unknown subcommand or wrong number of arguments for 'LIST'. Try COMMAND HELP.")
    ).should.equal(true);
  });

  it("does not hide unrelated Redis or transport failures", () => {
    [new Error("NOPERM this user has no permissions"), new Error("connect ECONNRESET")].forEach(
      (err) => isUnsupportedCommandListError(err).should.equal(false)
    );
  });
});

describe("redis-command datalist vs. live COMMAND LIST", () => {
  it(
    "suggests every supported command not in the documented exclusion list, and nothing unsupported",
    { timeout: 8000 },
    async (t) => {
      const client = directRedis();
      let liveRoots;
      try {
        // This audit is scoped to the Redis 8.10 target specifically: Valkey (this package's
        // other tested engine) does not bundle Search/JSON/Bloom/Cuckoo/CMS/TopK/t-digest/Time
        // Series and would fail the "stale suggestion" half of this check on every one of those
        // command roots, which is expected and not a real gap. Detect it via INFO server's
        // Valkey-only server_name field and self-skip.
        const info = await client.call("INFO", "server");
        if (/(?:^|\n)server_name:valkey/.test(info)) {
          t.skip();
          return;
        }
        // COMMAND LIST is a Redis 7.0+ subcommand. Self-skip on an older server rather than
        // failing — this audit is scoped to the current-feature (Redis 8.10) target.
        let list;
        try {
          list = await client.call("COMMAND", "LIST");
        } catch (err) {
          if (!isUnsupportedCommandListError(err)) {
            throw err;
          }
          t.skip();
          return;
        }
        liveRoots = new Set(list.map((name) => name.split("|")[0].toUpperCase()));
      } finally {
        client.disconnect();
      }

      const html = fs.readFileSync(path.join(__dirname, "../redis.html"), "utf8");
      const templateIdx = html.indexOf('data-template-name="redis-command"');
      const scriptEnd = html.indexOf("</script>", templateIdx);
      const block = html.slice(templateIdx, scriptEnd);
      const datalist = new Set();
      const optionRe = /<option value="([^"]+)">/g;
      let m;
      while ((m = optionRe.exec(block))) {
        datalist.add(m[1].toUpperCase());
      }

      const missing = [...liveRoots].filter(
        (cmd) => !datalist.has(cmd) && !DATALIST_EXCLUSIONS.has(cmd)
      );
      const stale = [...datalist].filter((cmd) => !liveRoots.has(cmd));

      missing
        .sort()
        .should.eql(
          [],
          "commands supported by this Redis but neither suggested nor in DATALIST_EXCLUSIONS"
        );
      stale
        .sort()
        .should.eql([], "datalist suggestions this Redis deployment does not actually register");
    }
  );
});
