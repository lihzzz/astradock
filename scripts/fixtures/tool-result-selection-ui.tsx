import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ToolResultSelection, SelectableToolResult } from "../../src/components/ToolResultSelection";
import { I18nProvider, useI18n } from "../../src/lib/i18n";
import { useSettingsStore } from "../../src/stores/settings-store";
import type { UIMessage } from "../../src/types";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const messages: UIMessage[] = [
  { id: "transfer", role: "user", content: "Synthetic transferred context", timestamp: 0 },
  { id: "tool", role: "tool_call", content: "", toolName: "Read", toolResult: { content: "Fixture result" }, timestamp: 1 },
];

function TransferMessage() {
  const { t } = useI18n();
  const text = t("transferDisplayText")
    .replace("{{title}}", "hello")
    .replace("{{count}}", "13")
    .replace("{{target}}", "Codex");
  return <div className="mx-4 mb-4 flex justify-end">
    <div data-message className="min-w-0 rounded-2xl bg-foreground/5 px-4 py-2 wrap-break-word">{text}</div>
  </div>;
}

function fixture(width: number, density: string) {
  const container = document.createElement("section");
  container.className = `relative flex flex-col overflow-hidden bg-background text-foreground ${density}`;
  Object.assign(container.style, { width: `${width}px`, height: "400px" });
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(
    <I18nProvider>
      <div data-header className="absolute inset-x-0 top-0 flex h-[52px] items-center justify-end px-4">Goal</div>
      <ToolResultSelection messages={messages}>
        <div data-scroll className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ paddingTop: 12, paddingBottom: 16 }}>
            <TransferMessage />
            <div className="mx-4">
              <SelectableToolResult message={messages[1]}><div>Read: fixture.txt</div></SelectableToolResult>
            </div>
            <div style={{ height: 800 }} />
          </div>
        </div>
      </ToolResultSelection>
    </I18nProvider>,
  ));
  const get = (selector: string) => {
    const element = container.querySelector<HTMLElement>(selector);
    assert(element, `Missing element: ${selector}`);
    return element;
  };
  return { container, get, unmount: () => { flushSync(() => root.unmount()); container.remove(); } };
}

type Fixture = ReturnType<typeof fixture>;

function assertLayout(f: Fixture, context: string) {
  const bounds = f.container.getBoundingClientRect();
  const toolbar = f.get('[role="group"]');
  const actions = toolbar.getBoundingClientRect();
  const header = f.get("[data-header]").getBoundingClientRect();
  const scroll = f.get("[data-scroll]");
  const viewport = scroll.getBoundingClientRect();
  assert(actions.top >= header.bottom, `${context}: actions overlap the chat header`);
  assert(actions.bottom <= viewport.top, `${context}: actions overlap the message viewport`);
  assert(viewport.height > 0, `${context}: no space remains for messages`);
  assert(actions.left >= bounds.left && actions.right <= bounds.right, `${context}: actions overflow the pane`);
  assert(toolbar.scrollWidth <= toolbar.clientWidth + 1, `${context}: actions overflow horizontally`);
  for (const button of toolbar.querySelectorAll("button")) {
    const rect = button.getBoundingClientRect();
    assert(rect.left >= actions.left && rect.right <= actions.right, `${context}: button is clipped`);
    assert(rect.top >= actions.top && rect.bottom <= actions.bottom, `${context}: button is outside its row`);
  }
  if (scroll.scrollTop === 0) {
    assert(f.get("[data-message]").getBoundingClientRect().top >= actions.bottom, `${context}: transfer message is covered`);
  }
}

function runToolResultSelectionChecks() {
  const results: string[] = [];
  for (const language of ["en-US", "zh-CN"] as const) {
    useSettingsStore.getState().setLanguage(language);
    for (const density of ["density-compact", "", "density-loose"]) {
      const f = fixture(840, density);
      const context = `${language}/${density || "normal"}`;
      try {
        assertLayout(f, `${context}/idle`);
        flushSync(() => f.get('[role="group"] button').click());
        assertLayout(f, `${context}/active`);
        const wideHeight = f.get('[role="group"]').getBoundingClientRect().height;
        const copyButton = f.get('[role="group"] button');
        assert(copyButton.hasAttribute("disabled"), `${context}: copy should require a selection`);
        flushSync(() => f.get('input[type="checkbox"]').click());
        assert(f.get('[role="status"]').textContent?.endsWith("1"), `${context}: result was not selected`);
        assert(!copyButton.hasAttribute("disabled"), `${context}: selected result cannot be copied`);

        // Resize the same mounted pane, as when opening a split pane/tool panel.
        for (const width of [360, 240]) {
          f.container.style.width = `${width}px`;
          assertLayout(f, `${context}/${width}px`);
        }
        assert(f.get('[role="group"]').getBoundingClientRect().height > wideHeight, `${context}: narrow actions did not wrap`);
        const toolbarTop = f.get('[role="group"]').getBoundingClientRect().top;
        f.get("[data-scroll]").scrollTop = 120;
        assert(f.get("[data-scroll]").scrollTop > 0, `${context}: messages cannot scroll`);
        assertLayout(f, `${context}/scrolled`);
        assert(f.get('[role="group"]').getBoundingClientRect().top === toolbarTop, `${context}: scrolling moves the actions`);

        flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
        assert(!f.container.querySelector('input[type="checkbox"]'), `${context}: Escape did not exit selection`);
        assertLayout(f, `${context}/exit`);
        f.get("[data-scroll]").scrollTop = 0;
        assertLayout(f, `${context}/narrow-idle`);
        flushSync(() => f.get('[role="group"] button').click());
        assert(f.get('[role="status"]').textContent?.endsWith("0"), `${context}: selection was not cleared`);
        flushSync(() => f.get('[role="group"] button[aria-label]').click());
        assert(!f.container.querySelector('input[type="checkbox"]'), `${context}: exit button did not exit selection`);
        results.push(`${context}: header/message clearance, resizing, wrapping, scrolling and selection controls passed`);
      } finally { f.unmount(); }
    }
  }
  useSettingsStore.getState().setLanguage("zh-CN");
  fixture(840, ""); // Leave a representative layout mounted for optional visual inspection.
  return results;
}

Object.assign(window, { runToolResultSelectionChecks });
