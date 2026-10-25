import { describe, expect, it, vi } from "vitest";
import { prepareWireMessages } from "./message-wire";
describe("wire preparation", () => {
  it("encodes only changed messages while accepting cloned history", () => {
    const encode = vi.fn(JSON.stringify);
    const messages = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), content: "文".repeat(5000) }));
    const first = prepareWireMessages(messages, [], encode);
    encode.mockClear();
    const cloned = messages.map(m => ({ ...m })); cloned[1999].content += "tail";
    const next = prepareWireMessages(cloned, first, encode);
    expect(encode).toHaveBeenCalledTimes(1); expect(next[0]).toBe(first[0]);
    expect(next[1999].json).toBe(JSON.stringify(cloned[1999]));
  });
  it("detects nested mutations, deletion, undefined and key order", () => {
    const message = { id: "a", tool: { nested: [1, 2] }, content: "old" };
    const first = prepareWireMessages([message]); message.tool.nested[1] = 3;
    const second = prepareWireMessages([message], first);
    expect(second[0].json).toBe(JSON.stringify(message));
    expect(first[0].json).toContain("[1,2]");
    expect(prepareWireMessages([{ id: "a", content: undefined }], second)[0].json).toBe('{"id":"a"}');
  });
  it("does not cache custom JSON or getters and preserves encoding failures", () => {
    let n = 0; const custom = { id: "a", toJSON: () => ({ id: "a", n: ++n }) };
    const first = prepareWireMessages([custom]);
    expect(prepareWireMessages([custom], first)[0].json).not.toBe(first[0].json);
    const getter = { id: "g", get value() { return ++n; } };
    const snapshot = prepareWireMessages([getter]);
    expect(prepareWireMessages([getter], snapshot)[0].json).not.toBe(snapshot[0].json);
    const cyclic: { id: string; child?: object } = { id: "c" }; cyclic.child = cyclic;
    expect(() => prepareWireMessages([cyclic])).toThrow();
  });
  it("preserves __proto__ keys and sparse arrays", () => {
    const message: { id: string; value: unknown } = { id: "p", value: JSON.parse('{"__proto__":{"x":1},"a":[null,2]}') };
    const first = prepareWireMessages([message]);
    expect(prepareWireMessages([message], first)[0]).toBe(first[0]);
    message.value = [ , 2 ];
    expect(prepareWireMessages([message], first)[0].json).toBe(JSON.stringify(message));
  });
});
