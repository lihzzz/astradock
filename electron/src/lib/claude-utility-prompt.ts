import { getClaudeBinaryPath } from "./claude-binary";
import { clientAppEnv, getSDK } from "./sdk";
import { reportError } from "./error-utils";

interface ClaudeUtilityPromptOptions {
  timeoutMs?: number;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Run an isolated Claude request for UI utilities. Tools, MCP, persistence and
 * permission prompts are deliberately disabled because this request is only a
 * prediction and must never mutate the workspace or the active session.
 */
export async function claudeUtilityPrompt(
  prompt: string,
  cwd: string,
  options?: ClaudeUtilityPromptOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 9000;
  const model = options?.model?.trim() || undefined;
  const query = await getSDK();
  const cliPath = await getClaudeBinaryPath({ installIfMissing: false, allowSdkFallback: true });
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortedByCaller = false;
  const abortFromCaller = () => {
    abortedByCaller = true;
    controller.abort();
  };

  if (options?.signal?.aborted) abortFromCaller();
  else options?.signal?.addEventListener("abort", abortFromCaller, { once: true });

  const q = query({
    prompt,
    options: {
      cwd,
      ...(model ? { model } : {}),
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      tools: [],
      allowedTools: [],
      disallowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
      permissionMode: "dontAsk",
      abortController: controller,
      pathToClaudeCodeExecutable: cliPath,
      env: { ...process.env, ...clientAppEnv() },
    },
  });

  const close = () => {
    try {
      q.close();
    } catch {
      // The SDK may already have closed its subprocess.
    }
  };

  timeoutHandle = setTimeout(() => {
    controller.abort();
    close();
  }, timeoutMs);

  let assistantText = "";
  try {
    for await (const event of q) {
      const value = event as Record<string, unknown>;
      if (value.type === "assistant") {
        const message = value.message;
        const content = message && typeof message === "object" && "content" in message
          ? (message as { content?: unknown }).content
          : undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") continue;
            if ((block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
              assistantText += (block as { text: string }).text;
            }
          }
        }
      }
      if (value.type === "result") {
        const result = typeof value.result === "string" ? value.result : "";
        if (result.trim()) return result;
      }
    }
    if (abortedByCaller) throw new Error("Claude utility prompt cancelled");
    return assistantText;
  } catch (error) {
    if (abortedByCaller) throw new Error("Claude utility prompt cancelled");
    throw new Error(reportError("CLAUDE_UTILITY_ERR", error, { context: "composer-prediction" }));
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options?.signal?.removeEventListener("abort", abortFromCaller);
    close();
  }
}
