"use strict";

// Characterization tests for reply shapes that ioredis v6 gates behind case-sensitive
// command-name lookups (Command.setReplyTransformer keys on the literal registered name,
// e.g. "xread", never "XREAD"). redis-command dispatches whatever case is saved on the node
// — the editor now suggests uppercase — so these commands bypass ioredis's reply legacy-shape
// mapping unless the dispatch layer normalizes their case first (see ARGUMENT_TRANSFORM_COMMANDS
// / dispatchCommandName in redis.js, today scoped to HSET/HMSET/MSET/MSETNX only).
//
// These tests pin today's (ioredis v5, RESP2) reply shapes for HRANDFIELD WITHVALUES, VSIM
// WITHSCORES, XREAD, XREADGROUP, and the ten ioredis "sorted-set pair" commands
// (zdiff/zinter/zpopmax/zpopmin/zunion/zrandmember/zrange/zrangebyscore/zrevrange/
// zrevrangebyscore) so the ioredis v6 + RESP3 upgrade and the matching dispatch-set extension
// can be verified against a known-good baseline instead of guessing.
// See docs/superpowers/specs/2026-08-08-ioredis-v6-resp3-unix-socket-release-plan.md.

const helper = require("node-red-node-test-helper");
const redisNode = require("../redis.js");
const { cleanupKeys } = require("./helpers/cleanup");
const { directRedis, redisConfigNode } = require("./helpers/deployment");
const { commandNode, helperNode, invoke, load } = require("./helpers/topology");

helper.init(require.resolve("node-red"));

const CONFIG = redisConfigNode("config1", "Local");

// Looser-than-exact-order assertion: confirms the reply is the legacy FLAT [member, score,
// member, score, ...] array (not RESP3's nested [[member, score], ...] pairs) and that it
// carries the right member->value data, without depending on Redis's tie-break ordering.
function assertFlatPairsContain(result, expectedEntries, compare) {
  result.should.be.an.Array();
  result.length.should.equal(expectedEntries.length * 2);
  const actual = {};
  for (let i = 0; i < result.length; i += 2) {
    actual[result[i]] = result[i + 1];
  }
  expectedEntries.forEach(([member, value]) => {
    actual.should.have.property(member);
    compare(actual[member], value);
  });
}

function equalString(actual, expected) {
  actual.should.equal(expected);
}

function approximatelyEqualScore(actual, expected) {
  actual.should.be.a.String();
  parseFloat(actual).should.be.approximately(parseFloat(expected), 0.0001);
}

const SORTED_SET_PAIR_CASES = [
  {
    id: "zrange",
    command: "ZRANGE",
    setup: (client, key) => client.call("ZADD", key, "1", "a", "2", "b"),
    args: (key) => [key, "0", "-1", "WITHSCORES"],
    expected: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  {
    id: "zrangebyscore",
    command: "ZRANGEBYSCORE",
    setup: (client, key) => client.call("ZADD", key, "1", "a", "2", "b"),
    args: (key) => [key, "-inf", "+inf", "WITHSCORES"],
    expected: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  {
    id: "zrevrange",
    command: "ZREVRANGE",
    setup: (client, key) => client.call("ZADD", key, "1", "a", "2", "b"),
    args: (key) => [key, "0", "-1", "WITHSCORES"],
    expected: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  {
    id: "zrevrangebyscore",
    command: "ZREVRANGEBYSCORE",
    setup: (client, key) => client.call("ZADD", key, "1", "a", "2", "b"),
    args: (key) => [key, "+inf", "-inf", "WITHSCORES"],
    expected: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  {
    id: "zrandmember",
    command: "ZRANDMEMBER",
    setup: (client, key) => client.call("ZADD", key, "1", "a", "2", "b"),
    args: (key) => [key, "2", "WITHSCORES"],
    expected: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  {
    id: "zpopmin",
    command: "ZPOPMIN",
    setup: (client, key) => client.call("ZADD", key, "1", "a", "2", "b"),
    args: (key) => [key, "2"],
    expected: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  {
    id: "zpopmax",
    command: "ZPOPMAX",
    setup: (client, key) => client.call("ZADD", key, "1", "a", "2", "b"),
    args: (key) => [key, "2"],
    expected: [
      ["a", "1"],
      ["b", "2"],
    ],
  },
  {
    id: "zdiff",
    command: "ZDIFF",
    setup: async (client, key) => {
      await client.call("ZADD", key + ":1", "1", "a", "2", "b");
      await client.call("ZADD", key + ":2", "5", "b");
    },
    args: (key) => ["2", key + ":1", key + ":2", "WITHSCORES"],
    expected: [["a", "1"]],
  },
  {
    id: "zinter",
    command: "ZINTER",
    setup: async (client, key) => {
      await client.call("ZADD", key + ":1", "1", "a", "2", "b");
      await client.call("ZADD", key + ":2", "5", "b", "6", "c");
    },
    args: (key) => ["2", key + ":1", key + ":2", "WITHSCORES"],
    expected: [["b", "7"]],
  },
  {
    id: "zunion",
    command: "ZUNION",
    setup: async (client, key) => {
      await client.call("ZADD", key + ":1", "1", "a", "2", "b");
      await client.call("ZADD", key + ":2", "5", "b", "6", "c");
    },
    args: (key) => ["2", key + ":1", key + ":2", "WITHSCORES"],
    expected: [
      ["a", "1"],
      ["b", "7"],
      ["c", "6"],
    ],
  },
];

function buildFlow() {
  const flow = [CONFIG];
  const fixedNodes = [
    ["hrandfield", "HRANDFIELD"],
    ["vsim", "VSIM"],
    ["xread", "XREAD"],
    ["xreadgroup", "XREADGROUP"],
  ];
  fixedNodes.forEach(([id, command]) => {
    flow.push(commandNode(id, command), helperNode(id));
  });
  SORTED_SET_PAIR_CASES.forEach((c) => {
    flow.push(commandNode(c.id, c.command), helperNode(c.id));
  });
  return flow;
}

describe("ioredis v6 case-sensitive reply transform characterization", function () {
  this.timeout(8000);

  let vectorSetsSupported;
  let probe;

  before(async function () {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
    probe = directRedis();
    const info = await probe.call("COMMAND", "INFO", "VADD");
    vectorSetsSupported = info[0] !== null;
    await load(helper, redisNode, buildFlow());
  });

  after(async function () {
    probe.disconnect();
    await helper.unload();
    await helper.stopServer();
    await new Promise((resolve, reject) =>
      cleanupKeys("test:v6char:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  it("HRANDFIELD WITHVALUES returns the legacy flat [field, value, ...] array", async function () {
    const key = "test:v6char:hash";
    await probe.call("HSET", key, "f1", "v1", "f2", "v2");
    const result = await invoke(helper, "hrandfield", { payload: [key, "2", "WITHVALUES"] });
    assertFlatPairsContain(
      result,
      [
        ["f1", "v1"],
        ["f2", "v2"],
      ],
      equalString
    );
  });

  it("VSIM WITHSCORES returns the legacy flat [member, score, ...] array", async function () {
    if (!vectorSetsSupported) {
      this.skip();
    }
    const key = "test:v6char:vectorset";
    await probe.call("VADD", key, "VALUES", "3", "1", "2", "3", "elem1");
    const result = await invoke(helper, "vsim", {
      payload: [key, "VALUES", "3", "1", "2", "3", "WITHSCORES"],
    });
    result.should.be.an.Array();
    result.length.should.equal(2);
    result[0].should.equal("elem1");
    result[1].should.be.a.String();
    parseFloat(result[1]).should.be.approximately(1, 0.001);
  });

  it("XREAD returns the legacy nested [[stream, [[id, fields]]]] shape", async function () {
    const key = "test:v6char:stream:xread";
    await probe.call("XADD", key, "*", "f1", "v1");
    const result = await invoke(helper, "xread", {
      payload: ["COUNT", "10", "STREAMS", key, "0"],
    });
    result.should.be.an.Array();
    result.length.should.equal(1);
    result[0][0].should.equal(key);
    result[0][1].should.be.an.Array();
    result[0][1][0][1].should.eql(["f1", "v1"]);
  });

  it("XREADGROUP returns the legacy nested [[stream, [[id, fields]]]] shape", async function () {
    const key = "test:v6char:stream:xreadgroup";
    await probe.call("XADD", key, "*", "f1", "v1");
    await probe.call("XGROUP", "CREATE", key, "v6chargrp", "0");
    const result = await invoke(helper, "xreadgroup", {
      payload: ["GROUP", "v6chargrp", "cons1", "COUNT", "10", "STREAMS", key, ">"],
    });
    result.should.be.an.Array();
    result.length.should.equal(1);
    result[0][0].should.equal(key);
    result[0][1][0][1].should.eql(["f1", "v1"]);
  });

  SORTED_SET_PAIR_CASES.forEach((c) => {
    it(`${c.command} keeps the legacy flat [member, score, ...] array`, async function () {
      const key = "test:v6char:zset:" + c.id;
      await c.setup(probe, key);
      const result = await invoke(helper, c.id, { payload: c.args(key) });
      assertFlatPairsContain(result, c.expected, approximatelyEqualScore);
    });
  });
});
