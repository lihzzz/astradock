import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("../data-dir", () => ({ getDataDir: () => state.directory }));

beforeEach(() => {
  vi.resetModules();
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "harnss-settings-test-"));
});

afterEach(() => {
  fs.rmSync(path.join(state.directory, "settings.json"), { force: true });
  fs.rmdirSync(state.directory);
});

function writeSettings(settings: object): void {
  fs.writeFileSync(path.join(state.directory, "settings.json"), JSON.stringify(settings));
}

describe("telemetry consent", () => {
  it("defaults new installations to off without creating or rewriting settings", async () => {
    const settings = await import("../app-settings");
    expect(settings.getAppSettings().analyticsEnabled).toBe(false);
    expect(fs.existsSync(path.join(state.directory, "settings.json"))).toBe(false);
  });
  it.each([true, false])("preserves the existing explicit consent value %s byte-for-byte on read", async (analyticsEnabled) => {
    writeSettings({ analyticsEnabled, analyticsUserId: "existing-id", defaultChatLimit: 20 });
    const file = path.join(state.directory, "settings.json");
    const original = fs.readFileSync(file, "utf8");
    const settings = await import("../app-settings");
    expect(settings.getAppSettings().analyticsEnabled).toBe(analyticsEnabled);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });
});

describe("engine binary source settings", () => {
  it("migrates both legacy managed sources to system detection and persists them on save", async () => {
    writeSettings({ codexBinarySource: "managed", claudeBinarySource: "managed", codexClientName: "Existing client" });
    const settings = await import("../app-settings");
    expect(settings.getAppSettings()).toMatchObject({
      codexBinarySource: "auto", claudeBinarySource: "auto", codexClientName: "Existing client",
    });
    settings.setAppSettings({ defaultChatLimit: 20 });
    expect(JSON.parse(fs.readFileSync(path.join(state.directory, "settings.json"), "utf8"))).toMatchObject({
      codexBinarySource: "auto", claudeBinarySource: "auto", codexClientName: "Existing client", defaultChatLimit: 20,
    });
  });

  it("preserves custom installations and unrelated settings when changing a binary source", async () => {
    writeSettings({
      codexBinarySource: "custom", codexCustomBinaryPath: "C:/Installed Codex/codex.exe",
      claudeBinarySource: "custom", claudeCustomBinaryPath: "C:/Installed Claude/claude.exe", analyticsEnabled: false,
    });
    const settings = await import("../app-settings");
    expect(settings.setAppSettings({ codexBinarySource: "auto" })).toMatchObject({
      codexBinarySource: "auto", codexCustomBinaryPath: "C:/Installed Codex/codex.exe",
      claudeBinarySource: "custom", claudeCustomBinaryPath: "C:/Installed Claude/claude.exe", analyticsEnabled: false,
    });
  });

  it("uses system detection for missing or unsupported persisted sources", async () => {
    writeSettings({ codexBinarySource: "unsupported", claudeBinarySource: null });
    const settings = await import("../app-settings");
    expect(settings.getAppSettings()).toMatchObject({ codexBinarySource: "auto", claudeBinarySource: "auto" });
  });
});
