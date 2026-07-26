"use strict";
const helper = require("node-red-node-test-helper");
const redisNode = require("../redis.js");
const { cleanupKeys } = require("./helpers/cleanup");
const { directRedis, redisConfigNode } = require("./helpers/deployment");
const Redis = require("ioredis");

helper.init(require.resolve("node-red"));

const CONFIG = redisConfigNode("config1", "Local");

function direct() {
  return directRedis();
}

// Resolves the first time node.status() is called with a matching fill/text — used to
// observe the node entering its "retrying" backoff state instead of guessing a fixed delay.
function waitForStatus(node, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            node.removeListener("call:status", listener);
            reject(new Error("waitForStatus timed out after " + timeoutMs + "ms"));
          }, timeoutMs);
    function listener(call) {
      const status = call.args[0];
      if (status && predicate(status)) {
        if (timer) {
          clearTimeout(timer);
        }
        node.removeListener("call:status", listener);
        resolve(status);
      }
    }
    node.on("call:status", listener);
  });
}

function makeInFlow(command, topic, obj, extra = {}) {
  return [
    CONFIG,
    {
      id: "in",
      type: "redis-in",
      server: "config1",
      command,
      topic,
      obj,
      timeout: extra.timeout !== undefined ? extra.timeout : 1,
      groupname: extra.groupname || "",
      consumername: extra.consumername || "",
      wires: [["h"]],
    },
    { id: "h", type: "helper" },
  ];
}

describe("redis-in node", function () {
  this.timeout(8000);

  beforeEach(function (done) {
    helper.startServer(done);
  });

  afterEach((done) => {
    helper
      .unload()
      .then(() =>
        helper.stopServer(() => cleanupKeys("test:in:*", () => cleanupKeys("testinxrg*", done)))
      );
  });

  // ── blpop ──────────────────────────────────────────────────────────────

  it("blpop — emits raw string payload with key as topic", function (done) {
    helper.load(redisNode, makeInFlow("blpop", "test:in:blpop", false), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.topic.should.equal("test:in:blpop");
          msg.payload.should.equal("hello");
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.rpush("test:in:blpop", "hello"), 150);
    });
  });

  it("blpop — parses JSON payload when obj is true", function (done) {
    helper.load(redisNode, makeInFlow("blpop", "test:in:blpop:json", true), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.payload.should.be.an.Object();
          msg.payload.k.should.equal("v");
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.rpush("test:in:blpop:json", JSON.stringify({ k: "v" })), 150);
    });
  });

  it("blpop — falls back to raw string for invalid JSON when obj is true", function (done) {
    helper.load(redisNode, makeInFlow("blpop", "test:in:blpop:fallback", true), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.payload.should.equal("not-json");
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.rpush("test:in:blpop:fallback", "not-json"), 150);
    });
  });

  it("blpop — topic in output reflects actual Redis key, not msg.topic", function (done) {
    helper.load(redisNode, makeInFlow("blpop", "test:in:blpop:key", false), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.topic.should.equal("test:in:blpop:key");
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.rpush("test:in:blpop:key", "data"), 150);
    });
  });

  // ── brpop ──────────────────────────────────────────────────────────────

  it("brpop — emits raw string payload popped from right of list", function (done) {
    helper.load(redisNode, makeInFlow("brpop", "test:in:brpop", false), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.topic.should.equal("test:in:brpop");
          msg.payload.should.equal("world");
          done();
        } catch (e) {
          done(e);
        }
      });

      // lpush so the element is at right (brpop pops from right)
      setTimeout(() => c.lpush("test:in:brpop", "world"), 150);
    });
  });

  it("brpop — parses JSON payload when obj is true", function (done) {
    helper.load(redisNode, makeInFlow("brpop", "test:in:brpop:json", true), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.payload.n.should.equal(42);
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.lpush("test:in:brpop:json", JSON.stringify({ n: 42 })), 150);
    });
  });

  it("brpop — multiple messages received in order", function (done) {
    helper.load(redisNode, makeInFlow("brpop", "test:in:brpop:multi", false), function () {
      const h = helper.getNode("h");
      const c = direct();
      const received = [];

      h.on("input", function (msg) {
        received.push(msg.payload);
        if (received.length === 2) {
          c.disconnect();
          try {
            // brpop pops from right, lpush pushes to left so rightmost is "a"
            received[0].should.equal("a");
            received[1].should.equal("b");
            done();
          } catch (e) {
            done(e);
          }
        }
      });

      // Pre-populate so brpop can immediately fire twice
      setTimeout(() => {
        c.rpush("test:in:brpop:multi", "a");
        setTimeout(() => c.rpush("test:in:brpop:multi", "b"), 50);
      }, 150);
    });
  });

  // ── subscribe ──────────────────────────────────────────────────────────

  it("subscribe — emits message published to the channel", function (done) {
    helper.load(
      redisNode,
      makeInFlow("subscribe", "test:in:subscribe:ch", false, { timeout: 0 }),
      function () {
        const h = helper.getNode("h");
        const c = direct();

        h.on("input", function (msg) {
          c.disconnect();
          try {
            msg.topic.should.equal("test:in:subscribe:ch");
            msg.payload.should.equal("hello sub");
            done();
          } catch (e) {
            done(e);
          }
        });

        setTimeout(() => c.publish("test:in:subscribe:ch", "hello sub"), 300);
      }
    );
  });

  it("subscribe — parses JSON payload when obj is true", function (done) {
    helper.load(
      redisNode,
      makeInFlow("subscribe", "test:in:subscribe:json", true, { timeout: 0 }),
      function () {
        const h = helper.getNode("h");
        const c = direct();

        h.on("input", function (msg) {
          c.disconnect();
          try {
            msg.payload.should.be.an.Object();
            msg.payload.x.should.equal(1);
            done();
          } catch (e) {
            done(e);
          }
        });

        setTimeout(() => c.publish("test:in:subscribe:json", JSON.stringify({ x: 1 })), 300);
      }
    );
  });

  it("subscribe — falls back to raw string for invalid JSON when obj is true", function (done) {
    helper.load(
      redisNode,
      makeInFlow("subscribe", "test:in:subscribe:fallback", true, { timeout: 0 }),
      function () {
        const h = helper.getNode("h");
        const c = direct();

        h.on("input", function (msg) {
          c.disconnect();
          try {
            msg.payload.should.equal("plain-text");
            done();
          } catch (e) {
            done(e);
          }
        });

        setTimeout(() => c.publish("test:in:subscribe:fallback", "plain-text"), 300);
      }
    );
  });

  it("subscribe — receives multiple messages on same channel", function (done) {
    helper.load(
      redisNode,
      makeInFlow("subscribe", "test:in:subscribe:multi", false, { timeout: 0 }),
      function () {
        const h = helper.getNode("h");
        const c = direct();
        const received = [];

        h.on("input", function (msg) {
          received.push(msg.payload);
          if (received.length === 3) {
            c.disconnect();
            try {
              received.should.eql(["msg1", "msg2", "msg3"]);
              done();
            } catch (e) {
              done(e);
            }
          }
        });

        setTimeout(() => {
          c.publish("test:in:subscribe:multi", "msg1");
          c.publish("test:in:subscribe:multi", "msg2");
          c.publish("test:in:subscribe:multi", "msg3");
        }, 300);
      }
    );
  });

  // ── psubscribe ─────────────────────────────────────────────────────────

  it("psubscribe — emits msg.pattern and msg.topic for matching channels", function (done) {
    helper.load(
      redisNode,
      makeInFlow("psubscribe", "test:in:ps:*", false, { timeout: 0 }),
      function () {
        const h = helper.getNode("h");
        const c = direct();

        h.on("input", function (msg) {
          c.disconnect();
          try {
            msg.pattern.should.equal("test:in:ps:*");
            msg.topic.should.equal("test:in:ps:news");
            msg.payload.should.equal("event");
            done();
          } catch (e) {
            done(e);
          }
        });

        setTimeout(() => c.publish("test:in:ps:news", "event"), 300);
      }
    );
  });

  // ── subscribe/psubscribe failure surfacing ─────────────────────────────

  // SUBSCRIBE/PSUBSCRIBE can be refused at subscribe time while the socket itself stays
  // healthy — an ACL user without pubsub access is the reachable case. The failure must be
  // reported rather than leaving the node green and permanently silent.
  const NOSUB_USER = "nrcr_nosub";
  const NOSUB_PASS = "nosub-pass";

  async function withAclUserDeniedPubsub(run) {
    const admin = direct();
    await admin.acl(
      "SETUSER",
      NOSUB_USER,
      "on",
      ">" + NOSUB_PASS,
      "~*",
      "&*",
      "+@all",
      "-subscribe",
      "-psubscribe"
    );
    admin.disconnect();
    try {
      await run();
    } finally {
      const cleanup = direct();
      await cleanup.acl("DELUSER", NOSUB_USER);
      cleanup.disconnect();
    }
  }

  function deniedPubsubFlow(command, topic) {
    return [
      redisConfigNode("config-nosub", "NoSub", {
        username: NOSUB_USER,
        password: NOSUB_PASS,
      }),
      {
        id: "in",
        type: "redis-in",
        server: "config-nosub",
        command,
        topic,
        obj: false,
        timeout: 0,
        groupname: "",
        consumername: "",
        wires: [["h"]],
      },
      { id: "h", type: "helper" },
    ];
  }

  it("subscribe — reports a refused SUBSCRIBE instead of reporting connected", async function () {
    await withAclUserDeniedPubsub(async function () {
      await helper.load(redisNode, deniedPubsubFlow("subscribe", "test:in:subscribe:denied"));
      const node = helper.getNode("in");
      const reported = new Promise((resolve) => {
        node.on("call:error", (call) => resolve(String(call.args[0])));
      });
      const red = waitForStatus(node, (status) => status.fill === "red");

      (await reported).should.match(/NOPERM/i);
      (await red).text.should.match(/subscribe/i);
    });
  });

  it("psubscribe — reports a refused PSUBSCRIBE instead of reporting connected", async function () {
    await withAclUserDeniedPubsub(async function () {
      await helper.load(redisNode, deniedPubsubFlow("psubscribe", "test:in:psdenied:*"));
      const node = helper.getNode("in");
      const reported = new Promise((resolve) => {
        node.on("call:error", (call) => resolve(String(call.args[0])));
      });
      const red = waitForStatus(node, (status) => status.fill === "red");

      (await reported).should.match(/NOPERM/i);
      (await red).text.should.match(/subscribe/i);
    });
  });

  it("psubscribe — receives messages from multiple matching channels", function (done) {
    helper.load(
      redisNode,
      makeInFlow("psubscribe", "test:in:psmulti:*", false, { timeout: 0 }),
      function () {
        const h = helper.getNode("h");
        const c = direct();
        const topics = [];

        h.on("input", function (msg) {
          topics.push(msg.topic);
          if (topics.length === 2) {
            c.disconnect();
            try {
              topics.sort().should.eql(["test:in:psmulti:alpha", "test:in:psmulti:beta"]);
              done();
            } catch (e) {
              done(e);
            }
          }
        });

        setTimeout(() => {
          c.publish("test:in:psmulti:alpha", "1");
          c.publish("test:in:psmulti:beta", "2");
        }, 300);
      }
    );
  });

  it("psubscribe — parses JSON payload when obj is true", function (done) {
    helper.load(
      redisNode,
      makeInFlow("psubscribe", "test:in:psjson:*", true, { timeout: 0 }),
      function () {
        const h = helper.getNode("h");
        const c = direct();

        h.on("input", function (msg) {
          c.disconnect();
          try {
            msg.payload.should.be.an.Object();
            msg.payload.type.should.equal("psubscribe");
            done();
          } catch (e) {
            done(e);
          }
        });

        setTimeout(
          () => c.publish("test:in:psjson:ch1", JSON.stringify({ type: "psubscribe" })),
          300
        );
      }
    );
  });

  // ── xreadgroup ─────────────────────────────────────────────────────────

  it("xreadgroup — receives stream message as field object when obj is true", function (done) {
    const STREAM = "testinxrg";
    const GROUP = "grp";
    const c = direct();

    c.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM")
      .then(() => c.xadd(STREAM, "*", "field1", "val1", "field2", "val2"))
      .then(() => {
        helper.load(
          redisNode,
          makeInFlow("xreadgroup", `${STREAM}:>`, true, {
            timeout: 0,
            groupname: GROUP,
            consumername: "consumer-1",
          }),
          function () {
            const h = helper.getNode("h");

            h.on("input", function (msg) {
              c.disconnect();
              try {
                msg.stream.should.equal(STREAM);
                msg.messageId.should.be.a.String();
                msg.payload.should.be.an.Object();
                msg.payload.field1.should.equal("val1");
                msg.payload.field2.should.equal("val2");
                done();
              } catch (e) {
                done(e);
              }
            });
          }
        );
      })
      .catch(done);
  });

  it("xreadgroup — emits raw flat key-value array when obj is false", function (done) {
    const STREAM = "testinxrgraw";
    const GROUP = "grpraw";
    const c = direct();

    c.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM")
      .then(() => c.xadd(STREAM, "*", "k", "v"))
      .then(() => {
        helper.load(
          redisNode,
          makeInFlow("xreadgroup", `${STREAM}:>`, false, {
            timeout: 0,
            groupname: GROUP,
            consumername: "consumer-1",
          }),
          function () {
            const h = helper.getNode("h");

            h.on("input", function (msg) {
              c.disconnect();
              try {
                msg.payload.should.be.an.Array();
                msg.payload[0].should.equal("k");
                msg.payload[1].should.equal("v");
                done();
              } catch (e) {
                done(e);
              }
            });
          }
        );
      })
      .catch(done);
  });

  it("xreadgroup — accepts a stream key containing colons (namespaced key)", async function () {
    // Stream IDs (>, $, 0, 123-0) can never contain a colon, so the topic must be
    // split at its FINAL colon, not its first — otherwise a namespaced key like
    // "test:in:xrg:namespaced" is torn apart into the wrong stream/id.
    const STREAM = "test:in:xrg:namespaced";
    const GROUP = "grp-namespaced";
    const c = direct();

    await c.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    await c.xadd(STREAM, "*", "field", "value");

    await helper.load(
      redisNode,
      makeInFlow("xreadgroup", `${STREAM}:>`, true, {
        timeout: 0,
        groupname: GROUP,
        consumername: "consumer-1",
      })
    );
    const h = helper.getNode("h");
    const msg = await new Promise((resolve) => h.once("input", resolve));
    c.disconnect();

    msg.stream.should.equal(STREAM);
    msg.payload.field.should.equal("value");
  });

  it("xreadgroup — calls node.error and does not start the loop when Topic has no stream/id separator", async function () {
    await helper.load(
      redisNode,
      makeInFlow("xreadgroup", "no-colon-here", true, {
        timeout: 0,
        groupname: "grp",
        consumername: "consumer-1",
      })
    );
    const inNode = helper.getNode("in");
    await new Promise((resolve) => inNode.once("call:error", resolve));

    inNode.error.callCount.should.be.above(0);
    String(inNode.error.firstCall.args[0]).should.match(/stream-key.*:.*id|Topic/i);
  });

  it("xreadgroup — warns with XGROUP CREATE guidance when the consumer group is missing", async function () {
    // docs/TROUBLESHOOTING.md tells users to look for this warning, so its text is part of
    // the node's contract rather than an incidental log line.
    const STREAM = "test:in:xrg:nogroup";
    const c = direct();
    await c.del(STREAM);
    await c.xadd(STREAM, "*", "field", "value");
    c.disconnect();

    await helper.load(
      redisNode,
      makeInFlow("xreadgroup", `${STREAM}:>`, true, {
        timeout: 0,
        groupname: "grp-missing",
        consumername: "consumer-1",
      })
    );
    const inNode = helper.getNode("in");
    const warned = new Promise((resolve) =>
      inNode.once("call:warn", (call) => resolve(String(call.args[0])))
    );
    const retrying = waitForStatus(inNode, (status) => status.text === "retrying");

    const warning = await warned;
    warning.should.match(/grp-missing/);
    warning.should.match(/XGROUP CREATE/);
    (await retrying).fill.should.equal("yellow");
  });

  it("xreadgroup — clears retrying status after the consumer group is created", async function () {
    // After NOGROUP recovery the loop keeps delivering, but a stale yellow "retrying"
    // status must not stick for the life of the node.
    const STREAM = "test:in:xrg:statusrecover";
    const GROUP = "grp-statusrecover";
    const c = direct();
    await c.del(STREAM);

    await helper.load(
      redisNode,
      makeInFlow("xreadgroup", `${STREAM}:>`, true, {
        timeout: 0,
        groupname: GROUP,
        consumername: "consumer-1",
      })
    );
    const inNode = helper.getNode("in");
    const h = helper.getNode("h");
    await waitForStatus(inNode, (status) => status.text === "retrying");

    // Status is restored before send(), so watch for green before the recovery write.
    const connectedP = waitForStatus(
      inNode,
      (status) => status.fill === "green" && status.text === "connected",
      8000
    );
    const msgP = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message after XGROUP CREATE")), 8000);
      h.once("input", (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });

    await c.xgroup("CREATE", STREAM, GROUP, "$", "MKSTREAM");
    await c.xadd(STREAM, "*", "k", "after-recovery");

    const msg = await msgP;
    msg.payload.k.should.equal("after-recovery");
    (await connectedP).fill.should.equal("green");
    c.disconnect();
  });

  // ── bzpopmin ───────────────────────────────────────────────────────────

  it("bzpopmin — emits {member, score} popping the lowest-score element first", function (done) {
    const c = direct();

    // Pre-populate both members so bzpopmin sees them together and picks the minimum
    Promise.all([
      c.zadd("test:in:bzpopmin", 5, "task-high"),
      c.zadd("test:in:bzpopmin", 1, "task-low"),
    ])
      .then(() => {
        helper.load(redisNode, makeInFlow("bzpopmin", "test:in:bzpopmin", false), function () {
          const h = helper.getNode("h");

          h.on("input", function (msg) {
            c.disconnect();
            try {
              msg.topic.should.equal("test:in:bzpopmin");
              msg.payload.member.should.equal("task-low");
              msg.payload.score.should.equal(1);
              done();
            } catch (e) {
              done(e);
            }
          });
        });
      })
      .catch(done);
  });

  it("bzpopmin — parses JSON member when obj is true", function (done) {
    helper.load(redisNode, makeInFlow("bzpopmin", "test:in:bzpopmin:json", true), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.payload.member.should.be.an.Object();
          msg.payload.member.name.should.equal("job1");
          msg.payload.score.should.equal(3);
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.zadd("test:in:bzpopmin:json", 3, JSON.stringify({ name: "job1" })), 150);
    });
  });

  // ── bzpopmax ───────────────────────────────────────────────────────────

  it("bzpopmax — emits {member, score} popping the highest-score element first", function (done) {
    const c = direct();

    // Pre-populate both members so bzpopmax sees them together and picks the maximum
    Promise.all([
      c.zadd("test:in:bzpopmax", 10, "task-high"),
      c.zadd("test:in:bzpopmax", 1, "task-low"),
    ])
      .then(() => {
        helper.load(redisNode, makeInFlow("bzpopmax", "test:in:bzpopmax", false), function () {
          const h = helper.getNode("h");

          h.on("input", function (msg) {
            c.disconnect();
            try {
              msg.topic.should.equal("test:in:bzpopmax");
              msg.payload.member.should.equal("task-high");
              msg.payload.score.should.equal(10);
              done();
            } catch (e) {
              done(e);
            }
          });
        });
      })
      .catch(done);
  });

  it("bzpopmax — score is returned as a float", function (done) {
    helper.load(redisNode, makeInFlow("bzpopmax", "test:in:bzpopmax:float", false), function () {
      const h = helper.getNode("h");
      const c = direct();

      h.on("input", function (msg) {
        c.disconnect();
        try {
          msg.payload.score.should.equal(3.14);
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.zadd("test:in:bzpopmax:float", 3.14, "pi-task"), 150);
    });
  });

  // ── auto-recovery ────────────────────────────────────────────────────────

  it("blpop — clears retrying status after a transient connection error", async function () {
    const originalBlpop = Redis.prototype.blpop;
    Redis.prototype.blpop = function () {
      Redis.prototype.blpop = originalBlpop;
      return Promise.reject(new Error("Connection is closed."));
    };

    try {
      await helper.load(redisNode, makeInFlow("blpop", "test:in:recover:status", false));
      const inNode = helper.getNode("in");
      const h = helper.getNode("h");
      await waitForStatus(inNode, (s) => s.fill === "yellow" && s.text === "retrying");

      // Status is restored before send(), so watch for green before the recovery write.
      const connectedP = waitForStatus(
        inNode,
        (status) => status.fill === "green" && status.text === "connected",
        8000
      );
      const msgP = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message after blpop recovery")), 8000);
        h.once("input", (m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });

      const c = direct();
      await c.rpush("test:in:recover:status", "after-recovery");
      const msg = await msgP;
      msg.payload.should.equal("after-recovery");
      (await connectedP).fill.should.equal("green");
      c.disconnect();
    } finally {
      Redis.prototype.blpop = originalBlpop;
    }
  });

  it("blpop — recovers and keeps consuming after a transient connection error", function (done) {
    const originalBlpop = Redis.prototype.blpop;
    // Reject the first blpop (simulate a dropped connection), then restore the
    // real implementation for every subsequent call.
    Redis.prototype.blpop = function () {
      Redis.prototype.blpop = originalBlpop;
      return Promise.reject(new Error("Connection is closed."));
    };

    helper.load(redisNode, makeInFlow("blpop", "test:in:recover:blpop", false), function () {
      const h = helper.getNode("h");
      const c = direct();
      const giveUp = setTimeout(function () {
        Redis.prototype.blpop = originalBlpop;
        c.disconnect();
        done(new Error("no message received — blocking loop did not recover from the error"));
      }, 4000);

      h.on("input", function (msg) {
        clearTimeout(giveUp);
        Redis.prototype.blpop = originalBlpop;
        c.disconnect();
        try {
          msg.payload.should.equal("after-recovery");
          done();
        } catch (e) {
          done(e);
        }
      });

      setTimeout(() => c.rpush("test:in:recover:blpop", "after-recovery"), 400);
    });
  });

  it("xreadgroup — recovers and keeps consuming after a transient connection error", async function () {
    const STREAM = "testinxrgrecover";
    const GROUP = "grprecover";
    const c = direct();
    const originalXreadgroup = Redis.prototype.xreadgroup;
    Redis.prototype.xreadgroup = function () {
      Redis.prototype.xreadgroup = originalXreadgroup;
      return Promise.reject(new Error("Connection is closed."));
    };

    try {
      await c.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
      await c.xadd(STREAM, "*", "k", "v");

      await helper.load(
        redisNode,
        makeInFlow("xreadgroup", `${STREAM}:>`, true, {
          timeout: 0,
          groupname: GROUP,
          consumername: "consumer-1",
        })
      );
      const h = helper.getNode("h");
      const received = new Promise((resolve) => h.once("input", resolve));
      let giveUpTimer;
      const giveUp = new Promise((_, reject) => {
        giveUpTimer = setTimeout(
          () => reject(new Error("no message received — xreadgroup loop did not recover")),
          4000
        );
      });
      const msg = await Promise.race([received, giveUp]);
      clearTimeout(giveUpTimer);

      msg.payload.k.should.equal("v");
    } finally {
      Redis.prototype.xreadgroup = originalXreadgroup;
      c.disconnect();
    }
  });

  it("blpop — stops cleanly when the node closes during a retry backoff", async function () {
    const originalBlpop = Redis.prototype.blpop;
    // Always reject so the loop stays in the retry/backoff cycle.
    Redis.prototype.blpop = function () {
      return Promise.reject(new Error("Connection is closed."));
    };

    try {
      await helper.load(redisNode, makeInFlow("blpop", "test:in:recover:close", false));
      const inNode = helper.getNode("in");
      // Wait for the node to actually enter its retry/backoff status before closing it,
      // rather than guessing how long that takes.
      await waitForStatus(inNode, (s) => s.fill === "yellow" && s.text === "retrying");
      await helper.unload();
    } finally {
      Redis.prototype.blpop = originalBlpop;
    }
  });
});
