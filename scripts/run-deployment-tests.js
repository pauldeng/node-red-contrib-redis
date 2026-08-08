"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const Redis = require("ioredis");
const {
  ROOT,
  authEnv,
  authOptions,
  ensureDockerReady,
  logServerVersion,
  noauthOptions,
  pullImages,
  quietRedis,
  runDeployments,
  runMocha,
  sleep,
  unauthEnv,
  waitForRedis,
} = require("./deployment-runner");

const TOPOLOGY_SPECS = new Set([
  "memorydb_deployment_spec.js",
  "redis_cluster_deployment_spec.js",
  "redis_sentinel_deployment_spec.js",
  "redis_unix_socket_deployment_spec.js",
]);

function standaloneSpecs() {
  return fs
    .readdirSync(path.join(ROOT, "test"))
    .filter((name) => /_spec\.js$/.test(name) && !TOPOLOGY_SPECS.has(name))
    .sort()
    .map((name) => `test/${name}`);
}

async function waitForCluster() {
  const deadline = Date.now() + 45000;
  let lastError;
  while (Date.now() < deadline) {
    const client = quietRedis(new Redis(authOptions(7000)));
    try {
      const info = await client.cluster("info");
      if (/cluster_state:ok/.test(info)) {
        client.disconnect();
        return;
      }
      lastError = new Error(info.trim());
    } catch (err) {
      lastError = err;
    }
    client.disconnect();
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Cluster: ${lastError && lastError.message}`);
}

async function waitForSentinel() {
  const deadline = Date.now() + 45000;
  let lastError;
  while (Date.now() < deadline) {
    const sentinel = quietRedis(
      new Redis({
        host: "127.0.0.1",
        port: 26379,
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        retryStrategy: null,
      })
    );
    try {
      const master = await sentinel.call("SENTINEL", "get-master-addr-by-name", "mymaster");
      if (Array.isArray(master) && master.length === 2) {
        const redis = quietRedis(new Redis(authOptions(Number(master[1]))));
        await redis.ping();
        redis.disconnect();
        if (await hasPromotableSentinelReplica(sentinel)) {
          sentinel.disconnect();
          return;
        }
        lastError = new Error("Sentinel has no promotable replica yet");
      }
      if (!lastError) {
        lastError = new Error("Sentinel did not return a master address");
      }
    } catch (err) {
      lastError = err;
    }
    sentinel.disconnect();
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Sentinel: ${lastError && lastError.message}`);
}

function sentinelRowToObject(row) {
  const out = {};
  for (let i = 0; i < row.length; i += 2) {
    out[row[i]] = row[i + 1];
  }
  return out;
}

async function hasPromotableSentinelReplica(sentinel) {
  const rows = await sentinel.call("SENTINEL", "slaves", "mymaster");
  return rows.map(sentinelRowToObject).some((replica) => {
    const flags = String(replica.flags || "");
    return (
      !flags.includes("s_down") &&
      !flags.includes("o_down") &&
      !flags.includes("disconnected") &&
      replica["master-link-status"] === "ok" &&
      replica["slave-priority"] !== "0"
    );
  });
}

let unixSocketDir;

async function waitForUnixSocket(socketPath) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      const client = quietRedis(new Redis({ path: socketPath }));
      try {
        await client.ping();
        client.disconnect();
        return;
      } catch (err) {
        lastError = err;
        client.disconnect();
      }
    }
    await sleep(300);
  }
  throw new Error(
    `Timed out waiting for the Unix socket at ${socketPath}: ${lastError && lastError.message}`
  );
}

function requireMemoryDbEnv() {
  if (process.env.MEMORYDB_ENABLED !== "1") {
    return null;
  }
  const required = ["MEMORYDB_ENDPOINT", "MEMORYDB_PORT", "MEMORYDB_USERNAME", "MEMORYDB_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`MEMORYDB_ENABLED=1 but missing: ${missing.join(", ")}`);
  }
  return { REDIS_DEPLOYMENT: "memorydb" };
}

async function main() {
  await ensureDockerReady();
  pullImages([
    process.env.REDIS_STANDALONE_IMAGE || "redis:latest",
    process.env.REDIS_TOPOLOGY_IMAGE || "redis:latest",
    process.env.VALKEY_STANDALONE_IMAGE || "valkey/valkey:latest",
    process.env.VALKEY_TOPOLOGY_IMAGE || "valkey/valkey:latest",
  ]);

  const deployments = [
    {
      name: "single-noauth",
      env: unauthEnv("single-noauth"),
      specs: standaloneSpecs(),
      wait: async () => {
        await waitForRedis(noauthOptions(), "single-noauth Redis");
        await logServerVersion(noauthOptions(), "single-noauth", "Redis");
      },
    },
    {
      name: "single-auth",
      env: authEnv("single-auth"),
      specs: standaloneSpecs(),
      wait: async () => {
        await waitForRedis(authOptions(), "single-auth Redis");
        await logServerVersion(authOptions(), "single-auth", "Redis");
      },
    },
    {
      name: "cluster-auth",
      env: Object.assign(authEnv("cluster-auth"), {
        REDIS_CLUSTER_NODES: "127.0.0.1:7000,127.0.0.1:7001",
      }),
      specs: ["test/redis_cluster_deployment_spec.js"],
      wait: async () => {
        await waitForCluster();
        await logServerVersion(authOptions(7000), "cluster-auth", "Redis");
      },
    },
    {
      name: "sentinel-auth",
      env: Object.assign(authEnv("sentinel-auth"), {
        REDIS_SENTINELS: "127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381",
        REDIS_SENTINEL_MASTER_NAME: "mymaster",
      }),
      specs: ["test/redis_sentinel_deployment_spec.js"],
      wait: async () => {
        await waitForSentinel();
        await logServerVersion(authOptions(), "sentinel-auth", "Redis");
      },
    },
    {
      name: "valkey-noauth",
      env: unauthEnv("valkey-noauth"),
      specs: standaloneSpecs(),
      wait: async () => {
        await waitForRedis(noauthOptions(), "valkey-noauth");
        await logServerVersion(noauthOptions(), "valkey-noauth", "Valkey");
      },
    },
    {
      name: "valkey-auth",
      env: authEnv("valkey-auth"),
      specs: standaloneSpecs(),
      wait: async () => {
        await waitForRedis(authOptions(), "valkey-auth");
        await logServerVersion(authOptions(), "valkey-auth", "Valkey");
      },
    },
    {
      name: "valkey-cluster-auth",
      env: Object.assign(authEnv("valkey-cluster-auth"), {
        REDIS_CLUSTER_NODES: "127.0.0.1:7000,127.0.0.1:7001",
      }),
      specs: ["test/redis_cluster_deployment_spec.js"],
      wait: async () => {
        await waitForCluster();
        await logServerVersion(authOptions(7000), "valkey-cluster-auth", "Valkey");
      },
    },
    {
      name: "valkey-sentinel-auth",
      env: Object.assign(authEnv("valkey-sentinel-auth"), {
        REDIS_SENTINELS: "127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381",
        REDIS_SENTINEL_MASTER_NAME: "mymaster",
      }),
      specs: ["test/redis_sentinel_deployment_spec.js"],
      wait: async () => {
        await waitForSentinel();
        await logServerVersion(authOptions(), "valkey-sentinel-auth", "Valkey");
      },
    },
    {
      name: "single-unix",
      env: { REDIS_DEPLOYMENT: "single-unix" },
      specs: ["test/redis_unix_socket_deployment_spec.js"],
      // The socket file needs a real shared filesystem path between the container and this
      // host process (Unix sockets, unlike TCP ports, aren't reachable through Docker's
      // network namespace) — a temporary directory bind-mounted in for this one deployment
      // and removed again afterward, never committed to the repo.
      before: async () => {
        unixSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-contrib-redis-unix-"));
        fs.chmodSync(unixSocketDir, 0o777);
        process.env.REDIS_UNIX_SOCKET_DIR = unixSocketDir;
        process.env.REDIS_UNIX_SOCKET_PATH = path.join(unixSocketDir, "redis.sock");
      },
      wait: async () => {
        await waitForUnixSocket(process.env.REDIS_UNIX_SOCKET_PATH);
        await logServerVersion(
          { path: process.env.REDIS_UNIX_SOCKET_PATH },
          "single-unix",
          "Redis"
        );
      },
      after: async () => {
        delete process.env.REDIS_UNIX_SOCKET_DIR;
        delete process.env.REDIS_UNIX_SOCKET_PATH;
        if (unixSocketDir) {
          fs.rmSync(unixSocketDir, { recursive: true, force: true });
          unixSocketDir = undefined;
        }
      },
    },
  ];

  await runDeployments(deployments);

  const memoryDbEnv = requireMemoryDbEnv();
  if (memoryDbEnv) {
    console.log("\n==> memorydb: running AWS MemoryDB tests");
    runMocha(["test/memorydb_deployment_spec.js"], memoryDbEnv);
  } else {
    console.log("\n==> memorydb: skipped (MEMORYDB_ENABLED is not 1)");
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
