import type { ImageAttachment } from "@/types";
import { describe, expect, it } from "vitest";
import { ComposerDraftStore, getComposerDraftKey } from "./composer-drafts";

const draft = (html: string) => ({ html, hasContent: !!html, attachments: [] });

describe("composer drafts", () => {
  it("isolates existing sessions and restores their unsent content", () => {
    const store = new ComposerDraftStore();
    store.save(getComposerDraftKey("a"), draft("First draft"));
    expect(store.get(getComposerDraftKey("b"))).toBeUndefined();
    store.save(getComposerDraftKey("b"), draft("Second draft"));
    expect(store.get("a")?.html).toBe("First draft");
    expect(store.get("b")?.html).toBe("Second draft");
  });

  it("shares new-chat drafts without leaking them into established sessions", () => {
    const store = new ComposerDraftStore();
    store.save(getComposerDraftKey("__draft__"), draft("New chat"));
    expect(store.get(getComposerDraftKey(null))?.html).toBe("New chat");
    expect(store.get(getComposerDraftKey(undefined))?.html).toBe("New chat");
    expect(store.get(getComposerDraftKey("live"))).toBeUndefined();
  });

  it("retains rich mention markup, line breaks and image-only drafts", () => {
    const store = new ComposerDraftStore();
    const html = '<span data-mention-path="src/main.ts" contenteditable="false">main.ts</span><div>Next line</div>';
    store.save("a", draft(html));
    expect(store.get("a")?.html).toBe(html);
    const attachments: ImageAttachment[] = [{ id: "image", data: "base64", mediaType: "image/png", fileName: "image.png" }];
    store.save("b", { ...draft(""), attachments });
    attachments.length = 0;
    expect(store.get("b")?.attachments).toHaveLength(1);
    expect(store.get("a")?.attachments).toEqual([]);
  });

  it("clears only the sent session and does not resurrect an empty draft", () => {
    const store = new ComposerDraftStore();
    store.save("a", draft("Send me"));
    store.save("b", draft("Keep me"));
    store.delete("a");
    store.save("a", draft(""));
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")?.html).toBe("Keep me");
  });
});
