import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexRpcClient } from "@shared/lib/codex-rpc";

function fixture() {
  const proc = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  proc.stdin = new PassThrough(); proc.stdout = stdout; proc.stderr = stderr;
  const log = vi.fn();
  const rpc = new CodexRpcClient(proc, { log, reportError: vi.fn(() => "error") });
  return { proc, stdout, stderr, rpc, log };
}

const delta = "│   ├── 中文 😀 café";
const notification = { method: "item/commandExecution/outputDelta", params: { itemId: "item", delta } };

describe("Codex UTF-8 stdio", () => {
  it("preserves command output at every possible byte boundary", () => {
    const bytes = Buffer.from(JSON.stringify(notification) + "\n", "utf8");
    for (let split = 1; split < bytes.length; split++) {
      const { stdout, rpc, log } = fixture();
      const received = vi.fn(); rpc.onNotification = received;
      stdout.write(bytes.subarray(0, split));
      stdout.write(bytes.subarray(split));
      expect(received, `split at byte ${split}`).toHaveBeenCalledExactlyOnceWith(notification);
      expect(log).not.toHaveBeenCalled();
    }
  });

  it("decodes byte-sized chunks and multiple JSONL messages in order", () => {
    const { stdout, rpc } = fixture();
    const received = vi.fn(); rpc.onNotification = received;
    const second = { method: "item/agentMessage/delta", params: { delta: "第二条回复 🎉" } };
    const bytes = Buffer.from(JSON.stringify(notification) + "\r\n\n" + JSON.stringify(second) + "\n");
    for (const byte of bytes) stdout.write(Buffer.from([byte]));
    expect(received.mock.calls).toEqual([[notification], [second]]);
  });

  it("preserves Unicode in RPC responses and approval requests", async () => {
    const { proc, stdout, rpc } = fixture();
    const received = vi.fn(); rpc.onServerRequest = received;
    const pending = rpc.request("fixture");
    const result = { text: delta };
    const approval = { id: "approval", method: "item/commandExecution/requestApproval", params: { command: "读取文件 😀" } };
    const bytes = Buffer.from(JSON.stringify({ id: 1, result }) + "\n" + JSON.stringify(approval) + "\n");
    for (const byte of bytes) stdout.write(Buffer.from([byte]));
    try {
      await expect(pending).resolves.toEqual(result);
      expect(received).toHaveBeenCalledExactlyOnceWith(approval);
    } finally { proc.emit("exit", 0, null); }
  });

  it("keeps independent UTF-8 decoder state for stdout and stderr", () => {
    const { stdout, stderr, rpc } = fixture();
    const received = vi.fn(); rpc.onNotification = received;
    const errors: string[] = []; rpc.onStderr = (text) => errors.push(text);
    const output = Buffer.from(JSON.stringify(notification) + "\n");
    const errorText = "错误├──é😀";
    const errorBytes = Buffer.from(errorText);
    for (let index = 0; index < Math.max(output.length, errorBytes.length); index++) {
      if (index < output.length) stdout.write(output.subarray(index, index + 1));
      if (index < errorBytes.length) stderr.write(errorBytes.subarray(index, index + 1));
    }
    expect(received).toHaveBeenCalledExactlyOnceWith(notification);
    expect(errors.join("")).toBe(errorText);
  });

  it("flushes an incomplete final stderr character at stream end", async () => {
    const { stderr, rpc } = fixture();
    const errors: string[] = []; rpc.onStderr = (text) => errors.push(text);
    stderr.write(Buffer.from([0xe4, 0xb8]));
    expect(errors).toEqual([]);
    await new Promise<void>((resolve) => { stderr.once("end", resolve); stderr.end(); });
    expect(errors).toEqual(["�"]);
  });
});
