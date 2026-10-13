import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profile = vi.hoisted(() => ({
  paths: new Map<string, string>(),
  requested: "",
  setPath: vi.fn<(name: string, value: string) => void>(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      const value = profile.paths.get(name);
      if (value === undefined) throw new Error(`Unexpected Electron path: ${name}`);
      return value;
    },
    setPath: profile.setPath,
    commandLine: {
      getSwitchValue: (name: string) => {
        if (name !== "user-data-dir") throw new Error(`Unexpected switch: ${name}`);
        return profile.requested;
      },
    },
  },
}));

const FIXTURE_PREFIX = "astradock-profile-test-";
let fixtureRoot = "";

beforeEach(() => {
  vi.resetModules();
  profile.requested = "";
  profile.paths.clear();
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
  profile.paths.set("appData", fixtureRoot);
  profile.paths.set("userData", path.join(fixtureRoot, "AstraDock"));
  profile.paths.set("sessionData", path.join(fixtureRoot, "AstraDock"));
  profile.setPath.mockReset();
  profile.setPath.mockImplementation((name, value) => {
    if (!fs.statSync(value).isDirectory()) throw new Error("Electron requires a directory");
    profile.paths.set(name, value);
  });
});

afterEach(() => {
  const resolved = path.resolve(fixtureRoot);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(FIXTURE_PREFIX)) {
    throw new Error("Unexpected profile fixture path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("app profile bootstrap", () => {
  it("makes existing application and Chromium data available before storage consumers load", async () => {
    const legacyProfile = path.join(fixtureRoot, "Harnss");
    const existingData = path.join(legacyProfile, "openacpui-data");
    const existingBrowserData = path.join(legacyProfile, "Local Storage", "leveldb");
    fs.mkdirSync(existingData, { recursive: true });
    fs.mkdirSync(existingBrowserData, { recursive: true });
    fs.writeFileSync(path.join(existingData, "settings.json"), '{"memory":{"enabled":true}}');
    fs.writeFileSync(path.join(existingBrowserData, "CURRENT"), "existing browser profile");

    await import("../app-profile");
    const { getDataDir } = await import("../data-dir");

    expect(getDataDir()).toBe(existingData);
    expect(fs.readFileSync(path.join(getDataDir(), "settings.json"), "utf8"))
      .toBe('{"memory":{"enabled":true}}');
    expect(profile.paths.get("sessionData")).toBe(legacyProfile);
    expect(fs.readFileSync(path.join(profile.paths.get("sessionData")!, "Local Storage", "leveldb", "CURRENT"), "utf8"))
      .toBe("existing browser profile");
    expect(fs.existsSync(path.join(fixtureRoot, "AstraDock"))).toBe(false);
  });

  it("creates a usable shared profile for a fresh installation", async () => {
    await import("../app-profile");

    const selectedProfile = profile.paths.get("userData")!;
    expect(selectedProfile).toBe(path.join(fixtureRoot, "Harnss"));
    expect(fs.statSync(selectedProfile).isDirectory()).toBe(true);
    expect(profile.paths.get("sessionData")).toBe(selectedProfile);
  });

  it("keeps an explicit isolated profile separate from existing user data", async () => {
    const legacyProfile = path.join(fixtureRoot, "Harnss");
    fs.mkdirSync(legacyProfile);
    fs.writeFileSync(path.join(legacyProfile, "user-data.txt"), "keep existing data");
    profile.requested = path.join(fixtureRoot, "isolated 中文 profile");

    await import("../app-profile");
    const { getDataDir } = await import("../data-dir");

    expect(getDataDir()).toBe(path.join(profile.requested, "openacpui-data"));
    expect(profile.paths.get("sessionData")).toBe(profile.requested);
    expect(fs.readdirSync(legacyProfile)).toEqual(["user-data.txt"]);
    expect(fs.readFileSync(path.join(legacyProfile, "user-data.txt"), "utf8"))
      .toBe("keep existing data");
  });

  it("resolves a relative profile argument before passing it to Electron", async () => {
    const requestedProfile = path.join(fixtureRoot, "relative profile");
    profile.requested = path.relative(process.cwd(), requestedProfile);

    await import("../app-profile");

    expect(profile.paths.get("userData")).toBe(requestedProfile);
    expect(profile.paths.get("sessionData")).toBe(requestedProfile);
    expect(fs.existsSync(path.join(fixtureRoot, "Harnss"))).toBe(false);
  });

  it("stops initialization when the selected profile cannot be a directory", async () => {
    fs.writeFileSync(path.join(fixtureRoot, "Harnss"), "directory is obstructed");

    await expect(import("../app-profile")).rejects.toThrow();

    expect(profile.setPath).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(fixtureRoot, "AstraDock"))).toBe(false);
  });
});
