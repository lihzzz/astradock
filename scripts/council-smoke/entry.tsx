import { createRoot } from "react-dom/client";
import { CouncilView } from "@/components/council/CouncilView";
import { I18nProvider } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import "@/index.css";
useSettingsStore.getState().setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(<I18nProvider><main className="h-screen overflow-auto bg-background p-6 text-foreground"><CouncilView projects={[{ id: "fixture", name: "Council fixture", path: "fixture", createdAt: 0 }]} sourceMaterials="Public synthetic fixture. No user data or provider calls." onOpenTasks={() => { document.title = "task-created"; }}/></main></I18nProvider>);
