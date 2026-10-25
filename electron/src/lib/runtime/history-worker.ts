import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { ThreadPageQuery, ThreadChunkQuery } from "@shared/types/runtime-history";
import { RuntimeError } from "@shared/types/runtime";
import { ThreadReadIndex } from "./read-index";
const Request = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("page"), source: z.string(), query: ThreadPageQuery }),
  z.object({ id: z.string(), kind: z.literal("chunk"), source: z.string(), query: ThreadChunkQuery }),
]);
const { directory } = z.object({ directory: z.string() }).parse(workerData);
const index = new ThreadReadIndex(directory);
let queue = Promise.resolve();
parentPort?.on("message", (input: unknown) => {
  const request = Request.safeParse(input); if (!request.success) return;
  queue = queue.then(async () => {
    const { id, source, query } = request.data;
    try {
      const value = request.data.kind === "page" ? await index.page(source, request.data.query) : await index.chunk(source, request.data.query);
      parentPort?.postMessage({ id, ok: true, value });
    } catch (error) {
      parentPort?.postMessage({ id, ok: false, error: { code: error instanceof RuntimeError ? error.code : "HISTORY_READ_FAILED", message: error instanceof Error ? error.message : "History read failed" } });
    }
    // Keep references to request data inside this bounded request only.
    void query;
  });
});
