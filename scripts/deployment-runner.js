"use strict";

// Shared Docker-deployment mechanics for npm test. Deployment definitions belong in the
// entry-point script; this module owns orchestration and image preparation.

const path = require("path");
const { spawnSync } = require("child_process");
const Redis = require("ioredis");

const ROOT = path.resolve(__dirname, "..");
const MOCHA = path.join(ROOT, "node_modules", ".bin", "mocha");
const AUTH_USERNAME = "node_red";
const AUTH_PASSWORD = "node-red-pass";
let DOCKER_COMMAND = ["docker"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, options.env || {}),
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function tryRun(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  return !result.error && result.status === 0;
}

function canRun(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quietRedis(client) {
  client.on("error", () => {});
  return client;
}

function dockerCompose(name, args) {
  return [
    "compose",
    "-p",
    `node-red-contrib-redis-${name}`,
    "-f",
    path.join("test", "deployments", name, "compose.yml"),
    ...args,
  ];
}

function runDocker(args) {
  run(DOCKER_COMMAND[0], DOCKER_COMMAND.slice(1).concat(args));
}

function pullImages(images) {
  for (const image of new Set(images.filter(Boolean))) {
    console.log(`==> pulling ${image}`);
    runDocker(["pull", image]);
  }
}

function tryDocker(args) {
  return tryRun(DOCKER_COMMAND[0], DOCKER_COMMAND.slice(1).concat(args));
}

function resolveDockerCommand() {
  if (canRun("docker", ["info"]) && canRun("docker", ["compose", "version"])) {
    return ["docker"];
  }
  if (
    canRun("sudo", ["-n", "docker", "info"]) &&
    canRun("sudo", ["-n", "docker", "compose", "version"])
  ) {
    return ["sudo", "-n", "docker"];
  }
  return ["docker"];
}

async function ensureDockerReady() {
  run("bash", [path.join("scripts", "ensure-docker-ubuntu.sh")]);
  DOCKER_COMMAND = resolveDockerCommand();
}

function authEnv(name) {
  return {
    REDIS_DEPLOYMENT: name,
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "6379",
    REDIS_USERNAME: AUTH_USERNAME,
    REDIS_PASSWORD: AUTH_PASSWORD,
  };
}

function unauthEnv(name) {
  return {
    REDIS_DEPLOYMENT: name,
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "6379",
  };
}

function authOptions(port = 6379) {
  return {
    host: "127.0.0.1",
    port,
    username: AUTH_USERNAME,
    password: AUTH_PASSWORD,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  };
}

function noauthOptions(port = 6379) {
  return {
    host: "127.0.0.1",
    port,
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  };
}

async function waitForRedis(options, label) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    const client = quietRedis(new Redis(options));
    try {
      await client.ping();
      client.disconnect();
      return;
    } catch (err) {
      lastError = err;
      client.disconnect();
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError && lastError.message}`);
}

// Valkey's INFO server reports `redis_version` as a client-compatibility stand-in, not its
// actual version. The real version is under `valkey_version`, alongside server_name:valkey.
async function logServerVersion(options, label, expectedEngine) {
  const client = quietRedis(new Redis(options));
  try {
    const info = await client.call("INFO", "server");
    const isValkey = /(?:^|\n)server_name:valkey/.test(info);
    const engine = isValkey ? "Valkey" : "Redis";
    if (expectedEngine && engine !== expectedEngine) {
      throw new Error(`${label} expected ${expectedEngine}, received ${engine}`);
    }
    const field = isValkey ? "valkey_version" : "redis_version";
    const match = new RegExp(`${field}:(\\S+)`).exec(info);
    const version = match ? match[1] : "(unknown)";
    console.log(`==> ${label}: ${engine} ${version}`);
    return { engine, version };
  } finally {
    client.disconnect();
  }
}

function runMocha(specs, env) {
  run(MOCHA, specs, { env });
}

async function runDeployment(deployment) {
  console.log(`\n==> ${deployment.name}: starting Docker deployment`);
  tryDocker(dockerCompose(deployment.name, ["down", "-v", "--remove-orphans"]));
  try {
    if (deployment.before) {
      await deployment.before();
    }
    runDocker(dockerCompose(deployment.name, ["up", "-d"]));
    await deployment.wait();
    console.log(`==> ${deployment.name}: running tests`);
    runMocha(deployment.specs, deployment.env);
  } finally {
    console.log(`==> ${deployment.name}: tearing down Docker deployment`);
    tryDocker(dockerCompose(deployment.name, ["down", "-v", "--remove-orphans"]));
    if (deployment.after) {
      await deployment.after();
    }
  }
}

async function runDeployments(deployments) {
  for (const deployment of deployments) {
    await runDeployment(deployment);
  }
}

module.exports = {
  AUTH_PASSWORD,
  AUTH_USERNAME,
  ROOT,
  authEnv,
  authOptions,
  ensureDockerReady,
  logServerVersion,
  noauthOptions,
  pullImages,
  quietRedis,
  runDeployment,
  runDeployments,
  runMocha,
  sleep,
  unauthEnv,
  waitForRedis,
};
