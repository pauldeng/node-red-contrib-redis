"use strict";

function commandNode(id, command, server = "config1", extra = {}) {
  return Object.assign(
    {
      id: `${id}-node`,
      type: "redis-command",
      server,
      command,
      name: command,
      topic: "",
      params: "[]",
      wires: [[`${id}-helper`]],
    },
    extra
  );
}

function helperNode(id) {
  return { id: `${id}-helper`, type: "helper" };
}

function invoke(helper, id, msg = {}, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const node = helper.getNode(`${id}-node`);
    const sink = helper.getNode(`${id}-helper`);
    const cleanup = () => {
      clearTimeout(timer);
      node.removeListener("call:error", onError);
      sink.removeListener("input", onInput);
    };
    const onError = (call) => {
      cleanup();
      reject(call.args[0]);
    };
    const onInput = (out) => {
      cleanup();
      resolve(out.payload);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${id}`));
    }, timeoutMs);

    node.on("call:error", onError);
    sink.on("input", onInput);

    node.receive(msg);
  });
}

function expectError(helper, id, msg = {}, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const node = helper.getNode(`${id}-node`);
    const sink = helper.getNode(`${id}-helper`);
    const cleanup = () => {
      clearTimeout(timer);
      node.removeListener("call:error", onError);
      sink.removeListener("input", onInput);
    };
    const onError = (call) => {
      cleanup();
      resolve(call.args[0]);
    };
    const onInput = (out) => {
      cleanup();
      reject(new Error(`Expected ${id} to fail, got ${JSON.stringify(out.payload)}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${id} error`));
    }, timeoutMs);

    node.on("call:error", onError);
    sink.on("input", onInput);

    node.receive(msg);
  });
}

function load(helper, redisNode, flow) {
  return new Promise((resolve, reject) => {
    helper.load(redisNode, flow, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  commandNode,
  expectError,
  helperNode,
  invoke,
  load,
};
