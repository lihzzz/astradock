import { createRoot } from "react-dom/client";
import PagedHistoryDialog from "@/components/history/PagedHistoryDialog";
import { I18nProvider } from "@/lib/i18n";
import "@/index.css";
createRoot(document.getElementById("root")!).render(<I18nProvider><PagedHistoryDialog projectId="fixture" sessionId="fixture" title="Generated history · 250 messages" onClose={() => {}} /></I18nProvider>);
