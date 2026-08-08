"use strict";

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
const { commandNode, helperNode, invoke, load } = require("./helpers/topology");

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

describe("Redis 8.10 data-type families (generic redis-command path)", function () {
  this.timeout(8000);

  let supportedCommands;

  before(async function () {
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

  after(async function () {
    await helper.unload();
    await helper.stopServer();
    await new Promise((resolve, reject) =>
      cleanupKeys("test:8_10:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  function skipIfCommandMissing(command) {
    if (!supportedCommands || !supportedCommands.has(command)) {
      this.skip();
    }
  }

  it("ARSET/ARGET — sets and reads a value at an index in an Array", async function () {
    skipIfCommandMissing.call(this, "ARSET");
    const key = "test:8_10:array";
    await invoke(helper, "array", { topic: key, payload: [0, "hello"] });

    const client = directRedis();
    try {
      (await client.call("ARGET", key, "0")).should.equal("hello");
    } finally {
      client.disconnect();
    }
  });

  it("VADD/VSIM — adds a vector-set element and finds it by similarity", async function () {
    skipIfCommandMissing.call(this, "VADD");
    const key = "test:8_10:vectorset";
    await invoke(helper, "vectorset", { payload: [key, "VALUES", 3, 1, 2, 3, "elem1"] });

    const client = directRedis();
    try {
      const results = await client.call("VSIM", key, "VALUES", "3", "1", "2", "3");
      results.should.containEql("elem1");
    } finally {
      client.disconnect();
    }
  });

  it("INCREX — increments a key and sets its expiration atomically", async function () {
    skipIfCommandMissing.call(this, "INCREX");
    const key = "test:8_10:increx";
    const result = await invoke(helper, "increx", { topic: key, payload: ["BYINT", 5, "EX", 60] });
    parseFloat(result).should.equal(5);

    const client = directRedis();
    try {
      (await client.ttl(key)).should.be.aboveOrEqual(1);
    } finally {
      client.disconnect();
    }
  });

  it("XNACK — releases a claimed stream message back to the group's PEL", async function () {
    skipIfCommandMissing.call(this, "XNACK");
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
  });

  it("JSON.SET/JSON.GET — stores and retrieves a JSON document", async function () {
    skipIfCommandMissing.call(this, "JSON.SET");
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

  it("BF.RESERVE/BF.ADD/BF.EXISTS — Bloom filter membership", async function () {
    skipIfCommandMissing.call(this, "BF.RESERVE");
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

  it("CF.RESERVE/CF.ADD/CF.EXISTS — Cuckoo filter membership", async function () {
    skipIfCommandMissing.call(this, "CF.RESERVE");
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

  it("CMS.INITBYDIM/CMS.INCRBY/CMS.QUERY — Count-Min Sketch frequency estimate", async function () {
    skipIfCommandMissing.call(this, "CMS.INITBYDIM");
    const key = "test:8_10:cms";
    await invoke(helper, "cms", { payload: [key, "1000", "5"] });

    const client = directRedis();
    try {
      await client.call("CMS.INCRBY", key, "hello", "1");
      (await client.call("CMS.QUERY", key, "hello")).should.eql([1]);
    } finally {
      client.disconnect();
    }
  });

  it("TOPK.RESERVE/TOPK.ADD/TOPK.QUERY — Top-K frequent items", async function () {
    skipIfCommandMissing.call(this, "TOPK.RESERVE");
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

  it("TDIGEST.CREATE/TDIGEST.ADD/TDIGEST.QUANTILE — t-digest percentile estimate", async function () {
    skipIfCommandMissing.call(this, "TDIGEST.CREATE");
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
  });

  it("TS.CREATE/TS.ADD/TS.GET — Time Series data point", async function () {
    skipIfCommandMissing.call(this, "TS.CREATE");
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

// BACKUP is deliberately excluded from the datalist (DATALIST_EXCLUSIONS above) because every
// subcommand but HELP is ACL @admin @dangerous. Cover only the safe, read-only HELP path here —
// never a backup lifecycle mutation (START/SEAL/ABORT/CLEANUP) — while confirming the command
// itself still dispatches normally through the generic redis-command path when typed explicitly.
describe("BACKUP (Redis 8.10 admin command, excluded from datalist suggestions)", function () {
  this.timeout(8000);

  before(async function () {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
  });

  after(async function () {
    await helper.stopServer();
  });

  it("BACKUP HELP returns help text through the generic command path", async function () {
    const probe = directRedis();
    let supported;
    try {
      supported = (await probe.call("COMMAND", "INFO", "BACKUP"))[0] !== null;
    } finally {
      probe.disconnect();
    }
    if (!supported) {
      this.skip();
    }

    await load(helper, redisNode, [CONFIG, commandNode("backup", "BACKUP"), helperNode("backup")]);
    try {
      const result = await invoke(helper, "backup", { payload: ["HELP"] });
      result.should.be.an.Array();
      result[0].should.match(/BACKUP/);
    } finally {
      await helper.unload();
    }
  });
});

// Full-coverage check for the redis-command datalist: every command this deployed Redis
// reports (root name only, subcommands collapsed) must be either suggested or explicitly
// named in DATALIST_EXCLUSIONS above — no unreviewed gaps, no stale suggestions the server
// doesn't recognize. Complements (does not replace) the cheap no-Redis spot checks in
// test/redis_lua_ui_spec.js.
describe("redis-command datalist vs. live COMMAND LIST", function () {
  this.timeout(8000);

  it("suggests every supported command not in the documented exclusion list, and nothing unsupported", async function () {
    const client = directRedis();
    let liveRoots;
    try {
      const list = await client.call("COMMAND", "LIST");
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
  });
});
