import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useSpaceManager } from "./useSpaceManager";
import { capture } from "@/lib/analytics/analytics";

vi.mock("@/lib/analytics/analytics", () => ({ capture: vi.fn() }));
const save = vi.fn();

function getManager() {
  const result: { current: ReturnType<typeof useSpaceManager> | null } = { current: null };
  function Harness() { result.current = useSpaceManager(); return null; }
  renderToStaticMarkup(<Harness />);
  if (!result.current) throw new Error("Hook did not render");
  return result.current;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("window", { claude: { spaces: { save } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("space creation persistence", () => {
  it("does not persist anything when the manager is rendered", () => {
    getManager();
    expect(save).not.toHaveBeenCalled();
  });
  it("saves complete details before reporting success", async () => {
    save.mockResolvedValue({ ok: true });
    const space = await getManager().createSpace("Research", "🧪", "emoji", { hue: 200, chroma: 0.15 });
    expect(save).toHaveBeenCalledWith([space]);
    expect(space).toMatchObject({ name: "Research", icon: "🧪", iconType: "emoji", color: { hue: 200, chroma: 0.15 } });
    expect(capture).toHaveBeenCalledWith("space_created", expect.any(Object));
  });
  it("rejects IPC error results instead of creating a ghost space", async () => {
    save.mockResolvedValue({ error: "Disk is full" });
    await expect(getManager().createSpace("Work", "⭐", "emoji", { hue: 0, chroma: 0 })).rejects.toThrow("Disk is full");
    expect(capture).not.toHaveBeenCalled();
  });
  it("propagates transport failures so the form can retain the draft", async () => {
    save.mockRejectedValue(new Error("IPC disconnected"));
    await expect(getManager().createSpace("Work", "⭐", "emoji", { hue: 0, chroma: 0 })).rejects.toThrow("IPC disconnected");
    expect(capture).not.toHaveBeenCalled();
  });
});
