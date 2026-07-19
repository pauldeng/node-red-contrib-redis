"use strict";

// Regression tests for redis-lua-script connection-pool identity.
//
// Historical bug 1 (fixed): RedisLua built its pool key from `n.server.name`, but `n.server`
// is the config-node *id string*, not the resolved config node — so `n.server.name` was
// undefined and every non-blocking lua node shared one pool entry regardless of config.
//
// Historical bug 2 (fixed): the pool key was then the resolved config's *display name*
// (`this.server.name`), which is user-editable and defaults to "Local". Two config nodes
// with different ids but the same (often default) name silently shared one client, so a
// lua node pointed at one server/DB could run against another.
//
// The invariant these tests protect: the pool key is the config-node id (`n.server`), which
// is unique and immutable regardless of display name. Both tests assert the CORRECT
// behavior (a write through the db-1 node lands in db 1, not db 0).

const helper = require("node-red-node-test-helper");
const redisNode = require("../redis.js");
const deployment = require("./helpers/deployment");

helper.init(require.resolve("node-red"));

const TEST_KEY = "lua:conntest:key";
const TEST_KEY_SAME_NAME = "lua:conntest:key:samename";

async function delKeyInBothDbs() {
  const c0 = deployment.directRedis({ db: 0 });
  const c1 = deployment.directRedis({ db: 1 });
  try {
    await Promise.all([
      c0.del(TEST_KEY),
      c1.del(TEST_KEY),
      c0.del(TEST_KEY_SAME_NAME),
      c1.del(TEST_KEY_SAME_NAME),
    ]);
  } finally {
    c0.disconnect();
    c1.disconnect();
  }
}

describe("redis-lua-script connection isolation", function () {
  this.timeout(8000);

  beforeEach(async function () {
    await helper.startServer();
    await delKeyInBothDbs();
  });

  afterEach(async function () {
    await helper.unload();
    await delKeyInBothDbs();
    await helper.stopServer();
  });

  it("routes a non-blocking lua node to its own config's DB (not a shared pooled client)", async function () {
    const flow = [
      deployment.redisConfigNode("cfg-db0", "ConfigDb0", { db: 0 }),
      deployment.redisConfigNode("cfg-db1", "ConfigDb1", { db: 1 }),
      // Constructed first: seeds the pool with a db-0 client under its own config id.
      {
        id: "lua-db0",
        type: "redis-lua-script",
        server: "cfg-db0",
        name: "luaDb0",
        keyval: 1,
        func: "redis.call('SET', KEYS[1], ARGV[1])\nreturn 'OK'",
        stored: false,
        block: false,
        wires: [["sink0"]],
      },
      { id: "sink0", type: "helper" },
      // Points at db 1 — must not reuse the db-0 client above.
      {
        id: "lua-db1",
        type: "redis-lua-script",
        server: "cfg-db1",
        name: "luaDb1",
        keyval: 1,
        func: "redis.call('SET', KEYS[1], ARGV[1])\nreturn 'OK'",
        stored: false,
        block: false,
        wires: [["sink1"]],
      },
      { id: "sink1", type: "helper" },
    ];

    await helper.load(redisNode, flow);
    const luaDb1 = helper.getNode("lua-db1");
    const sink1 = helper.getNode("sink1");
    const scriptRan = new Promise((resolve) => sink1.once("input", resolve));

    luaDb1.receive({ payload: [TEST_KEY, "valueB"] });
    await scriptRan;

    const probe1 = deployment.directRedis({ db: 1 });
    const probe0 = deployment.directRedis({ db: 0 });
    let inDb1, inDb0;
    try {
      [inDb1, inDb0] = await Promise.all([probe1.get(TEST_KEY), probe0.get(TEST_KEY)]);
    } finally {
      probe0.disconnect();
      probe1.disconnect();
    }

    assert_equal(
      inDb1,
      "valueB",
      "lua node pointed at db 1 should write to db 1 (got db1=" +
        JSON.stringify(inDb1) +
        ", db0=" +
        JSON.stringify(inDb0) +
        "). If the value landed in db 0, the lua nodes are sharing one pooled connection."
    );
  });

  it("routes a non-blocking lua node to its own config's DB even when both configs share the default name 'Local'", async function () {
    const flow = [
      // Both configs keep the default display name ("Local") but have distinct ids —
      // the common real-world case, since redis-config's editor name defaults to "Local".
      deployment.redisConfigNode("cfg-samename-db0", "Local", { db: 0 }),
      deployment.redisConfigNode("cfg-samename-db1", "Local", { db: 1 }),
      {
        id: "lua-samename-db0",
        type: "redis-lua-script",
        server: "cfg-samename-db0",
        name: "luaSameNameDb0",
        keyval: 1,
        func: "redis.call('SET', KEYS[1], ARGV[1])\nreturn 'OK'",
        stored: false,
        block: false,
        wires: [["sink-samename-0"]],
      },
      { id: "sink-samename-0", type: "helper" },
      {
        id: "lua-samename-db1",
        type: "redis-lua-script",
        server: "cfg-samename-db1",
        name: "luaSameNameDb1",
        keyval: 1,
        func: "redis.call('SET', KEYS[1], ARGV[1])\nreturn 'OK'",
        stored: false,
        block: false,
        wires: [["sink-samename-1"]],
      },
      { id: "sink-samename-1", type: "helper" },
    ];

    await helper.load(redisNode, flow);
    const luaDb1 = helper.getNode("lua-samename-db1");
    const sink1 = helper.getNode("sink-samename-1");
    const scriptRan = new Promise((resolve) => sink1.once("input", resolve));

    luaDb1.receive({ payload: [TEST_KEY_SAME_NAME, "valueB"] });
    await scriptRan;

    const probe1 = deployment.directRedis({ db: 1 });
    const probe0 = deployment.directRedis({ db: 0 });
    let inDb1, inDb0;
    try {
      [inDb1, inDb0] = await Promise.all([
        probe1.get(TEST_KEY_SAME_NAME),
        probe0.get(TEST_KEY_SAME_NAME),
      ]);
    } finally {
      probe0.disconnect();
      probe1.disconnect();
    }

    assert_equal(
      inDb1,
      "valueB",
      "lua node pointed at db 1 should write to db 1 (got db1=" +
        JSON.stringify(inDb1) +
        ", db0=" +
        JSON.stringify(inDb0) +
        "). If the value landed in db 0, the two default-named 'Local' configs are sharing " +
        "one pooled connection."
    );
  });
});

function assert_equal(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg);
  }
}
