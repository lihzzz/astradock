/**
 * Lightweight JSON-RPC 2.0 client over stdio (JSONL).
 *
 * Shared between Electron and CLI — platform-specific logger and error
 * reporter are injected via constructor options.
 */

import type { ChildProcess } from "child_process";
import { StringDecoder } from "node:string_decoder";
import { stopProcessAndWait } from "./process-stop";
import type { RequestId } from "../types/codex-protocol/RequestId";

const DEFAULT_TIMEOUT_MS = 30_000;

export type LogFn = (label: string, ...args: unknown[]) => void;
export type ReportErrorFn = (label: string, err: unknown, context?: Record<string, unknown>) => string;

export interface CodexRpcClientOptions {
  log: LogFn;
  reportError: ReportErrorFn;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Error returned by a Codex JSON-RPC request, retaining the wire error code. */
export class CodexRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: RpcError) {
    super(`Codex RPC error [${error.code}]: ${error.message}`);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export type ServerRequestHandler = (msg: {
  id: RequestId;
  method: string;
  params: Record<string, unknown>;
}) => void;

export type NotificationHandler = (msg: {
  method: string;
  params: Record<string, unknown>;
}) => void;

export class CodexRpcClient {
  private nextId = 1;
  private pendingRequests = new Map<RequestId, PendingRequest>();
  private lineBuffer = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private destroyed = false;
  private log: LogFn;
  private reportError: ReportErrorFn;

  /** Called for server-initiated requests (e.g. approval prompts) */
  onServerRequest: ServerRequestHandler | null = null;
  /** Called for server notifications (item/*, turn/*, etc.) */
  onNotification: NotificationHandler | null = null;
  /** Called when the process stderr emits data */
  onStderr: ((data: string) => void) | null = null;
  /** Called when the process exits */
  onExit: ((code: number | null, signal: string | null) => void) | null = null;

  constructor(private proc: ChildProcess, options: CodexRpcClientOptions) {
    this.log = options.log;
    this.reportError = options.reportError;

    // Pipe chunks can end in the middle of a multi-byte character. Decode the
    // stream before splitting JSONL; Buffer.toString() per chunk loses bytes.
    proc.stdout?.on("data", (chunk: Buffer) => this.handleText(this.stdoutDecoder.write(chunk)));
    proc.stdout?.on("end", () => this.handleText(this.stdoutDecoder.end()));
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = this.stderrDecoder.write(chunk).trim();
      if (text) this.onStderr?.(text);
    });
    proc.stderr?.on("end", () => {
      const text = this.stderrDecoder.end().trim();
      if (text) this.onStderr?.(text);
    });
    proc.on("exit", (code, signal) => {
      this.destroyed = true;
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Codex process exited (code=${code}, signal=${signal}) while waiting for ${pending.method}`));
        this.pendingRequests.delete(id);
      }
      this.onExit?.(code, signal);
    });
    proc.on("error", (err) => {
      this.reportError("codex-rpc", err, { context: "process-error" });
    });
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.destroyed) throw new Error("Codex RPC client is destroyed");

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex RPC timeout: ${method} (id=${id}) after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (r: unknown) => void,
        reject,
        timer,
        method,
      });

      this.writeLine({ method, id, params: params ?? {} });
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.destroyed) return;
    this.writeLine({ method, params: params ?? {} });
  }

  /** Respond to a server-initiated request. */
  respondToServer(id: RequestId, result: unknown): void {
    if (this.destroyed) return;
    this.writeLine({ id, result });
  }

  /** Respond to a server-initiated request with an error. */
  respondToServerError(id: RequestId, code: number, message: string): void {
    if (this.destroyed) return;
    this.writeLine({ id, error: { code, message } });
  }

  /** Kill the underlying process. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void stopProcessAndWait(this.proc).catch((error) => this.reportError("codex-rpc", error, { context: "stop-process" }));
  }

  get isAlive(): boolean {
    return !this.destroyed && this.proc.exitCode === null && !this.proc.killed;
  }

  /** Destructive session operations require an observed process exit. */
  async destroyAndWait(): Promise<void> {
    this.destroyed = true;
    await stopProcessAndWait(this.proc);
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  // ── Internal ──

  private writeLine(msg: Record<string, unknown>): void {
    if (this.destroyed || !this.proc.stdin || this.proc.stdin.destroyed) return;
    const line = JSON.stringify(msg) + "\n";
    this.proc.stdin.write(line);
  }

  private handleText(text: string): void {
    if (!text) return;
    this.lineBuffer += text;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop()!; // keep incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.dispatchMessage(msg);
      } catch (err) {
        this.log("codex-rpc", `Failed to parse line: ${(err as Error).message}`);
      }
    }
  }

  private dispatchMessage(msg: Record<string, unknown>): void {
    const hasId = "id" in msg && msg.id != null;
    const hasMethod = "method" in msg && typeof msg.method === "string";
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    if (hasId && (hasResult || hasError) && !hasMethod) {
      // Response to our request
      const id = msg.id as RequestId;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        if (hasError) {
          const err = msg.error as RpcError;
          pending.reject(new CodexRpcError(err));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (hasId && hasMethod) {
      // Server-initiated request (e.g. approval prompt)
      this.onServerRequest?.({
        id: msg.id as RequestId,
        method: msg.method as string,
        params: (msg.params ?? {}) as Record<string, unknown>,
      });
    } else if (hasMethod && !hasId) {
      // Notification
      this.onNotification?.({
        method: msg.method as string,
        params: (msg.params ?? {}) as Record<string, unknown>,
      });
    } else {
      this.log("codex-rpc", `Unrecognized message shape: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  }
}
