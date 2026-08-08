"use strict";

const { directRedis } = require("./deployment");

// COMMAND INFO replies [nil] for a command the connected server doesn't recognize — used to
// self-skip Redis-8.10-only test cases scattered across the command-family specs when run
// against an older Redis or against Valkey (this package's other tested engine, which does
// not bundle Redis's 8.10-era commands or modules).
async function isCommandSupported(command) {
  const client = directRedis();
  try {
    return (await client.call("COMMAND", "INFO", command))[0] !== null;
  } finally {
    client.disconnect();
  }
}

// Some Redis 8.10 additions are new *options* on an existing, already-supported command
// (e.g. XREAD MAXCOUNT), so COMMAND INFO on the command name alone can't detect them —
// Valkey recognizes XREAD but rejects MAXCOUNT with a syntax error. Try the call for real and
// treat a syntax error as "unsupported"; anything else (including success) is not our concern
// here and is re-thrown so a real bug in the probe args isn't silently swallowed.
async function isCallSyntaxSupported(args) {
  const client = directRedis();
  try {
    await client.call(...args);
    return true;
  } catch (err) {
    if (/ERR syntax error/i.test(err.message)) {
      return false;
    }
    throw err;
  } finally {
    client.disconnect();
  }
}

module.exports = { isCallSyntaxSupported, isCommandSupported };
