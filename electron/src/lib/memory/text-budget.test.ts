import { expect, it } from "vitest";
import { clipMemoryText } from "./text-budget";
it("bounds UTF-8 bytes without splitting a code point", () => { expect(clipMemoryText("你好🙂abc", 9)).toBe("你好"); expect(clipMemoryText("你好🙂abc", 10)).toBe("你好🙂"); expect(clipMemoryText("abc", 0)).toBe(""); });
