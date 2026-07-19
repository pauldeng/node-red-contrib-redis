var helper = require("node-red-node-test-helper");
var redisNode = require("../redis.js");
var deployment = require("./helpers/deployment");

helper.init(require.resolve("node-red"));

describe("redis-command node", function () {
  this.timeout(5000);

  const ENV_OPTIONS_NAME = "NODE_RED_REDIS_RUNTIME_OPTIONS";
  let originalEnvOptions;

  beforeEach(function (done) {
    originalEnvOptions = process.env[ENV_OPTIONS_NAME];
    process.env[ENV_OPTIONS_NAME] = JSON.stringify(deployment.redisOptions());
    helper.startServer(done);
  });
  afterEach(function (done) {
    helper.unload().then(function () {
      if (originalEnvOptions === undefined) {
        delete process.env[ENV_OPTIONS_NAME];
      } else {
        process.env[ENV_OPTIONS_NAME] = originalEnvOptions;
      }
      helper.stopServer(done);
    });
  });

  it("should SET hello=world and GET hello returning world", function (done) {
    var flow = [
      deployment.redisConfigNode("config1", "Local"),
      {
        id: "set-node",
        type: "redis-command",
        server: "config1",
        command: "SET",
        name: "SET",
        topic: "",
        params: "[]",
        wires: [["set-helper"]],
      },
      { id: "set-helper", type: "helper" },
      {
        id: "get-node",
        type: "redis-command",
        server: "config1",
        command: "GET",
        name: "GET",
        topic: "",
        params: "[]",
        wires: [["get-helper"]],
      },
      { id: "get-helper", type: "helper" },
      {
        id: "del-node",
        type: "redis-command",
        server: "config1",
        command: "DEL",
        name: "DEL",
        topic: "",
        params: "[]",
        wires: [["del-helper"]],
      },
      { id: "del-helper", type: "helper" },
    ];

    helper.load(redisNode, flow, function () {
      var setNode = helper.getNode("set-node");
      var setHelper = helper.getNode("set-helper");
      var getNode = helper.getNode("get-node");
      var getHelper = helper.getNode("get-helper");
      var delNode = helper.getNode("del-node");
      var delHelper = helper.getNode("del-helper");

      delHelper.on("input", function () {
        done();
      });

      getHelper.on("input", function (msg) {
        try {
          msg.payload.should.equal("world");
          delNode.receive({ topic: "hello" });
        } catch (err) {
          done(err);
        }
      });

      // After SET completes (payload = "OK"), trigger the GET flow
      setHelper.on("input", function () {
        getNode.receive({ topic: "hello" });
      });

      // Flow 1: inject { topic: "hello", payload: "world" } → SET
      setNode.receive({ topic: "hello", payload: "world" });
    });
  });

  it("should read redis-config options from an environment variable", function (done) {
    var flow = [
      {
        id: "config-env",
        type: "redis-config",
        name: "EnvConn",
        options: ENV_OPTIONS_NAME,
        optionsType: "env",
        cluster: false,
      },
      {
        id: "set-node",
        type: "redis-command",
        server: "config-env",
        command: "SET",
        name: "SET",
        topic: "",
        params: "[]",
        wires: [["set-helper"]],
      },
      { id: "set-helper", type: "helper" },
      {
        id: "get-node",
        type: "redis-command",
        server: "config-env",
        command: "GET",
        name: "GET",
        topic: "",
        params: "[]",
        wires: [["get-helper"]],
      },
      { id: "get-helper", type: "helper" },
      {
        id: "del-node",
        type: "redis-command",
        server: "config-env",
        command: "DEL",
        name: "DEL",
        topic: "",
        params: "[]",
        wires: [["del-helper"]],
      },
      { id: "del-helper", type: "helper" },
    ];

    helper.load(redisNode, flow, function () {
      var setNode = helper.getNode("set-node");
      var setHelper = helper.getNode("set-helper");
      var getNode = helper.getNode("get-node");
      var getHelper = helper.getNode("get-helper");
      var delNode = helper.getNode("del-node");
      var delHelper = helper.getNode("del-helper");
      var key = "test:env-options:hello";

      delHelper.on("input", function () {
        done();
      });

      getHelper.on("input", function (msg) {
        try {
          msg.payload.should.equal("env-world");
          delNode.receive({ topic: key });
        } catch (err) {
          done(err);
        }
      });

      setHelper.on("input", function () {
        getNode.receive({ topic: key });
      });

      setNode.receive({ topic: key, payload: "env-world" });
    });
  });

  // ── connection isolation ─────────────────────────────────────────────────
  // Historical bug (fixed): redis-command pooled its non-blocking client keyed by the
  // config node's *display name* (`this.server.name`), which defaults to "Local" and is
  // user-editable. Two configs with different ids but the same name silently shared one
  // client, so a redis-command node pointed at one DB could end up reading/writing another.
  // The invariant this test protects: the pool is keyed by the config-node id (`n.server`),
  // which is unique and immutable regardless of display name.
  it("routes a redis-command SET to its own config's DB even when both configs share the default name 'Local'", async function () {
    var key = "test:command:conntest:samename";
    var flow = [
      deployment.redisConfigNode("cfg-cmd-samename-db0", "Local", { db: 0 }),
      deployment.redisConfigNode("cfg-cmd-samename-db1", "Local", { db: 1 }),
      // Constructed first: seeds the pool with a db-0 client under its own config id.
      {
        id: "set-db0",
        type: "redis-command",
        server: "cfg-cmd-samename-db0",
        command: "SET",
        name: "SET",
        topic: "",
        params: "[]",
        wires: [],
      },
      // Points at db 1 — must not reuse the db-0 client above.
      {
        id: "set-db1",
        type: "redis-command",
        server: "cfg-cmd-samename-db1",
        command: "SET",
        name: "SET",
        topic: "",
        params: "[]",
        wires: [["set-db1-helper"]],
      },
      { id: "set-db1-helper", type: "helper" },
    ];

    await helper.load(redisNode, flow);
    var setDb1 = helper.getNode("set-db1");
    var setDb1Helper = helper.getNode("set-db1-helper");
    var written = new Promise((resolve) => setDb1Helper.once("input", resolve));

    setDb1.receive({ topic: key, payload: "valueB" });
    await written;

    var probe0 = deployment.directRedis({ db: 0 });
    var probe1 = deployment.directRedis({ db: 1 });
    var inDb0, inDb1;
    try {
      [inDb0, inDb1] = await Promise.all([probe0.get(key), probe1.get(key)]);
      await Promise.all([probe0.del(key), probe1.del(key)]);
    } finally {
      probe0.disconnect();
      probe1.disconnect();
    }

    if (inDb1 !== "valueB") {
      throw new Error(
        "redis-command node pointed at db 1 should write to db 1 (got db1=" +
          JSON.stringify(inDb1) +
          ", db0=" +
          JSON.stringify(inDb0) +
          "). If the value landed in db 0, the two default-named 'Local' " +
          "configs are sharing one pooled connection."
      );
    }
  });

  // ── payload/argument handling ────────────────────────────────────────────
  // `msg.payload` is explicit iff `!== undefined && !== null`. Explicit scalars
  // (including falsy ones: 0, false, "") and explicit non-empty arrays/objects
  // become the command's arguments; undefined/null/absent fall back to the
  // node's configured static Params. Historically `if (msg.payload)` dropped
  // 0/false/"" entirely, and a `typeof`-only switch silently ignored numbers
  // and booleans altogether (ignored even when truthy, e.g. 5 or true).
  describe("payload/argument handling", function () {
    function makeCmdFlow(command, topic, params) {
      return [
        deployment.redisConfigNode("cfg-argh", "Local"),
        {
          id: "cmd",
          type: "redis-command",
          server: "cfg-argh",
          command: command,
          name: command,
          topic: topic,
          params: params !== undefined ? params : "[]",
          wires: [["cmd-helper"]],
        },
        { id: "cmd-helper", type: "helper" },
      ];
    }

    const scalarCases = [
      { label: "0 (falsy number)", payload: 0, expected: "0" },
      { label: "false (falsy boolean)", payload: false, expected: "false" },
      { label: '"" (empty string)', payload: "", expected: "" },
      { label: "5 (truthy number)", payload: 5, expected: "5" },
      { label: "true (truthy boolean)", payload: true, expected: "true" },
    ];

    scalarCases.forEach(function (c) {
      it(
        "SET treats explicit payload " +
          c.label +
          " as the value (not dropped, not Params fallback)",
        async function () {
          const key = "test:command:argh:scalar:" + encodeURIComponent(JSON.stringify(c.payload));
          await helper.load(
            redisNode,
            makeCmdFlow("SET", key, JSON.stringify(["should-not-be-used"]))
          );
          const cmd = helper.getNode("cmd");
          const cmdHelper = helper.getNode("cmd-helper");
          const received = new Promise((resolve) => cmdHelper.once("input", resolve));

          cmd.receive({ topic: key, payload: c.payload });
          await received;

          const probe = deployment.directRedis();
          try {
            (await probe.get(key)).should.equal(c.expected);
          } finally {
            await probe.del(key);
            probe.disconnect();
          }
        }
      );
    });

    [
      { label: "undefined", send: { includePayload: true, payload: undefined } },
      { label: "null", send: { includePayload: true, payload: null } },
      { label: "absent", send: { includePayload: false } },
    ].forEach(function (c) {
      it("SET falls back to configured Params when payload is " + c.label, async function () {
        const key = "test:command:argh:fallback:" + c.label;
        await helper.load(redisNode, makeCmdFlow("SET", key, JSON.stringify(["fallback-value"])));
        const cmd = helper.getNode("cmd");
        const cmdHelper = helper.getNode("cmd-helper");
        const received = new Promise((resolve) => cmdHelper.once("input", resolve));
        const msg = { topic: key };
        if (c.send.includePayload) {
          msg.payload = c.send.payload;
        }

        cmd.receive(msg);
        await received;

        const probe = deployment.directRedis();
        try {
          (await probe.get(key)).should.equal("fallback-value");
        } finally {
          await probe.del(key);
          probe.disconnect();
        }
      });
    });

    // Static Params contract (msg.payload absent, so Params is the sole argument source):
    // an array expands to multiple arguments; a string/number/boolean Params value is one
    // argument (including falsy 0/false/""); null retains its historical meaning of "no
    // static argument" rather than becoming an ioredis-stringified empty-string argument.
    const scalarParamsCases = [
      { label: "array Params", paramsValue: ["static-value"], expectStored: "static-value" },
      { label: "string Params", paramsValue: "static-value", expectStored: "static-value" },
      { label: "number Params", paramsValue: 5, expectStored: "5" },
      { label: "boolean Params", paramsValue: true, expectStored: "true" },
      { label: "0 Params", paramsValue: 0, expectStored: "0" },
      { label: "false Params", paramsValue: false, expectStored: "false" },
      { label: 'empty-string Params (JSON "")', paramsValue: "", expectStored: "" },
    ];

    scalarParamsCases.forEach(function (c) {
      it("SET applies static " + c.label + " as the value", async function () {
        const key = "test:command:argh:staticparams:" + c.label.replace(/[^a-z0-9]/gi, "");
        await helper.load(redisNode, makeCmdFlow("SET", key, JSON.stringify(c.paramsValue)));
        const cmd = helper.getNode("cmd");
        const cmdHelper = helper.getNode("cmd-helper");
        const received = new Promise((resolve) => cmdHelper.once("input", resolve));

        cmd.receive({ topic: key });
        await received;

        const probe = deployment.directRedis();
        try {
          (await probe.get(key)).should.equal(c.expectStored);
        } finally {
          await probe.del(key);
          probe.disconnect();
        }
      });
    });

    it("null Params contributes no static argument (not an ioredis-stringified empty string)", async function () {
      const key = "test:command:argh:staticparams:null";
      const probe = deployment.directRedis();
      await probe.set(key, "seeded-value");
      try {
        await helper.load(redisNode, makeCmdFlow("GET", key, JSON.stringify(null)));
        const cmd = helper.getNode("cmd");
        const cmdHelper = helper.getNode("cmd-helper");
        const received = new Promise((resolve) => cmdHelper.once("input", resolve));

        cmd.receive({ topic: key });
        const msg = await received;

        // If null had leaked in as an extra empty-string argument, GET would receive two
        // arguments and error instead of returning the seeded value.
        msg.payload.should.equal("seeded-value");
      } finally {
        await probe.del(key);
        probe.disconnect();
      }
    });

    // Characterization: [] and {} are ALREADY (before this task) explicit
    // zero-argument payloads that suppress Params — GET only accepts one
    // argument, so if either leaked an extra Params-derived argument or a
    // stringified "[object Object]", the command would error.
    [
      { label: "[] (empty array)", payload: [] },
      { label: "{} (empty object)", payload: {} },
    ].forEach(function (c) {
      it(
        "GET treats explicit payload " +
          c.label +
          " as a zero-argument payload (suppresses Params)",
        async function () {
          const key = "test:command:argh:zeroarg:" + c.label.replace(/[^a-z]/gi, "");
          const probe = deployment.directRedis();
          await probe.set(key, "seeded-value");
          try {
            await helper.load(
              redisNode,
              makeCmdFlow("GET", key, JSON.stringify(["should-not-be-used"]))
            );
            const cmd = helper.getNode("cmd");
            const cmdHelper = helper.getNode("cmd-helper");
            const received = new Promise((resolve) => cmdHelper.once("input", resolve));

            cmd.receive({ topic: key, payload: c.payload });
            const msg = await received;

            cmd.error.callCount.should.equal(0);
            msg.payload.should.equal("seeded-value");
          } finally {
            await probe.del(key);
            probe.disconnect();
          }
        }
      );
    });

    it("calls node.error (not a silent bare command) when configured Params is malformed JSON", async function () {
      const key = "test:command:argh:malformed-params";
      await helper.load(redisNode, makeCmdFlow("SET", key, "{not valid json"));
      const cmd = helper.getNode("cmd");
      const errored = new Promise((resolve) => cmd.once("call:error", resolve));

      cmd.receive({ topic: key });
      await errored;

      cmd.error.callCount.should.be.above(0);
      String(cmd.error.firstCall.args[0]).should.match(/Params.*JSON/i);
    });

    // ioredis registers the HSET/MSET field-value argument transform under the exact
    // lowercase command name (ioredis Command.js). The editor now saves/suggests uppercase
    // command names, so both cases must apply the transform for a non-empty object payload.
    [
      { label: "uppercase", command: "HSET" },
      { label: "lowercase", command: "hset" },
    ].forEach(function (c) {
      it("HSET (" + c.label + ") applies the field/value object transform", async function () {
        const key = "test:command:argh:hset:" + c.label;
        await helper.load(redisNode, makeCmdFlow(c.command, key, "[]"));
        const cmd = helper.getNode("cmd");
        const cmdHelper = helper.getNode("cmd-helper");
        const received = new Promise((resolve) => cmdHelper.once("input", resolve));

        cmd.receive({ topic: key, payload: { field1: "val1", field2: "val2" } });
        await received;

        const probe = deployment.directRedis();
        try {
          const stored = await probe.hgetall(key);
          stored.should.deepEqual({ field1: "val1", field2: "val2" });
        } finally {
          await probe.del(key);
          probe.disconnect();
        }
      });
    });

    [
      { label: "uppercase", command: "MSET" },
      { label: "lowercase", command: "mset" },
    ].forEach(function (c) {
      it("MSET (" + c.label + ") applies the field/value object transform", async function () {
        await helper.load(redisNode, makeCmdFlow(c.command, "", "[]"));
        const cmd = helper.getNode("cmd");
        const cmdHelper = helper.getNode("cmd-helper");
        const received = new Promise((resolve) => cmdHelper.once("input", resolve));
        const keyA = "test:command:argh:mset:" + c.label + ":a";
        const keyB = "test:command:argh:mset:" + c.label + ":b";

        cmd.receive({ payload: { [keyA]: "1", [keyB]: "2" } });
        await received;

        const probe = deployment.directRedis();
        try {
          const stored = await probe.mget(keyA, keyB);
          stored.should.eql(["1", "2"]);
        } finally {
          await probe.del(keyA, keyB);
          probe.disconnect();
        }
      });
    });
  });
});
