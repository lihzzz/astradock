import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
const language = vi.hoisted(() => ({ value: "zh-CN" as "zh-CN" | "en" }));
vi.mock("@/stores/settings-store", () => ({ useSettingsStore: <T,>(selector: (state: { language: "zh-CN" | "en"; setLanguage: (value: "zh-CN" | "en") => void }) => T): T => selector({ language: language.value, setLanguage: value => { language.value = value; } }) }));
import type { MemoryTraceEvent } from "@shared/types/memory-intelligence";
import { MemoryTrace } from "./MemoryTrace";
const event:MemoryTraceEvent={id:"fixture",projectId:"p",sessionId:"s",turnId:"t",at:1,stage:"dispatch_confirmed",reason:"ok",count:1,bytes:80};
afterEach(()=>language.value="zh-CN");
function render(events:MemoryTraceEvent[]){return renderToStaticMarkup(createElement(I18nProvider,{children:createElement(MemoryTrace,{events})}));}
describe("bounded, honest memory trace",()=>{
  it("does not equate accepted input with model adoption in English",()=>{language.value="en";const html=render([event]);expect(html).toContain("not proof of adoption");expect(html).toContain("Search hits");});
  it("supports Chinese stage explanations",()=>{language.value="zh-CN";const html=render([{...event,stage:"dispatch_attempted",reason:"delivery_unconfirmed"}]);expect(html).toContain("未确认");expect(html).toContain("≠ 模型采用");});
  it("mounts no more than the last thirty stages",()=>{const html=render(Array.from({length:256},(_,i)=>({...event,id:String(i)})));expect((html.match(/<li /g)||[]).length).toBe(30);});
});
