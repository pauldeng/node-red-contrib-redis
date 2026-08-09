"use strict";

// Proves the redis-config Unix socket transport (added in the Single-mode Transport
// selector) end-to-end against a real Redis process with TCP disabled entirely: the
// config-node connection test succeeds, and a normal redis-command round-trip works over the
// socket path. The socket file itself lives in a host directory created and removed by
// scripts/run-deployment-tests.js for this one deployment (single-unix); only
// REDIS_UNIX_SOCKET_PATH is read here.

const { describe, it, before, after } = require("node:test");
const Redis = require("ioredis");
const helper = require("node-red-node-test-helper");
const redisNode = require("../redis.js");
const { commandNode, helperNode, invoke, load } = require("./helpers/topology");

helper.init(require.resolve("node-red"));

function unixSocketOptions() {
  return { path: process.env.REDIS_UNIX_SOCKET_PATH };
}

// test/helpers/cleanup.js connects over TCP, which this deployment disables entirely
// (port 0); clean up the one namespaced test key directly over the same Unix socket instead.
async function cleanupUnixSocketKeys(pattern) {
  const client = new Redis(unixSocketOptions());
  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } finally {
    client.disconnect();
  }
}

function unixConfigNode(id = "config1", name = "Local") {
  return {
    id,
    type: "redis-config",
    name,
    options: JSON.stringify(unixSocketOptions()),
    optionsType: "json",
    cluster: false,
  };
}

describe("Unix socket transport (TCP disabled)", () => {
  before(async () => {
    await new Promise((resolve, reject) =>
      helper.startServer((err) => (err ? reject(err) : resolve()))
    );
    await load(helper, redisNode, [
      unixConfigNode(),
      commandNode("set", "SET"),
      helperNode("set"),
      commandNode("get", "GET"),
      helperNode("get"),
    ]);
  });

  after(async () => {
    await helper.unload();
    await helper.stopServer();
    await cleanupUnixSocketKeys("test:unixsocket:*");
  });

  it(
    "redis-config's connection test succeeds over a Unix socket path",
    { timeout: 10000 },
    async () => {
      const res = await helper
        .request()
        .post("/redis-config/test")
        .send({
          id: "config1",
          cluster: false,
          optionsType: "json",
          options: JSON.stringify(unixSocketOptions()),
        })
        .expect(200);

      res.body.success.should.equal(true);
      res.body.response.should.equal("PONG");
      res.body.message.should.match(/PING -> PONG/);
    }
  );

  it(
    "runs normal redis-command traffic over the socket with no TCP port involved",
    { timeout: 10000 },
    async () => {
      const key = "test:unixsocket:string";
      (await invoke(helper, "set", { topic: key, payload: "value" })).should.equal("OK");
      (await invoke(helper, "get", { topic: key })).should.equal("value");
    }
  );
});
