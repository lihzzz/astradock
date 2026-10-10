export interface ManagedQuitActions {
  stop: () => Promise<void>;
  onFailure: (error: unknown) => Promise<"retry" | "cancel" | "force">;
}
class ManagedQuitTimeout extends Error {
  constructor() { super("Application cleanup has not finished after 15 seconds. Retry to keep waiting, cancel quitting, or explicitly force exit."); }
}

/** A timed out cleanup remains live: Retry observes the same attempt rather than
 * launching a competing shutdown. Only an explicit decision allows force exit. */
export async function prepareManagedQuit(actions: ManagedQuitActions): Promise<boolean> {
  let pending: Promise<void> | null = null;
  for (;;) {
    pending ??= Promise.resolve().then(actions.stop);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ManagedQuitTimeout()), 15_000); })]);
      return true;
    } catch (error) {
      if (timer) clearTimeout(timer);
      const decision = await actions.onFailure(error);
      if (decision === "cancel") return false;
      if (decision === "force") return true;
      if (!(error instanceof ManagedQuitTimeout)) pending = null;
    } finally { if (timer) clearTimeout(timer); }
  }
}
