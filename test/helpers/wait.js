"use strict";

// Polls until node[prop] is truthy; rejects after timeoutMs. Used to wait for
// redis-lua-script load side effects that are set asynchronously on the
// connection "ready" event: node.sha1 (stored scripts via SCRIPT LOAD) and
// node.libname (function libraries via FUNCTION LOAD REPLACE).
async function waitForNodeProp(node, prop, timeoutMs = 5000) {
  const start = Date.now();
  while (!node[prop]) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`node.${prop} was never set within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function clientsFor(client) {
  return typeof client.nodes === "function" ? client.nodes("master") : [client];
}

async function waitForSubscription(client, channel, pattern = false, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const replies = await Promise.all(
      clientsFor(client).map((node) =>
        pattern ? node.call("PUBSUB", "NUMPAT") : node.call("PUBSUB", "NUMSUB", channel)
      )
    );
    const subscribed = pattern
      ? replies.some((count) => Number(count) > 0)
      : replies.some((reply) => Number(reply[1]) > 0);
    if (subscribed) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${pattern ? "Pattern" : "Channel"} subscription was not ready: ${channel}`);
}

async function waitForBlockedCommand(client, command, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const lists = await Promise.all(clientsFor(client).map((node) => node.call("CLIENT", "LIST")));
    const blocked = lists.some((list) =>
      String(list)
        .split("\n")
        .some((line) => {
          const fields = Object.fromEntries(
            line
              .split(" ")
              .filter(Boolean)
              .map((field) => field.split("=", 2))
          );
          return fields.cmd === command && String(fields.flags || "").includes("b");
        })
    );
    if (blocked) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Blocked ${command} was not ready`);
}

module.exports = { waitForBlockedCommand, waitForNodeProp, waitForSubscription };
