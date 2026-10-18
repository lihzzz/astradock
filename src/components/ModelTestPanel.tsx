import { memo } from "react";
import { FlaskConical } from "lucide-react";
import { useStore } from "zustand";

import { PanelHeader } from "@/components/PanelHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fingerprintProbeStore } from "@/stores/fingerprint-probe-store";
import { candyModelTestStore } from "@/stores/candy-model-test-store";
import { CandyModelTestPanel } from "@/components/CandyModelTestPanel";
import { FingerprintProbePanel } from "@/components/FingerprintProbePanel";

interface ModelTestPanelProps {
  sessionId: string | null;
  cwd: string | undefined;
  headerControls: React.ReactNode;
}

export const ModelTestPanel = memo(function ModelTestPanel({ sessionId, cwd, headerControls }: ModelTestPanelProps) {
  const { selectedTest: testKind, setSelectedTest: setTestKind, running: fingerprintRunning } = useStore(fingerprintProbeStore);
  const candyRunning = useStore(candyModelTestStore, (state) => state.running);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader icon={FlaskConical} label="Model Tests" iconClass="text-fuchsia-600/70 dark:text-fuchsia-200/50">
        {headerControls}
      </PanelHeader>
      <div className="shrink-0 space-y-1.5 border-b border-border/50 bg-background/40 px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">Test type</span>
        <Select value={testKind} disabled={fingerprintRunning || candyRunning} onValueChange={(value) => { if (value === "fingerprint" || value === "candy") setTestKind(value); }}>
          <SelectTrigger size="sm" className="w-full text-foreground/80" aria-label="Test type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fingerprint">Fingerprint Probe · model routing</SelectItem>
            <SelectItem value="candy">Candy Math · answer quality</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1">
        {testKind === "fingerprint" ? (
          <FingerprintProbePanel sessionId={sessionId} cwd={cwd} embedded />
        ) : (
          <CandyModelTestPanel sessionId={sessionId} cwd={cwd} />
        )}
      </div>
    </div>
  );
});
