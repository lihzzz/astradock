import { I18nProvider } from "@/lib/i18n";
﻿import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/analytics/analytics", () => ({ reportError: vi.fn() }));
import { MemorySettings } from "./MemorySettings";
describe("fixed brain settings", () => {
  it("renders the single switch and connection controls without manual binding fields", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(MemorySettings, { appSettings: null, onUpdateAppSettings: async () => {} }) }));
    expect(html).toContain('role="switch"'); expect(html).toContain("AstraDock 记忆（自动管理）");
    expect(html).toContain("查看记忆"); expect(html).toContain("连接设置"); expect(html).toContain('type="password"');
    for (const label of ["文档 ID", "摘要块", "只读范围", "项目记忆绑定", "身份锚点", "预期工作空间路径"]) expect(html).not.toContain(label);
  });
});
