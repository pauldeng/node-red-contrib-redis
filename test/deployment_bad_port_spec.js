"use strict";

const net = require("net");
const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");

const HELPER = path.join(__dirname, "helpers", "deployment.js");
const DEFAULT_BAD_PORT = 6399;

function loadHelperInChild(env) {
  const script =
    "const h=require(" +
    JSON.stringify(HELPER) +
    ");" +
    "const o=h.badRedisOptions();" +
    "process.stdout.write(JSON.stringify({port:o.port,host:o.host}));";
  const childEnv = Object.assign({}, process.env, env);
  // Treat empty REDIS_BAD_PORT as unset so the auto-pick path is exercised.
  if (childEnv.REDIS_BAD_PORT === "") {
    delete childEnv.REDIS_BAD_PORT;
  }
  return spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: childEnv,
  });
}

function listenOrAcceptOccupied(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        // Something else already owns the port — that is the scenario under test.
        resolve({ server: null, owned: false });
        return;
      }
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, owned: true });
    });
  });
}

describe("deployment helper unreachable-host port", function () {
  this.timeout(5000);

  it("fails loudly when an explicit REDIS_BAD_PORT is reachable", async function () {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const result = loadHelperInChild({
        REDIS_BAD_PORT: String(port),
        REDIS_BAD_HOST: "127.0.0.1",
      });
      assert.notStrictEqual(result.status, 0, "helper load must fail");
      assert.match(
        String(result.stderr || "") + String(result.stdout || ""),
        /REDIS_BAD_PORT=.*is reachable/
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("auto-picks a free port when the default 6399 is occupied", async function () {
    const { server, owned } = await listenOrAcceptOccupied(DEFAULT_BAD_PORT);
    try {
      const result = loadHelperInChild({
        REDIS_BAD_HOST: "127.0.0.1",
        REDIS_BAD_PORT: "",
      });
      assert.strictEqual(
        result.status,
        0,
        "helper load should succeed: " + (result.stderr || result.stdout)
      );
      const chosen = JSON.parse(result.stdout);
      assert.notStrictEqual(chosen.port, DEFAULT_BAD_PORT, "must not reuse the occupied default");
      assert.strictEqual(typeof chosen.port, "number");
      assert.ok(chosen.port > 0);
    } finally {
      if (owned && server) {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});
