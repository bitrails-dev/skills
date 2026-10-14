/**
 * @file hooks-install-test.mjs
 * @description Test suite for agent-mesh lifecycle hook installer and uninstaller.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installClaudeHooks,
  uninstallClaudeHooks,
  installAgyHooks,
  uninstallAgyHooks,
  installCodexHooks,
  uninstallCodexHooks,
  installOpenCodePlugin,
  uninstallOpenCodePlugin,
  installPiExtension,
  uninstallPiExtension,
  installHarness,
  uninstallHarness,
  diagnoseHarness,
  autoDiscoverHarnesses,
} from "../src/hooks/installer.mjs";

/**
 * Utility: safe recursive directory removal with retry for Windows file locks.
 *
 * On Windows, antivirus scanners and the OS file-system indexer occasionally
 * hold a short-lived handle on a temp directory immediately after a child
 * process (spawnSync) exits. A plain `rmSync` call in that window throws
 * EBUSY and fails the test. Retrying 15 times with 100 ms gaps (1.5 s total)
 * is sufficient to outlast the scan without meaningfully slowing the suite.
 *
 * @param {string} dir - Absolute path of directory to remove.
 * @returns {Promise<void>}
 */
async function safeRmSync(dir) {
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

test("Lifecycle Hook Installer & Uninstaller Suite", async (t) => {
  await t.test("1. Install into missing Claude settings.json creates all 4 events cleanly", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-hook-test-"));
    const settingsPath = join(tmpDir, "settings.json");
    const scriptPath = "D:\\test\\skills\\agent-mesh\\src\\hooks\\presence-hook.mjs";

    try {
      const res = installClaudeHooks(settingsPath, scriptPath);
      assert.equal(res.ok, true);
      assert.equal(res.modified, true);
      assert.equal(existsSync(settingsPath), true);
      assert.equal(existsSync(`${settingsPath}.bak`), false, "No backup should be made when creating fresh file");

      const data = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.ok(data.hooks);
      const events = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];
      for (const ev of events) {
        assert.ok(data.hooks[ev], `Event ${ev} must exist`);
        assert.equal(data.hooks[ev].length, 1);
        const cmd = data.hooks[ev][0].hooks[0].command;
        assert.match(cmd, /^node "D:\/test\/skills\/agent-mesh\/src\/hooks\/presence-hook\.mjs"$/);
        assert.equal(cmd.includes("\\"), false, "Command must contain forward slashes, no backslashes");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("2. Idempotent install: running twice produces zero duplicates and updates paths", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-hook-test-"));
    const settingsPath = join(tmpDir, "settings.json");
    const scriptPath1 = "D:\\v1\\presence-hook.mjs";
    const scriptPath2 = "D:\\v2\\presence-hook.mjs";

    try {
      installClaudeHooks(settingsPath, scriptPath1);
      // Run second install with updated path
      const res2 = installClaudeHooks(settingsPath, scriptPath2);
      assert.equal(res2.ok, true);

      // Verify backup exists from modifying write
      assert.equal(existsSync(`${settingsPath}.bak`), true);
      const bakData = JSON.parse(readFileSync(`${settingsPath}.bak`, "utf8"));
      assert.ok(bakData.hooks.SessionStart[0].hooks[0].command.includes("v1"));

      const data = JSON.parse(readFileSync(settingsPath, "utf8"));
      for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
        assert.equal(data.hooks[ev].length, 1, "Must have exactly 1 group per event");
        assert.equal(data.hooks[ev][0].hooks.length, 1, "Must have exactly 1 hook entry");
        assert.ok(data.hooks[ev][0].hooks[0].command.includes("v2"));
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("3. Preserves foreign user hooks and isolates agent-mesh entries", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-hook-test-"));
    const settingsPath = join(tmpDir, "settings.json");
    const initialSettings = {
      theme: "dark",
      hooks: {
        SessionStart: [
          {
            matcher: "my-custom-tool",
            hooks: [{ type: "command", command: "echo foreign-tool" }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: "python check_safety.py" }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2));

    try {
      installClaudeHooks(settingsPath, "C:\\mesh\\presence-hook.mjs");
      const data = JSON.parse(readFileSync(settingsPath, "utf8"));

      assert.equal(data.theme, "dark");
      // SessionStart has foreign group + mesh group
      assert.equal(data.hooks.SessionStart.length, 2);
      assert.equal(data.hooks.SessionStart[0].hooks[0].command, "echo foreign-tool");
      assert.ok(data.hooks.SessionStart[1].hooks[0].command.includes("presence-hook.mjs"));

      // Stop has foreign group + mesh group
      assert.equal(data.hooks.Stop.length, 2);
      assert.equal(data.hooks.Stop[0].hooks[0].command, "python check_safety.py");
      assert.ok(data.hooks.Stop[1].hooks[0].command.includes("presence-hook.mjs"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("4. Uninstall strips agent-mesh entries (including legacy stop-hook.mjs) and preserves foreign hooks", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-hook-test-"));
    const settingsPath = join(tmpDir, "settings.json");
    const initialSettings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "node \"C:/mesh/presence-hook.mjs\"" }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "python custom_user_stop.py" }] },
          { hooks: [{ type: "command", command: "node \"C:/mesh/stop-hook.mjs\"" }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2));

    try {
      const res = uninstallClaudeHooks(settingsPath);
      assert.equal(res.ok, true);
      assert.equal(res.modified, true);

      const data = JSON.parse(readFileSync(settingsPath, "utf8"));
      // SessionStart had only mesh hook, so the event should be cleanly removed
      assert.equal(data.hooks.SessionStart, undefined);

      // Stop should preserve the foreign hook and remove stop-hook.mjs
      assert.equal(data.hooks.Stop.length, 1);
      assert.equal(data.hooks.Stop[0].hooks[0].command, "python custom_user_stop.py");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("5. Antigravity hooks: install merges agent-mesh-presence and uninstall removes it", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-hook-test-"));
    const hooksJsonPath = join(tmpDir, "hooks.json");
    const initialAgy = {
      "user-linter": {
        PostToolUse: [{ matcher: "run_command", hooks: [{ command: "eslint" }] }],
      },
    };
    writeFileSync(hooksJsonPath, JSON.stringify(initialAgy, null, 2));

    try {
      const installRes = installAgyHooks(hooksJsonPath, "D:\\mesh\\agy-presence-hook.mjs");
      assert.equal(installRes.ok, true);
      assert.equal(installRes.modified, true);

      const data = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      assert.ok(data["user-linter"], "Foreign named block must be preserved");
      assert.ok(data["agent-mesh-presence"], "agent-mesh-presence block must be present");
      assert.equal(data["agent-mesh-presence"].SessionStart.length, 1);
      assert.equal(data["agent-mesh-presence"].PreInvocation.length, 1);
      assert.equal(data["agent-mesh-presence"].Stop.length, 1);
      assert.match(
        data["agent-mesh-presence"].SessionStart[0].command,
        /node "D:\/mesh\/agy-presence-hook\.mjs".*--event SessionStart/
      );
      assert.match(
        data["agent-mesh-presence"].Stop[0].command,
        /node "D:\/mesh\/agy-presence-hook\.mjs".*--event Stop/
      );
      assert.match(
        data["agent-mesh-presence"].PreInvocation[0].command,
        /node "D:\/mesh\/agy-presence-hook\.mjs".*--event PreInvocation/
      );

      // Uninstall
      const uninstallRes = uninstallAgyHooks(hooksJsonPath);
      assert.equal(uninstallRes.ok, true);
      assert.equal(uninstallRes.modified, true);

      const dataAfter = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      assert.ok(dataAfter["user-linter"]);
      assert.equal(dataAfter["agent-mesh-presence"], undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("6. Refuses to overwrite unparseable/corrupt JSON files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-hook-test-"));
    const corruptPath = join(tmpDir, "settings.json");
    writeFileSync(corruptPath, "{ this is not valid json }");

    try {
      const res = installClaudeHooks(corruptPath, "C:\\mesh\\presence-hook.mjs");
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("Invalid JSON"));
      assert.equal(readFileSync(corruptPath, "utf8"), "{ this is not valid json }");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("7. Static plugin hooks/hooks.json exists and references CLAUDE_PLUGIN_ROOT", () => {
    const pluginHooksPath = join(import.meta.dirname, "../hooks/hooks.json");
    assert.equal(existsSync(pluginHooksPath), true);
    const data = JSON.parse(readFileSync(pluginHooksPath, "utf8"));
    assert.ok(data.hooks);
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      assert.ok(data.hooks[ev]);
      const cmd = data.hooks[ev][0].hooks[0].command;
      assert.ok(cmd.includes("${CLAUDE_PLUGIN_ROOT}"));
      assert.ok(cmd.includes("presence-hook.mjs"));
    }
  });

  await t.test("8. CLI --init and --uninstall work cleanly via CLI execution", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-cli-init-test-"));
    const cliScript = join(import.meta.dirname, "../scripts/mesh.mjs");

    try {
      // 1. Run --init --project in tmpDir
      const initProc = spawnSync(process.execPath, [cliScript, "--init", "--project"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      assert.equal(initProc.status, 0);
      assert.ok(initProc.stdout.includes("AGENT MESH INITIALIZATION"));

      // Verify files created
      const claudePath = join(tmpDir, ".claude", "settings.json");
      const agyPath = join(tmpDir, ".agents", "hooks.json");
      assert.equal(existsSync(claudePath), true);
      assert.equal(existsSync(agyPath), true);

      // 2. Run --uninstall --project in tmpDir
      const unProc = spawnSync(process.execPath, [cliScript, "--uninstall", "--project"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      assert.equal(unProc.status, 0);
      assert.ok(unProc.stdout.includes("UNINSTALLING AGENT MESH REQUIREMENTS"));

      // Verify hooks removed
      const claudeData = JSON.parse(readFileSync(claudePath, "utf8"));
      assert.equal(claudeData.hooks?.SessionStart, undefined);
      const agyData = JSON.parse(readFileSync(agyPath, "utf8"));
      assert.equal(agyData["agent-mesh-presence"], undefined);
    } finally {
      // Stop any broker started by --init before removing the temp dir.
      // safeRmSync retries on EBUSY: Windows AV/indexer can hold a handle
      // briefly after spawnSync returns, causing a plain rmSync to throw.
      spawnSync(process.execPath, [cliScript, "stop"], { cwd: tmpDir });
      await safeRmSync(tmpDir);
    }
  });

  await t.test("9. Codex hook install/uninstall handles --harness codex and preserves foreign hooks", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-codex-test-"));
    const hooksPath = join(tmpDir, "hooks.json");
    const scriptPath = "D:\\mesh\\presence-hook.mjs";

    try {
      // Create initial hooks with foreign hook
      const initial = {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo foreign-codex" }] }],
        },
      };
      writeFileSync(hooksPath, JSON.stringify(initial, null, 2));

      // Install
      const res = installCodexHooks(hooksPath, scriptPath);
      assert.equal(res.ok, true);
      assert.equal(res.modified, true);

      const installed = JSON.parse(readFileSync(hooksPath, "utf8"));
      assert.equal(installed.hooks.SessionStart.length, 2);
      const codexHook = installed.hooks.SessionStart[1].hooks[0].command;
      assert.ok(codexHook.includes("--harness codex"));
      assert.ok(codexHook.includes("presence-hook.mjs"));

      // Uninstall
      const unRes = uninstallCodexHooks(hooksPath);
      assert.equal(unRes.ok, true);
      assert.equal(unRes.modified, true);

      const uninstalled = JSON.parse(readFileSync(hooksPath, "utf8"));
      assert.equal(uninstalled.hooks.SessionStart.length, 1);
      assert.equal(uninstalled.hooks.SessionStart[0].hooks[0].command, "echo foreign-codex");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("10. OpenCode plugin install registers in opencode.json and creates plugin loader", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-opencode-test-"));
    const configPath = join(tmpDir, "opencode.json");
    const pluginLoader = join(tmpDir, "plugins", "agent-mesh-presence.js");
    const scriptPath = join(tmpDir, "opencode-presence-plugin.mjs");
    writeFileSync(scriptPath, "export default function() {}");

    try {
      // 1. Install
      const res = installOpenCodePlugin(configPath, pluginLoader, scriptPath);
      assert.equal(res.ok, true);
      assert.equal(res.modified, true);
      assert.equal(existsSync(pluginLoader), true);

      const configData = JSON.parse(readFileSync(configPath, "utf8"));
      assert.ok(Array.isArray(configData.plugin));
      assert.equal(configData.plugin.length, 1);
      assert.ok(configData.plugin[0].includes("agent-mesh-presence.js"));

      // 2. Uninstall
      const unRes = uninstallOpenCodePlugin(configPath, pluginLoader);
      assert.equal(unRes.ok, true);
      assert.equal(unRes.modified, true);
      assert.equal(existsSync(pluginLoader), false);

      const unData = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(unData.plugin.length, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("11. Pi extension install creates loader in extensions/ and removes cleanly", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-pi-test-"));
    const loaderPath = join(tmpDir, "extensions", "agent-mesh-presence.js");
    const scriptPath = join(tmpDir, "pi-presence-extension.mjs");
    writeFileSync(scriptPath, "export default function() {}");

    try {
      // Install
      const res = installPiExtension(loaderPath, scriptPath);
      assert.equal(res.ok, true);
      assert.equal(existsSync(loaderPath), true);
      const content = readFileSync(loaderPath, "utf8");
      assert.ok(content.includes("pi-presence-extension.mjs"));

      // Uninstall
      const unRes = uninstallPiExtension(loaderPath);
      assert.equal(unRes.ok, true);
      assert.equal(existsSync(loaderPath), false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("12. autoDiscoverHarnesses returns detected system harnesses", () => {
    const detected = autoDiscoverHarnesses({ global: true });
    assert.ok(Array.isArray(detected));
    assert.ok(detected.length > 0, "Should detect at least 1 harness on current machine");
    assert.ok(detected.includes("claude") || detected.includes("agy"));
  });

  await t.test("13. CLI targeted --init codex,pi and --uninstall codex,pi work end-to-end", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "mesh-cli-targeted-"));
    const cliScript = join(import.meta.dirname, "../scripts/mesh.mjs");

    try {
      // 1. Run --init codex,pi --project
      const initProc = spawnSync(process.execPath, [cliScript, "--init", "codex,pi", "--project"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      assert.equal(initProc.status, 0);
      assert.ok(initProc.stdout.includes("Targeted Harnesses"));
      assert.ok(initProc.stdout.includes("codex, pi"));

      // Verify files
      const codexPath = join(tmpDir, ".codex", "hooks.json");
      const piPath = join(tmpDir, ".pi", "extensions", "agent-mesh-presence.js");
      assert.equal(existsSync(codexPath), true);
      assert.equal(existsSync(piPath), true);

      // Verify claude was NOT touched because it was not in target list
      const claudePath = join(tmpDir, ".claude", "settings.json");
      assert.equal(existsSync(claudePath), false);

      // 2. Run --uninstall codex,pi --project
      const unProc = spawnSync(process.execPath, [cliScript, "--uninstall", "codex,pi", "--project"], {
        cwd: tmpDir,
        encoding: "utf8",
      });
      assert.equal(unProc.status, 0);

      // Verify uninstalled
      const codexData = JSON.parse(readFileSync(codexPath, "utf8"));
      assert.equal(codexData.hooks?.SessionStart, undefined);
      assert.equal(existsSync(piPath), false);
    } finally {
      // Stop any broker before cleanup; safeRmSync retries on Windows EBUSY
      // (AV/indexer holds handle briefly after child process exit).
      spawnSync(process.execPath, [cliScript, "stop"], { cwd: tmpDir });
      await safeRmSync(tmpDir);
    }
  });
});
