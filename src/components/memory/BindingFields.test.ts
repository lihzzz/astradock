import { describe, expect, it } from "vitest";
import { formatScopes, parseIds, parseScopes } from "./BindingFields";
describe("memory binding fields", () => {
  it("round trips exact and descendant scope forms", () => { const scopes = [{ notebookId: "notebook", documentId: "document", includeDescendants: true }, { notebookId: "notebook", documentId: "other", includeDescendants: false }]; expect(parseScopes(formatScopes(scopes))).toEqual(scopes); });
  it("rejects malformed or ambiguous scope paths", () => { for (const text of ["notebook", "notebook/doc/anything", "notebook/doc/*/extra"]) expect(() => parseScopes(text)).toThrow(); });
  it("splits explicit summary IDs without executing content", () => { expect(parseIds("one, two\nthree")).toEqual(["one", "two", "three"]); });
});
