"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

// Read the HTML template once for all assertions.
const html = fs.readFileSync(path.join(__dirname, "../redis.html"), "utf8");

// Narrow to the RED.library.create() call inside the redis-lua-script registerType block.
function extractLibraryCreateBody(source) {
  const m = source.match(
    /registerType\(["']redis-lua-script["'][\s\S]*?RED\.library\.create\(\{([\s\S]*?)\}\s*\)/
  );
  return m ? m[1] : null;
}

// Extract a simple scalar option (string value) from the library.create() body.
function extractLibraryOption(source, key) {
  const body = extractLibraryCreateBody(source);
  if (!body) return null;
  const m = body.match(new RegExp(key + "\\s*:\\s*[\"']([^\"']+)[\"']"));
  return m ? m[1] : null;
}

// Return the raw fields array source text from the library.create() body.
function extractFieldsBody(source) {
  const body = extractLibraryCreateBody(source);
  if (!body) return null;
  const m = body.match(/fields\s*:\s*\[([\s\S]*?)\]/);
  return m ? m[1] : null;
}

// Returns true if the fields body declares the given field as a plain string entry.
function hasStringField(fieldsBody, name) {
  return new RegExp(`['"]${name}['"]`).test(fieldsBody);
}

// Returns true if the fields body declares the given field as an object with get/set.
function hasObjectField(fieldsBody, name) {
  // Look for   name: 'foo',  followed (anywhere in the object) by get: and set:
  const objectPattern = new RegExp(
    `name\\s*:\\s*['"]${name}['"][\\s\\S]*?get\\s*:[\\s\\S]*?set\\s*:`
  );
  return objectPattern.test(fieldsBody);
}

describe("redis-lua-script UI template", function () {
  describe("RED.library.create type", function () {
    it("does not contain a period", function () {
      const type = extractLibraryOption(html, "type");
      assert.ok(type !== null, "RED.library.create() type should be present in the template");
      assert.ok(
        !type.includes("."),
        `library type "${type}" must not contain a period — ` +
          `RED.menu.init uses jQuery's #id selector which treats '.' as a class ` +
          `separator, so "node-input-${type}-lookup" would never be found and ` +
          `the Open/Save Library menu would not attach to the button`
      );
    });

    it("produces a valid DOM id for the lookup button", function () {
      const type = extractLibraryOption(html, "type");
      assert.ok(type !== null, "RED.library.create() type should be present in the template");
      const buttonId = `node-input-${type}-lookup`;
      // A valid id for jQuery's #id selector must not contain: . # [ ] ( ) etc.
      assert.ok(
        /^[A-Za-z0-9_-]+$/.test(buttonId),
        `Generated button id "${buttonId}" must contain only alphanumerics, hyphens, and underscores`
      );
    });

    it("type is 'lua'", function () {
      const type = extractLibraryOption(html, "type");
      assert.strictEqual(
        type,
        "lua",
        "library type should be 'lua' (dot-free) so the lookup button id " +
          "node-input-lua-lookup is a valid jQuery selector"
      );
    });
  });

  describe("RED.library.create ext", function () {
    it("save dialog default filename uses .lua extension", function () {
      const ext = extractLibraryOption(html, "ext");
      assert.strictEqual(
        ext,
        "lua",
        "ext should be 'lua' so the Save to Library dialog pre-fills the filename as <name>.lua"
      );
    });
  });

  describe("RED.library.create fields", function () {
    let fieldsBody;
    before(function () {
      fieldsBody = extractFieldsBody(html);
      assert.ok(fieldsBody !== null, "fields array should be present in RED.library.create()");
    });

    it("includes 'name' and 'keyval' as plain string fields", function () {
      assert.ok(hasStringField(fieldsBody, "name"), "fields should include 'name'");
      assert.ok(hasStringField(fieldsBody, "keyval"), "fields should include 'keyval'");
    });

    it("declares 'stored' as an object field with get and set", function () {
      assert.ok(
        hasObjectField(fieldsBody, "stored"),
        "'stored' must be an object field with get/set — plain .val() does not read " +
          "or write checkbox checked state"
      );
    });

    it("declares 'block' as an object field with get and set", function () {
      assert.ok(
        hasObjectField(fieldsBody, "block"),
        "'block' must be an object field with get/set — it was previously missing " +
          "from fields entirely, so Block Commands was never saved to or loaded from the library"
      );
    });

    it("checkbox get() returns a string, not a boolean", function () {
      // Node-RED's saveLibraryEntry passes every metadata value through
      // toSingleLine(text) which calls text.replace(...). If get() returns
      // a boolean, .replace is not a function and the save throws.
      assert.ok(
        /["'"]true["'"]/.test(fieldsBody) && /["'"]false["'"]/.test(fieldsBody),
        'checkbox get() must return the string "true" or "false", not a boolean, ' +
          "because Node-RED calls text.replace() on every metadata value when writing the file"
      );
    });
  });
});

describe("redis-lua-script mode/readonly/fname fields", function () {
  function luaDefaultsBody() {
    const m = html.match(
      /registerType\(["']redis-lua-script["'],[\s\S]*?defaults:\s*\{([\s\S]*?)\},\s*\n\s*label:/
    );
    return m ? m[1] : null;
  }

  it("registers mode, readonly, and fname in defaults", function () {
    const defaults = luaDefaultsBody();
    assert.ok(defaults !== null, "redis-lua-script defaults block should be present");
    assert.match(defaults, /\bmode\s*:/, "defaults should include 'mode'");
    assert.match(defaults, /\breadonly\s*:/, "defaults should include 'readonly'");
    assert.match(defaults, /\bfname\s*:/, "defaults should include 'fname'");
  });

  it("seeds a function-library template when a pristine node switches to Function mode", function () {
    const m = html.match(/registerType\(["']redis-lua-script["'],([\s\S]*?)\n<\/script>/);
    assert.ok(m !== null, "redis-lua-script registerType block should be present");
    const block = m[1];
    assert.match(
      block,
      /#!lua name=/,
      "the editor block must define a Function-mode template containing the #!lua shebang"
    );
    assert.match(
      block,
      /redis\.register_function/,
      "the Function-mode template must register a function via redis.register_function"
    );
  });

  it("declares fname as mandatory in Function mode (validate present)", function () {
    const defaults = luaDefaultsBody();
    assert.ok(defaults !== null, "redis-lua-script defaults block should be present");
    assert.match(
      defaults,
      /fname\s*:\s*\{[\s\S]*?validate\s*:/,
      "fname must carry a validate function so Function mode requires a function name"
    );
  });

  it("template has a mode select, a read-only checkbox, and a function-name input", function () {
    assert.match(html, /id="node-input-mode"/, "template should include #node-input-mode");
    assert.match(html, /id="node-input-readonly"/, "template should include #node-input-readonly");
    assert.match(html, /id="node-input-fname"/, "template should include #node-input-fname");
  });

  it("library.create persists mode (object), readonly (object), and fname (string)", function () {
    const fieldsBody = extractFieldsBody(html);
    assert.ok(fieldsBody !== null, "fields array should be present");
    assert.ok(
      hasStringField(fieldsBody, "fname"),
      "fields should include 'fname' as a string field"
    );
    assert.ok(
      hasObjectField(fieldsBody, "mode"),
      "'mode' must be an object field with get/set so Open Library re-applies field visibility"
    );
    assert.ok(
      hasObjectField(fieldsBody, "readonly"),
      '\'readonly\' must be an object field with get/set returning the string "true"/"false"'
    );
  });
});

describe("redis-config UI template", function () {
  it("opens saved environment-variable configs on the ConnString tab", function () {
    assert.match(
      html,
      /this\.optionsType === "env"\s*\?\s*"redis-config-tab-options"\s*:\s*"redis-config-tab-connection"/,
      "environment-variable options should activate the ConnString tab when the config editor opens"
    );
    assert.match(
      html,
      /redisConfigTabs\.activateTab\(initialTabId\)/,
      "the editor should activate the tab selected from the saved options type"
    );
  });

  it("keeps saved JSON configs opening on the Connection tab", function () {
    assert.match(
      html,
      /"redis-config-tab-connection"/,
      "JSON options should keep the Connection tab as the initial editor tab"
    );
    assert.match(
      html,
      /\$\(("#redis-config-options-type"|'#redis-config-options-type')\)\.val\(this\.optionsType === "env" \? "env" : "json"\)/,
      "the Type drop-down should still select JSON unless the saved config is env"
    );
  });

  it("makes the Connection tab read-only while environment-variable options are selected", function () {
    assert.match(
      html,
      /function updateConnectionEditability\(\)/,
      "redis-config should centralize Connection tab editability"
    );
    assert.match(
      html,
      /#redis-config-connection-tab[\s\S]*?\.prop\("disabled", disabled\)/,
      "Connection tab inputs and selects should be disabled when env options are selected"
    );
    assert.match(
      html,
      /red-ui-editableList-addButton[\s\S]*?red-ui-editableList-item-remove[\s\S]*?\.toggle\(!disabled\)/,
      "editableList add and remove controls should be hidden when env options are selected"
    );
    assert.match(
      html,
      /updateConnectionEditability\(\);[\s\S]*?if \(\$\("#redis-config-options-type"\)\.val\(\) === "json"\)/,
      "changing back to JSON should re-enable the Connection tab before syncing form values"
    );
  });

  it("does not copy JSON options into the environment-variable textbox when switching type", function () {
    assert.match(
      html,
      /var lastEnvOptions\s*=\s*this\.optionsType === "env"\s*\?\s*\(?\$\(("#node-config-input-options"|'#node-config-input-options')\)\.val\(\) \|\| ""\)?\s*:\s*""/,
      "redis-config should track the last environment-variable name separately from JSON options"
    );
    assert.match(
      html,
      /\$\(("#redis-config-options-raw"|'#redis-config-options-raw')\)\.val\(lastEnvOptions\)/,
      "switching to env should populate the textbox from the remembered env variable name, not the JSON options"
    );
    assert.doesNotMatch(
      html,
      /\$\(("#redis-config-options-raw"|'#redis-config-options-raw')\)\.val\(\$\(("#node-config-input-options"|'#node-config-input-options')\)\.val\(\)\)/,
      "switching to env must not copy the saved JSON options into the env variable textbox"
    );
  });
});

// Narrow to the Single-mode section of the redis-config template so a Cluster/Sentinel
// section can never accidentally satisfy a Transport-selector assertion meant for Single.
function extractSingleModeSection(source) {
  var start = source.indexOf('id="redis-config-single-section"');
  var end = source.indexOf('id="redis-config-cluster-section"', start);
  return source.slice(start, end);
}

describe("redis-config Single-mode Unix socket transport", function () {
  var singleSection = extractSingleModeSection(html);

  it("declares a Transport select defaulting to TCP before Unix socket", function () {
    assert.match(
      singleSection,
      /<select id="redis-config-single-transport"[^>]*>\s*<option value="tcp">TCP<\/option>\s*<option value="unix">Unix socket<\/option>/,
      "Single mode should offer a Transport select with TCP listed (and thus selected) before Unix socket"
    );
  });

  it("scopes the Transport select to Single mode only", function () {
    assert.doesNotMatch(
      html.slice(html.indexOf('id="redis-config-cluster-section"')),
      /redis-config-single-transport/,
      "Cluster/Sentinel/ConnString sections must not reference the Single-mode Transport select"
    );
  });

  it("keeps host/port/TLS and the socket path in separate provider-style subsections", function () {
    assert.match(
      singleSection,
      /id="redis-config-single-tcp-section"[\s\S]*?id="redis-config-single-host"[\s\S]*?id="redis-config-single-port"[\s\S]*?id="redis-config-single-tls"/,
      "the TCP subsection should contain host, port, and TLS"
    );
    assert.match(
      singleSection,
      /id="redis-config-single-unix-section"[\s\S]*?id="redis-config-single-path"/,
      "the Unix socket subsection should contain the socket path field"
    );
  });

  it("keeps username, password, and logical DB shared outside both transport subsections", function () {
    var afterUnixSection = singleSection.slice(
      singleSection.indexOf('id="redis-config-single-unix-section"')
    );
    assert.match(
      afterUnixSection,
      /id="redis-config-single-username"[\s\S]*?id="redis-config-single-password"[\s\S]*?id="redis-config-single-db"/,
      "username, password, and logical DB should be declared once, shared across transports"
    );
  });

  it("cleanKnownSingleKeys strips path and family so stale keys never survive a transport switch", function () {
    assert.match(
      html,
      /function cleanKnownSingleKeys\(options\)[\s\S]*?\[\s*"host",\s*"port",\s*"family",\s*"username",\s*"password",\s*"db",\s*"tls",\s*"path",?\s*\]/,
      "cleanKnownSingleKeys should exclude path and family alongside the existing known keys"
    );
  });

  it("buildSingleOptions serializes a Unix socket connection as {path, username?, password?, db?} with no host/port/tls", function () {
    var m = html.match(/function buildSingleOptions\(existing\)\s*\{([\s\S]*?)\n {6}\}/);
    assert.ok(m, "buildSingleOptions should be present");
    var body = m[1];
    assert.match(
      body,
      /if \(transport === "unix"\) \{\s*base\.path\s*=/,
      "the unix branch should set base.path from the socket-path field"
    );
    var unixBranch = body.slice(
      body.indexOf('if (transport === "unix")'),
      body.indexOf("} else {")
    );
    assert.doesNotMatch(
      unixBranch,
      /base\.host|base\.port/,
      "the unix branch must not set host or port"
    );
    var tcpBranch = body.slice(body.indexOf("} else {"));
    assert.match(
      tcpBranch,
      /base\.host\s*=[\s\S]*?base\.port\s*=/,
      "the tcp branch should set host and port"
    );
    assert.doesNotMatch(tcpBranch, /base\.path/, "the tcp branch must not set path");
  });

  it("drops a stale path when switching back to TCP (base is rebuilt fresh via cleanKnownSingleKeys)", function () {
    var m = html.match(/function buildSingleOptions\(existing\)\s*\{([\s\S]*?)\n {6}\}/);
    var body = m[1];
    assert.match(
      body,
      /var base = cleanKnownSingleKeys\(existing \|\| \{\}\);/,
      "buildSingleOptions must rebuild from cleanKnownSingleKeys, which already strips any prior path"
    );
  });

  it("requires a non-empty socket path and only recommends (not enforces) an absolute path", function () {
    assert.match(
      html,
      /function updateSinglePathValidation\(\)[\s\S]*?if \(!path\) \{[\s\S]*?required[\s\S]*?redis-config-error/,
      "an empty socket path should be flagged as required via the inline error styling"
    );
    assert.match(
      html,
      /function updateSinglePathValidation\(\)[\s\S]*?absolute path is recommended[\s\S]*?removeClass\("redis-config-error"\)/,
      "a relative path should get a recommendation, not the error styling — no OS-specific validation is enforced"
    );
  });

  it("populateFormFromOptions detects Unix socket transport from a saved path", function () {
    assert.match(
      html,
      /var transport = options\.path \? "unix" : "tcp";\s*\$\("#redis-config-single-transport"\)\.val\(transport\);/,
      "loading a saved config should select Unix socket when options.path is present, else TCP"
    );
  });
});

// Narrow to the redis-command registerType block so command-list assertions can't
// accidentally match another node's template/select.
function extractRedisCommandBlock(source) {
  const templateIdx = source.indexOf('data-template-name="redis-command"');
  const scriptEnd = source.indexOf("</script>", templateIdx);
  return source.slice(templateIdx, scriptEnd);
}

describe("redis-command UI template", function () {
  const templateBlock = extractRedisCommandBlock(html);

  it("registers command as a required, editable input, not a closed select", function () {
    assert.match(
      html,
      /command:\s*\{\s*value:\s*"SET",\s*required:\s*true,?\s*\}/,
      'command default should be the uppercase "SET" and required, fixing the historical ' +
        "lowercase-default/uppercase-option mismatch"
    );
    assert.match(
      templateBlock,
      /<input type="text" id="node-input-command" list="node-input-command-list"/,
      "the command field must be an editable text input wired to a datalist, not a closed <select>"
    );
    assert.doesNotMatch(
      templateBlock,
      /<select id="node-input-command">/,
      "the command field must no longer be a closed <select> — arbitrary/new command names must be acceptable"
    );
  });

  // Cheap, no-Redis spot check of a few representative entries. The full derived-set
  // comparison against a live Redis 8.8's COMMAND LIST lives in
  // test/redis_8_8_data_types_spec.js ("datalist vs. live COMMAND LIST").
  it("spot-checks a few representative datalist entries: no retired module commands, includes new Redis 8.8 commands", function () {
    assert.match(
      templateBlock,
      /<datalist id="node-input-command-list">/,
      "a node-input-command-list datalist should back the command input"
    );
    // Retired modules (RedisAI, RedisGraph, RedisGears) — must not resurface as suggestions.
    assert.doesNotMatch(
      templateBlock,
      /value="AI\./,
      "retired RedisAI commands should not be suggested"
    );
    assert.doesNotMatch(
      templateBlock,
      /value="GRAPH\./,
      "retired RedisGraph commands should not be suggested"
    );
    assert.doesNotMatch(
      templateBlock,
      /value="RG\./,
      "retired RedisGears commands should not be suggested"
    );
    // Representative new-in-8.8 commands (Array family, plus two standalone additions).
    ["ARSET", "ARGET", "INCREX", "XNACK", "VADD", "VSIM", "TDIGEST.ADD"].forEach(function (cmd) {
      assert.match(
        templateBlock,
        new RegExp('value="' + cmd + '"'),
        cmd + " (new in Redis 8.8) should be suggested"
      );
    });
    // Still-active module families named in the hardening plan must be retained.
    ["BF.", "CF.", "CMS.", "JSON.", "TDIGEST.", "TOPK.", "TS."].forEach(function (prefix) {
      assert.match(
        templateBlock,
        new RegExp('value="' + prefix.replace(".", "\\.")),
        prefix + "* commands should remain suggested"
      );
    });
  });

  it("does not suggest administrative/dangerous commands via the datalist", function () {
    // Consistent with the repo's existing precedent (commit dc9124f) of excluding
    // dangerous commands from suggestions — the input still accepts them if typed.
    [
      "FLUSHALL",
      "FLUSHDB",
      "DEBUG",
      "SHUTDOWN",
      "MONITOR",
      "SLAVEOF",
      "REPLICAOF",
      "SAVE",
      "SYNC",
      "PSYNC",
      "RESET",
      "QUIT",
      "REPLCONF",
      "FAILOVER",
      "ASKING",
    ].forEach(function (cmd) {
      assert.doesNotMatch(
        templateBlock,
        new RegExp('value="' + cmd + '"'),
        cmd + " is administrative/dangerous and should not be a suggested command"
      );
    });
  });
});
