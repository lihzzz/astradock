import { memo, useEffect, useState } from "react";
import { useStore } from "zustand";
import { CheckCircle2, Fingerprint, Loader2, Play, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PanelHeader } from "@/components/PanelHeader";
import { reportError } from "@/lib/analytics/analytics";
import { fingerprintProbeStore } from "@/stores/fingerprint-probe-store";
import type { CodexFingerprintProbeResult, CodexFingerprintVerdict } from "@/types";
import type { CodexModel } from "@shared/types/codex";

interface FingerprintProbePanelProps {
  sessionId: string | null;
  cwd: string | undefined;
  headerControls?: React.ReactNode;
  /** Render only the body when embedded in the unified Model Tests panel. */
  embedded?: boolean;
}

const neutralStyle = "bg-foreground/[0.06] text-muted-foreground";
const cautionStyle = "bg-amber-500/10 text-amber-600 dark:text-amber-300";
const verdictStyles: Record<CodexFingerprintVerdict["verdict"], string> = {
  MATCH: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  SUSPICIOUS: cautionStyle,
  MISMATCH: "bg-red-500/10 text-red-600 dark:text-red-300",
  UNLISTED: neutralStyle,
  INVALID: neutralStyle,
  UNKNOWN: neutralStyle,
};

function verdictStyle(verdict: CodexFingerprintVerdict): string {
  return verdict.verdict === "MATCH" && verdict.confidence !== "high"
    ? cautionStyle
    : verdictStyles[verdict.verdict];
}

function verdictLabel(verdict: CodexFingerprintVerdict): string {
  return verdict.verdict === "MATCH" && verdict.confidence !== "high"
    ? "MATCH · low confidence"
    : verdict.verdict;
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export const FingerprintProbePanel = memo(function FingerprintProbePanel({ sessionId, cwd, headerControls, embedded = false }: FingerprintProbePanelProps) {
  const {
    selectedModel, setSelectedModel, selectedEffort, setSelectedEffort,
    probeTarget, running, result, latestAttempt, probeError,
    changeTarget: setProbeTarget, runProbe,
  } = useStore(fingerprintProbeStore);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.claude.codex.listModels()
      .then((response) => {
        if (cancelled) return;
        if (response.error) {
          setModelsError(response.error);
          setModels([]);
        } else {
          setModelsError(null);
          setModels(response.models ?? []);
          if (!fingerprintProbeStore.getState().selectedModel) {
            setSelectedModel(response.models.find((model) => model.isDefault)?.id ?? response.models[0]?.id ?? "");
          }
        }
      })
      .catch((error: unknown) => {
        const message = reportError("fingerprint:list-models", error);
        if (!cancelled) setModelsError(message);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setSelectedModel]);

  const currentModel = models.find((model) => model.id === selectedModel);
  const effortOptions = currentModel?.supportedReasoningEfforts ?? [];
  const activeEffort = effortOptions.find((option) => option.reasoningEffort === selectedEffort)?.reasoningEffort
    ?? effortOptions.find((option) => option.reasoningEffort === currentModel?.defaultReasoningEffort)?.reasoningEffort
    ?? effortOptions[0]?.reasoningEffort;
  const canRun = probeTarget === "current" ? sessionId != null : currentModel != null && !modelsLoading;

  const changeTarget = (target: string) => {
    if (target !== "fresh" && target !== "current") return;
    if (target === "current" && sessionId == null) return;
    setProbeTarget(target);
  };

  const startProbe = () => {
    if (!canRun) return;
    void runProbe({
      model: selectedModel,
      cwd,
      ...(probeTarget === "current" && sessionId != null ? { sessionId } : { effort: activeEffort }),
    });
  };

  const displayedResult = result ?? latestAttempt;
  const previousResult = result != null && (running || probeError != null || (latestAttempt != null && latestAttempt !== result));
  const sampleResult = latestAttempt ?? (!running && !probeError ? result : null);
  const latestVerdict = latestAttempt?.verdict ?? result?.verdict;

  return (
    <div className={embedded ? "h-full" : "flex h-full flex-col"}>
      {!embedded && (
        <PanelHeader icon={Fingerprint} label="Fingerprint Probe" iconClass="text-fuchsia-600/70 dark:text-fuchsia-200/50">
          {headerControls}
        </PanelHeader>
      )}

      <ScrollArea className={embedded ? "h-full min-h-0" : "flex-1 min-h-0"}>
        <div className="space-y-3 p-3">
          <div className="space-y-2 rounded-lg border border-border/50 bg-background/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">Probe target</span>
              {running ? (
                <Badge variant="secondary">Running</Badge>
              ) : probeError && !latestAttempt ? (
                <Badge variant="secondary" className={neutralStyle}>Failed</Badge>
              ) : latestVerdict ? (
                <Badge variant="secondary" className={verdictStyle(latestVerdict)}>{verdictLabel(latestVerdict)}</Badge>
              ) : null}
            </div>
            <Select value={probeTarget} onValueChange={changeTarget} disabled={running}>
              <SelectTrigger size="sm" className="w-full text-foreground/80" aria-label="Probe target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fresh">Fresh session</SelectItem>
                <SelectItem value="current" disabled={sessionId == null}>Current session</SelectItem>
              </SelectContent>
            </Select>
            {probeTarget === "fresh" ? (
              <>
                <span className="text-[11px] font-medium text-muted-foreground">Target model</span>
                <Select value={selectedModel} onValueChange={setSelectedModel} disabled={modelsLoading || running}>
                  <SelectTrigger size="sm" className="w-full text-foreground/80" aria-label="Target model">
                    <SelectValue placeholder={modelsLoading ? "Loading models…" : "Select model"} />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>{model.displayName || model.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {effortOptions.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-[11px] font-medium text-muted-foreground">Reasoning effort</span>
                    <Select value={activeEffort} onValueChange={setSelectedEffort} disabled={modelsLoading || running}>
                      <SelectTrigger size="sm" className="w-full capitalize text-foreground/80" aria-label="Reasoning effort">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {effortOptions.map((option) => (
                          <SelectItem key={option.reasoningEffort} value={option.reasoningEffort} className="capitalize">
                            {option.reasoningEffort}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            ) : (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {sessionId == null
                  ? "Select a live Codex session to probe, or switch to Fresh session."
                  : "Inherits this session's model, provider, and reasoning effort. Samples run in temporary branches of this session."}
              </p>
            )}
            <Button size="sm" onClick={startProbe} disabled={!canRun || running}>
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground/60">
              Compares three short model responses with the local fingerprint bank using your Codex account.
              {probeTarget === "fresh" ? " This tests fresh sessions." : " This tests the current session."}
              {" Settings, progress, and results are shared across all sessions."}
            </p>
            {modelsError && probeTarget === "fresh" && <p className="text-[10px] text-red-500">{modelsError}</p>}
            {probeError && (
              <div role="alert" className="space-y-1 text-[10px] leading-relaxed text-red-500">
                <p>Latest attempt: {probeError}</p>
                {!latestAttempt && <p>No samples were returned.</p>}
              </div>
            )}
          </div>

          {displayedResult && <FingerprintResultSummary result={displayedResult} previous={previousResult} />}

          {sampleResult && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Latest attempt samples</p>
              {sampleResult.samples.map((sample) => {
                const diagnostic = sampleResult.analysis?.diagnostics.find((entry) => entry.index === sample.sampleId);
                return (
                  <div key={sample.sampleId} className="space-y-1 rounded-lg border border-border/50 bg-background/70 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold text-foreground/70">Sample {sample.sampleId + 1}</span>
                      <Badge variant="secondary" className="h-4 rounded-full px-1.5 text-[9px] tabular-nums">
                        {sample.parsedCount}/{sample.requestedCount}
                      </Badge>
                    </div>
                    <p className="wrap-break-word text-[10px] leading-relaxed text-muted-foreground/60">Prompt: {sample.prompt}</p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-foreground/[0.03] p-2 font-mono text-[10px] leading-relaxed text-foreground/75">
                      {sample.response || "(empty response)"}
                    </pre>
                    {sample.error && <p className="wrap-break-word text-[10px] text-red-500">{sample.error}</p>}
                    <p className="text-[10px] text-muted-foreground/60">
                      {sample.accepted ? "Accepted" : "Rejected"} · parsed {sample.parsedCount}
                      {diagnostic ? `, minimum ${diagnostic.minimumNumbers}` : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {!displayedResult && !running && !probeError && !modelsError && (
            <p className="px-1 py-2 text-[10px] leading-relaxed text-muted-foreground/60">
              Run a probe to compare the model's responses with known fingerprints.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

function FingerprintResultSummary({ result, previous }: { result: CodexFingerprintProbeResult; previous: boolean }) {
  const strongMatch = result.verdict.verdict === "MATCH" && result.verdict.confidence === "high";
  const analysis = result.analysis;
  return (
    <div className="space-y-3 rounded-lg border border-border/50 bg-background/70 p-3">
      {previous && <p className="text-[10px] font-semibold text-muted-foreground">Last valid result · retained from the previous probe</p>}
      <div className="flex items-start gap-2">
        {strongMatch ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" />
        ) : result.verdict.verdict === "MATCH" ? (
          <Fingerprint className="mt-0.5 h-4 w-4 text-amber-500" />
        ) : (
          <ShieldAlert className={`mt-0.5 h-4 w-4 ${result.verdict.verdict === "MISMATCH" ? "text-red-500" : "text-muted-foreground"}`} />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-semibold text-foreground">{result.verdict.message}</p>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {result.mode === "fork" ? "Session fork" : "Fresh sessions"} · {analysis?.usedOutputs ?? 0} valid samples · {(result.elapsedMs / 1000).toFixed(1)}s
          </p>
        </div>
      </div>
      <dl className="grid gap-1 text-[10px] text-muted-foreground">
        {result.parentThreadId && <div><dt className="inline">Source session: </dt><dd className="inline wrap-break-word font-mono text-foreground/80">{result.parentThreadId}</dd></div>}
        <div><dt className="inline">Expected model: </dt><dd className="inline wrap-break-word font-mono text-foreground/80">{result.selectedModel}</dd></div>
        <div><dt className="inline">Server-reported model: </dt><dd className="inline wrap-break-word font-mono text-foreground/80">{result.actualModel ?? "Not reported"}</dd></div>
        <div><dt className="inline">Statistical prediction: </dt><dd className="inline wrap-break-word font-mono text-foreground/80">{analysis?.prediction ?? "Unavailable"}</dd>{analysis && ` · ${formatPercent(analysis.probability)}`}</div>
        {result.reasoningEffort && <div><dt className="inline">Reasoning effort: </dt><dd className="inline">{result.reasoningEffort}</dd></div>}
        {result.modelProvider && <div><dt className="inline">Provider: </dt><dd className="inline wrap-break-word">{result.modelProvider}</dd></div>}
      </dl>
      {result.verdict.verdict === "MATCH" && !strongMatch && (
        <p className="text-[10px] leading-relaxed text-amber-600 dark:text-amber-300">Low confidence: the closest fingerprint matches, but the evidence is limited.</p>
      )}
      {result.verdict.verdict === "UNLISTED" && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">The expected model is outside the fingerprint bank. Its nearest candidate cannot establish a model downgrade.</p>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Statistical comparison only. Probabilities rank models in the bank and do not verify model identity.
      </p>
      {analysis && (
        <>
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">Probabilities within the fingerprint bank</p>
            {analysis.results.map((candidate) => (
              <div key={candidate.model} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] text-foreground/70">{candidate.model}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatPercent(candidate.probability)}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                  <div className="h-full rounded-full bg-foreground/35" style={{ width: `${Math.min(100, Math.max(0, candidate.probability * 100))}%` }} />
                </div>
              </div>
            ))}
          </div>
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer">Scoring details</summary>
            <div className="mt-1 grid gap-1">
              <span>Expected-model probability: {formatPercent(result.verdict.selectedModelProbability)}</span>
              <span>Score margin: {result.verdict.margin == null ? "—" : result.verdict.margin.toFixed(2)}</span>
              <span>Calibration: n={analysis.calibration.queries}, β={analysis.calibration.beta.toFixed(2)}, CV accuracy={formatPercent(analysis.calibration.cvAccuracy)}</span>
              <span className="wrap-break-word">Method: {analysis.method}</span>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
