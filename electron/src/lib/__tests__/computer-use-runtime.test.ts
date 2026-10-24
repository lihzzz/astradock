import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAppSetting, mockExecFile, mockMacStatus, mockMacRequest } = vi.hoisted(() => ({
  mockGetAppSetting: vi.fn(),
  mockExecFile: vi.fn(),
  mockMacStatus: vi.fn(),
  mockMacRequest: vi.fn(),
}));
vi.mock("child_process", () => ({ execFile: mockExecFile }));
vi.mock("@trycua/cua-driver", () => ({ currentMacOsPermissionStatus: mockMacStatus }));
vi.mock("@trycua/cua-driver/electron", () => ({ requestMacOSPermissions: mockMacRequest }));
vi.mock("../error-utils", () => ({ reportError: (_label: string, error: unknown) => error instanceof Error ? error.message : String(error) }));

vi.mock("../app-settings", () => ({
  getAppSetting: mockGetAppSetting,
}));

async function loadModule() {
  vi.resetModules();
  return import("../computer-use-runtime");
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", originalPlatform));

describe("computer-use runtime configuration", () => {
  beforeEach(() => {
    mockExecFile.mockReset().mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => { queueMicrotask(() => callback(null, '{"driverVersion":"0.33.0"}', "")); });
    mockMacStatus.mockReset().mockReturnValue({ accessibility: true, screenRecording: true });
    mockMacRequest.mockReset().mockReturnValue({ accessibility: true, screenRecording: true });
    mockGetAppSetting.mockReset();
    mockGetAppSetting.mockImplementation((key: string) => {
      if (key === "computerUseEnabled") return false;
      if (key === "computerUseBinaryPath") return "";
      return undefined;
    });
  });

  function enabledOn(platform: string): void {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    mockGetAppSetting.mockImplementation((key: string) => key === "computerUseEnabled" ? true : "");
  }

  it("requires both macOS desktop permissions before reporting ready", async () => {
    enabledOn("darwin");
    const { getComputerUseRuntimeStatus } = await loadModule();
    expect(await getComputerUseRuntimeStatus()).toMatchObject({ installed: true, ready: true });
    mockMacStatus.mockReturnValue({ accessibility: true, screenRecording: false });
    expect(await getComputerUseRuntimeStatus()).toMatchObject({ installed: true, ready: false, permissions: { screenRecording: false } });
  });

  it("reports an unknown permission state as unavailable instead of authorized", async () => {
    enabledOn("darwin");
    mockMacStatus.mockImplementation(() => { throw new Error("native permission query failed"); });
    const { getComputerUseRuntimeStatus } = await loadModule();
    const status = await getComputerUseRuntimeStatus();
    expect(status).toMatchObject({ installed: true, ready: false, error: expect.stringContaining("native permission query failed") });
    expect(status.permissions).toBeUndefined();
  });

  it("propagates a failed native permission request for the settings UI", async () => {
    enabledOn("darwin");
    mockMacRequest.mockImplementation(() => { throw new Error("request unavailable"); });
    const { requestComputerUsePermissions } = await loadModule();
    await expect(requestComputerUsePermissions()).rejects.toThrow("Unable to request macOS desktop permissions: request unavailable");
  });

  it("does not query or request macOS permissions on Windows", async () => {
    enabledOn("win32");
    const { getComputerUseRuntimeStatus, requestComputerUsePermissions } = await loadModule();
    expect(await getComputerUseRuntimeStatus()).toMatchObject({ installed: true, ready: true });
    expect(await requestComputerUsePermissions()).toBeUndefined();
    expect(mockMacStatus).not.toHaveBeenCalled();
    expect(mockMacRequest).not.toHaveBeenCalled();
  });

  it("coalesces concurrent asynchronous probes without caching permissions", async () => {
    enabledOn("win32");
    let finish!: (error: Error | null, stdout: string, stderr: string) => void;
    mockExecFile.mockImplementation((_command, _args, _options, callback) => { finish = callback; });
    const { getComputerUseRuntimeStatus } = await loadModule();
    const first = getComputerUseRuntimeStatus(); const second = getComputerUseRuntimeStatus();
    expect(mockExecFile).toHaveBeenCalledOnce();
    finish(null, '{"driverVersion":"test"}', "");
    expect((await Promise.all([first, second])).map(status => status.ready)).toEqual([true, true]);
  });

  it("reports failed async probes and enforces a bounded output buffer", async () => {
    enabledOn("win32");
    mockExecFile.mockImplementation((_command, _args, options, callback) => {
      expect(options.maxBuffer).toBe(1024 * 1024);
      queueMicrotask(() => callback(new Error("probe timed out"), "", ""));
    });
    const { getComputerUseRuntimeStatus } = await loadModule();
    expect(await getComputerUseRuntimeStatus()).toMatchObject({ installed: false, ready: false, error: "probe timed out" });
  });

  it("does not inject a server when the runtime is disabled", async () => {
    const { getComputerUseMcpServer, withComputerUseMcpServer } = await loadModule();
    const configured = [{ name: "filesystem", transport: "stdio" as const, command: "fs" }];

    expect(getComputerUseMcpServer()).toBeNull();
    expect(withComputerUseMcpServer(configured)).toEqual(configured);
  });

  it("uses the configured external driver and preserves an existing server", async () => {
    mockGetAppSetting.mockImplementation((key: string) => {
      if (key === "computerUseEnabled") return true;
      if (key === "computerUseBinaryPath") return "/opt/bin/cua-driver";
      return undefined;
    });

    const { getComputerUseMcpServer, getCodexMcpServerOverrides, withComputerUseMcpServer } = await loadModule();
    const runtime = getComputerUseMcpServer();
    expect(runtime).toEqual({
      name: "harnss_cua",
      transport: "stdio",
      command: "/opt/bin/cua-driver",
      args: ["mcp"],
    });
    expect(getCodexMcpServerOverrides({
      ...runtime!,
      env: { ELECTRON_RUN_AS_NODE: "1" },
    })).toEqual([
      "-c", 'mcp_servers.harnss_cua.command="/opt/bin/cua-driver"',
      "-c", 'mcp_servers.harnss_cua.args=["mcp"]',
      "-c", 'mcp_servers.harnss_cua.env.ELECTRON_RUN_AS_NODE="1"',
      "-c", "mcp_servers.harnss_cua.enabled=true",
    ]);

    const configured = [runtime!, { name: "filesystem", transport: "stdio" as const, command: "fs" }];
    expect(withComputerUseMcpServer(configured)).toEqual(configured);
  });

  it("appends the bundled server without mutating the input list", async () => {
    mockGetAppSetting.mockImplementation((key: string) => {
      if (key === "computerUseEnabled") return true;
      if (key === "computerUseBinaryPath") return "";
      return undefined;
    });

    const { withComputerUseMcpServer } = await loadModule();
    const configured = [{ name: "filesystem", transport: "stdio" as const, command: "fs" }];
    const result = withComputerUseMcpServer(configured);

    expect(configured).toEqual([{ name: "filesystem", transport: "stdio", command: "fs" }]);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ name: "harnss_cua", transport: "stdio" });
  });

  it("marks the bundled Electron helper as a Node process", async () => {
    mockGetAppSetting.mockImplementation((key: string) => {
      if (key === "computerUseEnabled") return true;
      if (key === "computerUseBinaryPath") return "";
      return undefined;
    });

    const versions = process.versions as unknown as Record<string, string | undefined>;
    const hadElectronVersion = Object.prototype.hasOwnProperty.call(versions, "electron");
    const previousElectronVersion = versions.electron;
    Object.defineProperty(versions, "electron", { configurable: true, value: "40.0.0" });
    try {
      const { getComputerUseMcpServer } = await loadModule();
      expect(getComputerUseMcpServer()?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    } finally {
      if (hadElectronVersion) {
        Object.defineProperty(versions, "electron", { configurable: true, value: previousElectronVersion });
      } else {
        delete versions.electron;
      }
    }
  });
});
