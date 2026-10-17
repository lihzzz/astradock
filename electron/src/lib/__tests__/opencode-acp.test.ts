import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { findExecutable, resolveExecutableCommand, spawnExecutable } from "../command-launch";
import { stopProcessAndWait } from "@shared/lib/process-stop";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { closeAcpSession, restoreAcpSession, withAcpTimeout } from "../acp-runtime";
import { openCodeUtilityConfig } from "../opencode-utility-config";

const runOpenCodeE2E = process.env.OPENCODE_E2E === "1";

describe.skipIf(!runOpenCodeE2E)("OpenCode ACP integration (no model calls)", () => {
  it.each(["path", "resolved-native"])("negotiates, resumes, lists, forks, closes and isolates utilities via %s", async launch => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "harnss-opencode-acp-"));
    const agent = "astradock-utility-test";
    const env = { ...process.env, HOME: path.join(dataDir, "home"),
      XDG_DATA_HOME: path.join(dataDir, "data"), XDG_CONFIG_HOME: path.join(dataDir, "config"),
      XDG_STATE_HOME: path.join(dataDir, "state"), XDG_CACHE_HOME: path.join(dataDir, "cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: dataDir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeUtilityConfig(agent)),
    };
    const command = launch === "path" ? "opencode" : resolveExecutableCommand("opencode", [], { env }).command;
    const child = spawnExecutable(command, ["acp", "--pure", "--cwd", dataDir], { cwd: dataDir, env, stdio: ["pipe", "pipe", "pipe"] });
    let originalFailure = false;
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data).slice(-4000); });
    try {
      const stdout = child.stdout;
      if (!child.stdin || !stdout) throw new Error("Missing stdio");
      const output = new ReadableStream<Uint8Array>({ start(controller) {
        stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        stdout.on("end", () => controller.close()); stdout.on("error", error => controller.error(error));
      } });
      const events: acp.SessionNotification[] = [];
      const connection = new acp.ClientSideConnection(() => ({
        sessionUpdate: async event => { events.push(event); },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        readTextFile: async () => { throw new Error("No utility filesystem access"); },
        writeTextFile: async () => { throw new Error("No utility filesystem access"); },
      }), acp.ndJsonStream(Writable.toWeb(child.stdin), output));
      const bounded = <T>(promise: Promise<T>) => withAcpTimeout(promise, 15000, "OpenCode probe: " + stderr, connection.signal);
      const initialized = await bounded(connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "astradock-test", version: "1" }, clientCapabilities: {} }));
      expect(initialized.agentInfo?.name).toBe("OpenCode");
      const capabilities = initialized.agentCapabilities ?? {};
      expect(capabilities.sessionCapabilities?.resume).toBeTruthy();
      const session = await bounded(connection.newSession({ cwd: dataDir, mcpServers: [
        { name: "unavailable-test-server", command: path.join(dataDir, "missing.exe"), args: [], env: [] },
      ] }));
      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.configOptions?.find(option => option.category === "mode")?.currentValue).toBe(agent);
      expect(session.configOptions?.some(option => option.category === "model")).toBe(true);
      events.length = 0;
      expect((await bounded(restoreAcpSession(connection, capabilities, { sessionId: session.sessionId, cwd: dataDir, mcpServers: [] }))).method).toBe("resume");
      expect(events.some(event => event.update.sessionUpdate === "user_message_chunk")).toBe(false);
      const listed = await bounded(connection.unstable_listSessions({ cwd: dataDir }));
      expect(listed.sessions.some(info => info.sessionId === session.sessionId)).toBe(true);
      const fork = await bounded(connection.unstable_forkSession({ sessionId: session.sessionId, cwd: dataDir, mcpServers: [] }));
      expect(fork.sessionId).not.toBe(session.sessionId);
      expect(await bounded(closeAcpSession(connection, capabilities, fork.sessionId))).toBe(true);
      expect(await bounded(closeAcpSession(connection, capabilities, session.sessionId))).toBe(true);
      if (process.platform === "win32" && findExecutable("opencode")?.toLowerCase().endsWith(".cmd")) {
        expect(resolveExecutableCommand("opencode").command.toLowerCase()).toMatch(/opencode\.exe$/);
      }
    } catch (error) { originalFailure = true; throw error; }
    finally {
      try {
        await stopProcessAndWait(child);
        const resolved = path.resolve(dataDir);
        if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("harnss-opencode-acp-")) throw new Error("Unexpected test cleanup path");
        await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error) { if (!originalFailure) throw error; console.warn("OpenCode cleanup also failed", error); }
    }
  }, 60000);
});
