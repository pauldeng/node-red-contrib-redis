const helper = require("node-red-node-test-helper");
const redisNode = require("../redis.js");
const { cleanupKeys } = require("./helpers/cleanup");
const { directRedis, redisConfigNode } = require("./helpers/deployment");
const { waitForNodeProp } = require("./helpers/wait");

helper.init(require.resolve("node-red"));

// Awaitable bridges over the Node-RED test-helper event API.
function loadFlowAsync(flow) {
  return new Promise((resolve) => helper.load(redisNode, flow, resolve));
}

function nextMessage(sink) {
  return new Promise((resolve) => sink.once("input", resolve));
}

function nextError(node) {
  return new Promise((resolve) => node.once("call:error", (call) => resolve(call.args[0])));
}

describe("Scripting commands", function () {
  this.timeout(5000);

  const configNode = redisConfigNode("config1", "Local");

  beforeEach(async () => {
    await new Promise((resolve) => helper.startServer(resolve));
  });

  afterEach(async () => {
    await helper.unload();
    await new Promise((resolve) => helper.stopServer(resolve));
    await new Promise((resolve, reject) =>
      cleanupKeys("test:script:*", (err) => (err ? reject(err) : resolve()))
    );
  });

  it("should EVAL execute a Lua script and return result", function (done) {
    const flow = [
      configNode,
      {
        id: "eval-node",
        type: "redis-command",
        server: "config1",
        command: "EVAL",
        name: "EVAL",
        topic: "",
        params: "[]",
        wires: [["eval-helper"]],
      },
      { id: "eval-helper", type: "helper" },
    ];

    helper.load(redisNode, flow, () => {
      const evalNode = helper.getNode("eval-node");
      const evalHelper = helper.getNode("eval-helper");

      evalHelper.on("input", (msg) => {
        try {
          msg.payload.should.equal("hello");
          done();
        } catch (err) {
          done(err);
        }
      });

      evalNode.receive({ payload: ["return 'hello'", "0"] });
    });
  });

  it("should EVAL_RO execute a read-only Lua script", function (done) {
    const flow = [
      configNode,
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
        id: "evalro-node",
        type: "redis-command",
        server: "config1",
        command: "EVAL_RO",
        name: "EVAL_RO",
        topic: "",
        params: "[]",
        wires: [["evalro-helper"]],
      },
      { id: "evalro-helper", type: "helper" },
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

    helper.load(redisNode, flow, () => {
      const setNode = helper.getNode("set-node");
      const setHelper = helper.getNode("set-helper");
      const evalroNode = helper.getNode("evalro-node");
      const evalroHelper = helper.getNode("evalro-helper");
      const delNode = helper.getNode("del-node");
      const delHelper = helper.getNode("del-helper");

      delHelper.on("input", () => {
        done();
      });

      evalroHelper.on("input", (msg) => {
        try {
          msg.payload.should.equal("world");
          delNode.receive({ topic: "test:script:evalro" });
        } catch (err) {
          done(err);
        }
      });

      setHelper.on("input", () => {
        evalroNode.receive({
          payload: ["return redis.call('GET',KEYS[1])", "1", "test:script:evalro"],
        });
      });

      setNode.receive({ topic: "test:script:evalro", payload: "world" });
    });
  });

  it("should SCRIPT LOAD return SHA1 and EVALSHA execute it", function (done) {
    const flow = [
      configNode,
      {
        id: "scriptload-node",
        type: "redis-command",
        server: "config1",
        command: "SCRIPT",
        name: "SCRIPT",
        topic: "",
        params: "[]",
        wires: [["scriptload-helper"]],
      },
      { id: "scriptload-helper", type: "helper" },
      {
        id: "evalsha-node",
        type: "redis-command",
        server: "config1",
        command: "EVALSHA",
        name: "EVALSHA",
        topic: "",
        params: "[]",
        wires: [["evalsha-helper"]],
      },
      { id: "evalsha-helper", type: "helper" },
    ];

    helper.load(redisNode, flow, () => {
      const scriptloadNode = helper.getNode("scriptload-node");
      const scriptloadHelper = helper.getNode("scriptload-helper");
      const evalshaNode = helper.getNode("evalsha-node");
      const evalshaHelper = helper.getNode("evalsha-helper");

      evalshaHelper.on("input", (msg) => {
        try {
          msg.payload.should.equal("scripted");
          done();
        } catch (err) {
          done(err);
        }
      });

      scriptloadHelper.on("input", (msg) => {
        try {
          const sha1 = msg.payload;
          sha1.should.be.a.String();
          sha1.length.should.equal(40);
          evalshaNode.receive({ topic: sha1, payload: "0" });
        } catch (err) {
          done(err);
        }
      });

      scriptloadNode.receive({ payload: ["LOAD", "return 'scripted'"] });
    });
  });

  it("should SCRIPT EXISTS return 1 for a loaded script", function (done) {
    const flow = [
      configNode,
      {
        id: "scriptload-node",
        type: "redis-command",
        server: "config1",
        command: "SCRIPT",
        name: "SCRIPT_LOAD",
        topic: "",
        params: "[]",
        wires: [["scriptload-helper"]],
      },
      { id: "scriptload-helper", type: "helper" },
      {
        id: "scriptexists-node",
        type: "redis-command",
        server: "config1",
        command: "SCRIPT",
        name: "SCRIPT_EXISTS",
        topic: "",
        params: "[]",
        wires: [["scriptexists-helper"]],
      },
      { id: "scriptexists-helper", type: "helper" },
    ];

    helper.load(redisNode, flow, () => {
      const scriptloadNode = helper.getNode("scriptload-node");
      const scriptloadHelper = helper.getNode("scriptload-helper");
      const scriptexistsNode = helper.getNode("scriptexists-node");
      const scriptexistsHelper = helper.getNode("scriptexists-helper");

      scriptexistsHelper.on("input", (msg) => {
        try {
          msg.payload.should.be.an.Array();
          msg.payload[0].should.equal(1);
          done();
        } catch (err) {
          done(err);
        }
      });

      scriptloadHelper.on("input", (msg) => {
        try {
          const sha = msg.payload;
          scriptexistsNode.receive({ payload: ["EXISTS", sha] });
        } catch (err) {
          done(err);
        }
      });

      scriptloadNode.receive({ payload: ["LOAD", "return 1"] });
    });
  });

  // ── redis-lua-script node: stored scripts (EVALSHA) and NOSCRIPT fallback ──

  it("redis-lua-script (stored) reports SCRIPT LOAD compile errors via node.error", async function () {
    // Function-mode loadLibrary already surfaces FUNCTION LOAD failures; stored
    // SCRIPT LOAD must do the same — a red status alone is not actionable.
    const flow = [
      configNode,
      {
        id: "bad-load-node",
        type: "redis-lua-script",
        server: "config1",
        name: "bad-load",
        func: "this is not ( valid lua",
        keyval: 0,
        stored: true,
        mode: "script",
        block: false,
        wires: [["bad-load-helper"]],
      },
      { id: "bad-load-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const node = helper.getNode("bad-load-node");
    // Wait for the loader to finish (red status), then assert the error was logged.
    const start = Date.now();
    while (true) {
      const last = node.status.lastCall && node.status.lastCall.args[0];
      if (last && last.text === "script not loaded") {
        break;
      }
      if (Date.now() - start > 4000) {
        throw new Error("expected red 'script not loaded' status after a failed SCRIPT LOAD");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    node.error.callCount.should.be.above(
      0,
      "SCRIPT LOAD failure must be reported via node.error, not only status"
    );
    String(node.error.firstCall.args[0]).should.match(/ERR|compil/i);
  });

  it("redis-lua-script with Keys=0 sends no ARGV when payload is absent or null", async function () {
    const flow = [
      configNode,
      {
        id: "argv0-node",
        type: "redis-lua-script",
        server: "config1",
        name: "argv0",
        func: "return #ARGV",
        keyval: 0,
        stored: false,
        mode: "script",
        block: false,
        wires: [["argv0-helper"]],
      },
      { id: "argv0-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const node = helper.getNode("argv0-node");
    const sink = helper.getNode("argv0-helper");

    const absentP = nextMessage(sink);
    node.receive({ topic: "" });
    (await absentP).payload.should.equal(0);

    const nullP = nextMessage(sink);
    node.receive({ topic: "", payload: null });
    (await nullP).payload.should.equal(0);

    const emptyP = nextMessage(sink);
    node.receive({ topic: "", payload: [] });
    (await emptyP).payload.should.equal(0);
  });

  it("redis-lua-script with Keys=0 rejects a non-array object payload", async function () {
    const flow = [
      configNode,
      {
        id: "obj-payload-node",
        type: "redis-lua-script",
        server: "config1",
        name: "obj-payload",
        func: "return #ARGV",
        keyval: 0,
        stored: false,
        mode: "script",
        block: false,
        wires: [["obj-payload-helper"]],
      },
      { id: "obj-payload-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const node = helper.getNode("obj-payload-node");
    const errP = nextError(node);
    node.receive({ topic: "", payload: { a: 1 } });
    String(await errP).should.match(/Payload is not Array/i);
  });

  it("redis-lua-script with Keys=0 accepts a Buffer as a single ARGV", async function () {
    const flow = [
      configNode,
      {
        id: "buf-payload-node",
        type: "redis-lua-script",
        server: "config1",
        name: "buf-payload",
        func: "return {#ARGV, ARGV[1]}",
        keyval: 0,
        stored: false,
        mode: "script",
        block: false,
        wires: [["buf-payload-helper"]],
      },
      { id: "buf-payload-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const node = helper.getNode("buf-payload-node");
    const sink = helper.getNode("buf-payload-helper");
    const msgP = nextMessage(sink);
    node.receive({ topic: "", payload: Buffer.from("bin-arg") });
    const msg = await msgP;
    msg.payload[0].should.equal(1);
    msg.payload[1].should.equal("bin-arg");
  });

  it("redis-lua-script (stored) executes via EVALSHA and returns result", async function () {
    const flow = [
      configNode,
      {
        id: "lua-node",
        type: "redis-lua-script",
        server: "config1",
        name: "LUA",
        func: "return 'stored-ok'",
        keyval: 0,
        stored: true,
        block: false,
        wires: [["lua-helper"]],
      },
      { id: "lua-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const luaNode = helper.getNode("lua-node");
    const luaHelper = helper.getNode("lua-helper");
    await waitForNodeProp(luaNode, "sha1");

    const msgP = nextMessage(luaHelper);
    luaNode.receive({ payload: [] });
    const msg = await msgP;

    msg.payload.should.equal("stored-ok");
    // EVALSHA is the command used when the SHA1 is cached.
    luaNode.command.should.equal("evalsha");
  });

  it("redis-lua-script (stored) falls back to EVAL on NOSCRIPT", async function () {
    const flow = [
      configNode,
      {
        id: "lua-node",
        type: "redis-lua-script",
        server: "config1",
        name: "LUA",
        func: "return 'fallback-ok'",
        keyval: 0,
        stored: true,
        block: false,
        wires: [["lua-helper"]],
      },
      { id: "lua-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const luaNode = helper.getNode("lua-node");
    const luaHelper = helper.getNode("lua-helper");
    await waitForNodeProp(luaNode, "sha1");

    // Evict every cached script from Redis so the node's SHA1 is no longer
    // known — the next EVALSHA must return a NOSCRIPT error.
    const flushClient = directRedis();
    try {
      await flushClient.script("flush");
    } finally {
      flushClient.disconnect();
    }

    const msgP = nextMessage(luaHelper);
    luaNode.receive({ payload: [] });
    const msg = await msgP;

    // Even though EVALSHA failed with NOSCRIPT, the script still ran because
    // the node re-sent the body via EVAL.
    msg.payload.should.equal("fallback-ok");
    luaNode.command.should.equal("eval");
  });

  it("redis-lua-script runs EVAL_RO when read-only is set", async function () {
    const seed = directRedis();
    try {
      await seed.set("test:script:ro", "ro-value");
      const flow = [
        configNode,
        {
          id: "luaro-node",
          type: "redis-lua-script",
          server: "config1",
          name: "luaro",
          mode: "script",
          readonly: true,
          stored: false,
          keyval: 1,
          func: "return redis.call('GET', KEYS[1])",
          block: false,
          wires: [["luaro-helper"]],
        },
        { id: "luaro-helper", type: "helper" },
      ];
      await loadFlowAsync(flow);
      const node = helper.getNode("luaro-node");
      const sink = helper.getNode("luaro-helper");

      const msgP = nextMessage(sink);
      node.receive({ payload: ["test:script:ro"] });
      const msg = await msgP;

      msg.payload.should.equal("ro-value");
      node.command.should.equal("eval_ro");
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script runs EVALSHA_RO and falls back to EVAL_RO after SCRIPT FLUSH", async function () {
    const seed = directRedis();
    try {
      await seed.set("test:script:sharo", "sha-value");
      const flow = [
        configNode,
        {
          id: "sharo-node",
          type: "redis-lua-script",
          server: "config1",
          name: "sharo",
          mode: "script",
          readonly: true,
          stored: true,
          keyval: 1,
          func: "return redis.call('GET', KEYS[1])",
          block: false,
          wires: [["sharo-helper"]],
        },
        { id: "sharo-helper", type: "helper" },
      ];
      await loadFlowAsync(flow);
      const node = helper.getNode("sharo-node");
      const sink = helper.getNode("sharo-helper");
      await waitForNodeProp(node, "sha1");

      const firstP = nextMessage(sink);
      node.receive({ payload: ["test:script:sharo"] });
      const first = await firstP;
      first.payload.should.equal("sha-value");
      node.command.should.equal("evalsha_ro");

      // Evict the cached script, then re-fire to force NOSCRIPT -> EVAL_RO.
      await seed.script("flush");
      const secondP = nextMessage(sink);
      node.receive({ payload: ["test:script:sharo"] });
      const second = await secondP;
      second.payload.should.equal("sha-value");
      node.command.should.equal("eval_ro");
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script loads a library and runs FCALL", async function () {
    const lib = [
      "#!lua name=testlib",
      "redis.register_function('testfn', function(keys, args) return redis.call('GET', keys[1]) end)",
    ].join("\n");
    const seed = directRedis();
    try {
      await seed.function("flush");
      await seed.set("test:script:fcall", "fn-value");
      const flow = [
        configNode,
        {
          id: "fcall-node",
          type: "redis-lua-script",
          server: "config1",
          name: "fcall",
          mode: "function",
          readonly: false,
          keyval: 1,
          func: lib,
          fname: "testfn",
          block: false,
          wires: [["fcall-helper"]],
        },
        { id: "fcall-helper", type: "helper" },
      ];
      await loadFlowAsync(flow);
      const node = helper.getNode("fcall-node");
      const sink = helper.getNode("fcall-helper");
      await waitForNodeProp(node, "libname");

      const msgP = nextMessage(sink);
      node.receive({ payload: ["test:script:fcall"] });
      const msg = await msgP;

      msg.payload.should.equal("fn-value");
      node.command.should.equal("fcall");
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script runs FCALL_RO for a no-writes function", async function () {
    const lib = [
      "#!lua name=testlibro",
      "redis.register_function{function_name='testfnro', callback=function(keys, args) return redis.call('GET', keys[1]) end, flags={'no-writes'}}",
    ].join("\n");
    const seed = directRedis();
    try {
      await seed.function("flush");
      await seed.set("test:script:fcallro", "ro-fn-value");
      const flow = [
        configNode,
        {
          id: "fcallro-node",
          type: "redis-lua-script",
          server: "config1",
          name: "fcallro",
          mode: "function",
          readonly: true,
          keyval: 1,
          func: lib,
          fname: "testfnro",
          block: false,
          wires: [["fcallro-helper"]],
        },
        { id: "fcallro-helper", type: "helper" },
      ];
      await loadFlowAsync(flow);
      const node = helper.getNode("fcallro-node");
      const sink = helper.getNode("fcallro-helper");
      await waitForNodeProp(node, "libname");

      const msgP = nextMessage(sink);
      node.receive({ payload: ["test:script:fcallro"] });
      const msg = await msgP;

      msg.payload.should.equal("ro-fn-value");
      node.command.should.equal("fcall_ro");
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script reloads its library and retries FCALL after FUNCTION FLUSH", async function () {
    const lib = [
      "#!lua name=testlibrecover",
      "redis.register_function('recoverfn', function(keys, args) return redis.call('GET', keys[1]) end)",
    ].join("\n");
    const seed = directRedis();
    try {
      await seed.function("flush");
      await seed.set("test:script:rec", "rec-value");
      const flow = [
        configNode,
        {
          id: "rec-node",
          type: "redis-lua-script",
          server: "config1",
          name: "rec",
          mode: "function",
          readonly: false,
          keyval: 1,
          func: lib,
          fname: "recoverfn",
          block: false,
          wires: [["rec-helper"]],
        },
        { id: "rec-helper", type: "helper" },
      ];
      await loadFlowAsync(flow);
      const node = helper.getNode("rec-node");
      const sink = helper.getNode("rec-helper");
      await waitForNodeProp(node, "libname");

      const firstP = nextMessage(sink);
      node.receive({ payload: ["test:script:rec"] });
      (await firstP).payload.should.equal("rec-value");

      // Drop the library out-of-band, then re-fire: FCALL should hit
      // "function not found", reload, and retry successfully.
      await seed.function("flush");
      node.libname = ""; // recovery must re-establish the loaded-library marker
      const secondP = nextMessage(sink);
      node.receive({ payload: ["test:script:rec"] });
      (await secondP).payload.should.equal("rec-value");
      node.libname.should.equal(
        "testlibrecover",
        "in-band recovery must update node.libname like the on-ready loader does"
      );
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script errors fast in function mode when the function name is empty", async function () {
    const lib = [
      "#!lua name=nofnamelib",
      "redis.register_function('somefn', function(keys, args) return 1 end)",
    ].join("\n");
    const flow = [
      configNode,
      {
        id: "nofname-node",
        type: "redis-lua-script",
        server: "config1",
        name: "nofname",
        mode: "function",
        readonly: false,
        keyval: 0,
        func: lib,
        fname: "",
        block: false,
        wires: [["nofname-helper"]],
      },
      { id: "nofname-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const node = helper.getNode("nofname-node");

    const errP = nextError(node);
    node.receive({ payload: [] });
    String(await errP).should.match(/function name/i);
  });

  it('redis-lua-script treats string "false" readonly as disabled', async function () {
    const flow = [
      configNode,
      {
        id: "rostr-node",
        type: "redis-lua-script",
        server: "config1",
        name: "rostr",
        mode: "script",
        readonly: "false",
        stored: false,
        keyval: 0,
        func: "return 1",
        block: false,
        wires: [["rostr-helper"]],
      },
      { id: "rostr-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const node = helper.getNode("rostr-node");
    const sink = helper.getNode("rostr-helper");

    const msgP = nextMessage(sink);
    node.receive({ payload: [] });
    (await msgP).payload.should.equal(1);
    node.command.should.equal("eval", 'string "false" must not enable read-only mode');
  });

  it("redis-lua-script does not reload/re-execute when a function raises its own not-found-like error", async function () {
    const lib = [
      "#!lua name=fauxlib",
      "redis.register_function('fauxfn', function(keys, args) redis.call('INCR', keys[1]); return redis.error_reply('helper function not found') end)",
    ].join("\n");
    const seed = directRedis();
    try {
      await seed.function("flush");
      await seed.del("test:script:faux");
      const flow = [
        configNode,
        {
          id: "faux-node",
          type: "redis-lua-script",
          server: "config1",
          name: "faux",
          mode: "function",
          readonly: false,
          keyval: 1,
          func: lib,
          fname: "fauxfn",
          block: false,
          wires: [["faux-helper"]],
        },
        { id: "faux-helper", type: "helper" },
      ];

      await loadFlowAsync(flow);
      const node = helper.getNode("faux-node");
      await waitForNodeProp(node, "libname");

      const errP = nextError(node);
      node.receive({ payload: ["test:script:faux"] });
      String(await errP).should.match(/function not found/i);

      (await seed.get("test:script:faux")).should.equal(
        "1",
        "function must run exactly once — a second INCR means the user error was " +
          "misclassified as missing-function and the recovery re-executed it"
      );
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script (stored) does not fall back to EVAL when a script raises its own NOSCRIPT-like error", async function () {
    // The NOSCRIPT check is anchored to the reply prefix so a user script whose own error
    // merely contains the word cannot trigger the EVAL fallback, which would re-execute a
    // non-idempotent script body.
    const script = [
      "redis.call('INCR', KEYS[1])",
      "return redis.error_reply('script cache NOSCRIPT lookup failed')",
    ].join("\n");
    const seed = directRedis();
    try {
      await seed.del("test:script:anchored");
      const flow = [
        configNode,
        {
          id: "anchored-node",
          type: "redis-lua-script",
          server: "config1",
          name: "anchored",
          mode: "script",
          readonly: false,
          stored: true,
          keyval: 1,
          func: script,
          block: false,
          wires: [["anchored-helper"]],
        },
        { id: "anchored-helper", type: "helper" },
      ];

      await loadFlowAsync(flow);
      const node = helper.getNode("anchored-node");
      await waitForNodeProp(node, "sha1");

      const errP = nextError(node);
      node.receive({ payload: ["test:script:anchored"] });
      String(await errP).should.match(/NOSCRIPT lookup failed/);

      node.command.should.equal(
        "evalsha",
        "the node must stay on EVALSHA — switching to EVAL means the user error was " +
          "misclassified as a missing script"
      );
      (await seed.get("test:script:anchored")).should.equal(
        "1",
        "script must run exactly once — a second INCR means the EVAL fallback re-executed it"
      );
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script coalesces concurrent library reloads into a single FUNCTION LOAD", async function () {
    // Recovery is shared through `inflightLoad` so N messages that all hit a flushed
    // library issue one FUNCTION LOAD between them, not one each.
    const lib = [
      "#!lua name=coalescelib",
      "redis.register_function('coalescefn', function(keys, args) return redis.call('INCR', keys[1]) end)",
    ].join("\n");
    const seed = directRedis();
    try {
      await seed.function("flush");
      await seed.del("test:script:coalesce");
      const flow = [
        configNode,
        {
          id: "coalesce-node",
          type: "redis-lua-script",
          server: "config1",
          name: "coalesce",
          mode: "function",
          readonly: false,
          keyval: 1,
          func: lib,
          fname: "coalescefn",
          block: false,
          wires: [["coalesce-helper"]],
        },
        { id: "coalesce-helper", type: "helper" },
      ];

      await loadFlowAsync(flow);
      const node = helper.getNode("coalesce-node");
      const sink = helper.getNode("coalesce-helper");
      await waitForNodeProp(node, "libname");

      // Drop the library out of band, then reset stats so only recovery loads are counted.
      await seed.function("flush");
      await seed.config("RESETSTAT");

      const CONCURRENT = 5;
      const seen = [];
      const allDelivered = new Promise((resolve, reject) => {
        sink.on("input", (msg) => {
          seen.push(msg.payload);
          if (seen.length === CONCURRENT) {
            resolve();
          }
        });
        node.once("call:error", (call) => reject(new Error(String(call.args[0]))));
      });
      for (let i = 0; i < CONCURRENT; i++) {
        node.receive({ payload: ["test:script:coalesce"] });
      }
      await allDelivered;

      seen.sort((a, b) => a - b).should.eql([1, 2, 3, 4, 5]);

      const stats = await seed.info("commandstats");
      const loadCalls = stats.match(/cmdstat_function\|load:calls=(\d+)/);
      loadCalls.should.not.be.null();
      Number(loadCalls[1]).should.equal(
        1,
        `${CONCURRENT} concurrent messages must share one FUNCTION LOAD`
      );
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script errors in function mode when the library source is empty", async function () {
    const flow = [
      configNode,
      {
        id: "badfn-node",
        type: "redis-lua-script",
        server: "config1",
        name: "badfn",
        mode: "function",
        readonly: false,
        keyval: 0,
        func: "",
        fname: "whatever",
        block: false,
        wires: [["badfn-helper"]],
      },
      { id: "badfn-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    const node = helper.getNode("badfn-node");

    const errP = nextError(node);
    node.receive({ payload: [] });
    const err = await errP;

    String(err).should.match(/library source/i);
  });

  // ── Block Commands (dedicated connection): block:true keys the connection by
  //    the node id instead of the shared server name. Verify Script and Function
  //    both execute over a dedicated connection. ──

  it("redis-lua-script (block) runs a Script on a dedicated connection", async function () {
    const seed = directRedis();
    try {
      await seed.set("test:script:block", "block-value");
      const flow = [
        configNode,
        {
          id: "blk-node",
          type: "redis-lua-script",
          server: "config1",
          name: "blk",
          mode: "script",
          readonly: false,
          stored: false,
          keyval: 1,
          func: "return redis.call('GET', KEYS[1])",
          block: true,
          wires: [["blk-helper"]],
        },
        { id: "blk-helper", type: "helper" },
      ];
      await loadFlowAsync(flow);
      const node = helper.getNode("blk-node");
      const sink = helper.getNode("blk-helper");

      const msgP = nextMessage(sink);
      node.receive({ payload: ["test:script:block"] });
      const msg = await msgP;

      msg.payload.should.equal("block-value");
      node.command.should.equal("eval");
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script (block) runs a Function on a dedicated connection", async function () {
    const lib = [
      "#!lua name=blocklib",
      "redis.register_function('blockfn', function(keys, args) return redis.call('GET', keys[1]) end)",
    ].join("\n");
    const seed = directRedis();
    try {
      await seed.function("flush");
      await seed.set("test:script:blockfn", "block-fn-value");
      const flow = [
        configNode,
        {
          id: "blkfn-node",
          type: "redis-lua-script",
          server: "config1",
          name: "blkfn",
          mode: "function",
          readonly: false,
          keyval: 1,
          func: lib,
          fname: "blockfn",
          block: true,
          wires: [["blkfn-helper"]],
        },
        { id: "blkfn-helper", type: "helper" },
      ];
      await loadFlowAsync(flow);
      const node = helper.getNode("blkfn-node");
      const sink = helper.getNode("blkfn-helper");
      await waitForNodeProp(node, "libname");

      const msgP = nextMessage(sink);
      node.receive({ payload: ["test:script:blockfn"] });
      const msg = await msgP;

      msg.payload.should.equal("block-fn-value");
      node.command.should.equal("fcall");
    } finally {
      seed.disconnect();
    }
  });

  it("redis-lua-script (block) gets dedicated server-side connections (CLIENT LIST by name)", async function () {
    // Server-side proof of the dedicated-connection contract: the config sets
    // an ioredis connectionName (CLIENT SETNAME on connect), so CLIENT LIST
    // shows exactly how many connections this flow opened. Two non-block
    // nodes must pool onto ONE connection; each block node must add its own.
    const CONN_NAME = "lua-block-spec";
    const lib = [
      "#!lua name=cidblocklib",
      "redis.register_function('cidblockfn', function(keys, args) return 1 end)",
    ].join("\n");
    const flow = [
      redisConfigNode("config-named", "NamedConn", { connectionName: CONN_NAME }),
      {
        id: "shared1-node",
        type: "redis-lua-script",
        server: "config-named",
        name: "shared1",
        mode: "script",
        readonly: false,
        stored: false,
        keyval: 0,
        func: "return 1",
        block: false,
        wires: [["shared1-helper"]],
      },
      { id: "shared1-helper", type: "helper" },
      {
        id: "shared2-node",
        type: "redis-lua-script",
        server: "config-named",
        name: "shared2",
        mode: "script",
        readonly: false,
        stored: false,
        keyval: 0,
        func: "return 1",
        block: false,
        wires: [["shared2-helper"]],
      },
      { id: "shared2-helper", type: "helper" },
      {
        id: "blkded-node",
        type: "redis-lua-script",
        server: "config-named",
        name: "blkded",
        mode: "script",
        readonly: false,
        stored: false,
        keyval: 0,
        func: "return 1",
        block: true,
        wires: [["blkded-helper"]],
      },
      { id: "blkded-helper", type: "helper" },
      {
        id: "blkdedfn-node",
        type: "redis-lua-script",
        server: "config-named",
        name: "blkdedfn",
        mode: "function",
        readonly: false,
        keyval: 0,
        func: lib,
        fname: "cidblockfn",
        block: true,
        wires: [["blkdedfn-helper"]],
      },
      { id: "blkdedfn-helper", type: "helper" },
    ];

    await loadFlowAsync(flow);
    await waitForNodeProp(helper.getNode("blkdedfn-node"), "libname");

    // Run one message through every node so all connections are live and used.
    for (const id of ["shared1", "shared2", "blkded", "blkdedfn"]) {
      const node = helper.getNode(`${id}-node`);
      const sink = helper.getNode(`${id}-helper`);
      const msgP = nextMessage(sink);
      node.receive({ payload: [] });
      (await msgP).payload.should.equal(1);
    }

    const admin = directRedis();
    try {
      const list = await admin.client("list");
      const named = list.split("\n").filter((line) => line.includes(` name=${CONN_NAME} `));
      named.length.should.equal(
        3,
        `expected exactly 3 server-side connections named ${CONN_NAME} ` +
          `(1 pooled for the two non-block nodes + 1 per block node), got ${named.length}:\n` +
          named.join("\n")
      );
    } finally {
      admin.disconnect();
    }
  });

  // SCRIPT_RUNNER (Redis 8.10): a new COMMAND INFO flag marking commands that execute
  // user-supplied scripts/functions. Purely informational -- confirm it's present without
  // asserting anything about dispatch, catalog filtering, or Script/Function mode, since
  // every other test in this file already proves those are unaffected.
  it("EVAL/EVALSHA/FCALL and their read-only variants carry the new script_runner COMMAND INFO flag", async function () {
    const client = directRedis();
    try {
      const names = ["EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO"];
      const infos = await Promise.all(names.map((name) => client.call("COMMAND", "INFO", name)));
      infos.forEach((info, i) => {
        info[0][2].should.containEql(
          "script_runner",
          `${names[i]} should carry the script_runner flag`
        );
      });
    } finally {
      client.disconnect();
    }
  });
});
