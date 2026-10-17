import type { ImageAttachment } from "@/types";

// New-chat entry points intentionally share one draft. Established sessions use
// their own identity, independent of the project, engine or pane displaying them.
export function getComposerDraftKey(sessionId: string | null | undefined): string {
  return sessionId ?? "__draft__";
}

export interface ComposerDraft {
  /** Locally created editor markup, preserving mention chips and line breaks. */
  html: string;
  hasContent: boolean;
  attachments: ImageAttachment[];
}

export class ComposerDraftStore {
  private readonly drafts = new Map<string, ComposerDraft>();

  get(key: string): ComposerDraft | undefined {
    return this.drafts.get(key);
  }

  save(key: string, draft: ComposerDraft): void {
    if (!draft.hasContent && draft.attachments.length === 0 && !draft.html) {
      this.drafts.delete(key);
      return;
    }
    this.drafts.set(key, { ...draft, attachments: [...draft.attachments] });
  }

  delete(key: string): void {
    this.drafts.delete(key);
  }
}

// Memory-only: drafts survive composer unmounts/layout changes, without writing
// potentially sensitive unsent text or base64 image data to localStorage.
export const composerDrafts = new ComposerDraftStore();
