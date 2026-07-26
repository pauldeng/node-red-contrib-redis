"use strict";

const { spawnSync } = require("child_process");
const Redis = require("ioredis");

function intEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return Number(value);
}

function withOptionalAuth(options) {
  if (process.env.REDIS_USERNAME) {
    options.username = process.env.REDIS_USERNAME;
  }
  if (process.env.REDIS_PASSWORD) {
    options.password = process.env.REDIS_PASSWORD;
  }
  return options;
}

function redisOptions(overrides = {}) {
  return Object.assign(
    withOptionalAuth({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: intEnv("REDIS_PORT", 6379),
    }),
    overrides
  );
}

// Unreachable-host tests need a TCP port that refuses connections. Prefer the
// historical default 6399 when it is free; otherwise pick an ephemeral free
// port. An explicit REDIS_BAD_PORT that is actually reachable fails loudly —
// that used to produce six confident false failures instead of a clear error.
function tcpConnectable(host, port) {
  const script =
    "const net=require('net');" +
    "const s=net.connect({host:" +
    JSON.stringify(host) +
    ",port:" +
    Number(port) +
    "},()=>{s.destroy();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));" +
    "setTimeout(()=>{s.destroy();process.exit(1)},200);";
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }).status === 0;
}

function allocateFreePort() {
  const script =
    "const net=require('net');const s=net.createServer();" +
    "s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))});" +
    "s.on('error',e=>{console.error(e);process.exit(1)});";
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("failed to allocate a free port for unreachable-host tests: " + result.stderr);
  }
  return Number(result.stdout.trim());
}

let resolvedBadPort;

function badPort() {
  if (resolvedBadPort !== undefined) {
    return resolvedBadPort;
  }
  const host = process.env.REDIS_BAD_HOST || "127.0.0.1";
  if (process.env.REDIS_BAD_PORT) {
    const port = intEnv("REDIS_BAD_PORT");
    if (tcpConnectable(host, port)) {
      throw new Error(
        "REDIS_BAD_PORT=" +
          port +
          " on " +
          host +
          " is reachable; unreachable-host tests need a closed port. " +
          "Stop whatever is listening there, or unset REDIS_BAD_PORT to auto-pick."
      );
    }
    resolvedBadPort = port;
    return resolvedBadPort;
  }
  if (!tcpConnectable(host, 6399)) {
    resolvedBadPort = 6399;
    return resolvedBadPort;
  }
  resolvedBadPort = allocateFreePort();
  // Publish so sibling helpers/processes see the same choice.
  process.env.REDIS_BAD_PORT = String(resolvedBadPort);
  console.warn(
    "REDIS_BAD_PORT: 6399 on " + host + " is in use; using free port " + resolvedBadPort
  );
  return resolvedBadPort;
}

function badRedisOptions(overrides = {}) {
  return Object.assign(
    withOptionalAuth({
      host: process.env.REDIS_BAD_HOST || "127.0.0.1",
      port: badPort(),
      retryStrategy: null,
      maxRetriesPerRequest: 1,
      connectTimeout: 300,
    }),
    overrides
  );
}

function redisConfigNode(id = "config1", name = "Local", overrides = {}) {
  return {
    id,
    type: "redis-config",
    name,
    options: JSON.stringify(redisOptions(overrides)),
    optionsType: "json",
    cluster: false,
  };
}

function badRedisConfigNode(id = "cfg-bad", name = "BadConn", overrides = {}) {
  return {
    id,
    type: "redis-config",
    name,
    options: JSON.stringify(badRedisOptions(overrides)),
    optionsType: "json",
    cluster: false,
  };
}

function directRedis(overrides = {}) {
  return new Redis(redisOptions(overrides));
}

module.exports = {
  badRedisConfigNode,
  badRedisOptions,
  directRedis,
  redisConfigNode,
  redisOptions,
};
