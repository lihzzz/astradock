import { memo, useEffect, useState } from "react";
import { useStore } from "zustand";
import { CheckCircle2, CircleAlert, Loader2, Play, TestTube2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { reportError } from "@/lib/analytics/analytics";
import { candyModelTestStore } from "@/stores/candy-model-test-store";
import { fingerprintProbeStore } from "@/stores/fingerprint-probe-store";
import type { CodexCandyTestResult } from "@shared/types/codex-model-test";
import type { CodexModel } from "@shared/types/codex";

interface CandyModelTestPanelProps {
  sessionId: string | null;
  cwd: string | undefined;
}

const neutralStyle = "bg-foreground/[0.06] text-muted-foreground";
const successStyle = "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
const cautionStyle = "bg-amber-500/10 text-amber-600 dark:text-amber-300";
const failureStyle = "bg-red-500/10 text-red-600 dark:text-red-300";

function formatPercent(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatTokens(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function resultStatus(result: CodexCandyTestResult | null): { label: string; className: string } | null {
  if (!result) return null;
  if (result.error && result.samples.length === 0) return { label: "Failed", className: failureStyle };
  if (result.accuracy === 1) return { label: "Passed", className: successStyle };
  if (result.accuracy != null && result.accuracy > 0) return { label: "Partial", className: cautionStyle };
  return { label: "Failed", className: failureStyle };
}

export const CandyModelTestPanel = memo(function CandyModelTestPanel({ sessionId, cwd }: CandyModelTestPanelProps) {
  const {
    selectedModel, setSelectedModel, selectedEffort, setSelectedEffort,
    probeTarget, setTarget: setProbeTarget,
  } = useStore(fingerprintProbeStore);
  const {
    selectedRuns, setSelectedRuns, running, result, latestAttempt, testError, clearResults, runTest,
  } = useStore(candyModelTestStore);
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
        const message = reportError("model-test:list-models", error);
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
    clearResults();
    setProbeTarget(target);
  };

  const startTest = () => {
    if (!canRun) return;
    void runTest({
      model: selectedModel,
      cwd,
      tests: selectedRuns,
      ...(probeTarget === "current" && sessionId != null ? { sessionId } : { effort: activeEffort }),
    });
  };

  const displayedResult = result ?? latestAttempt;
  const previousResult = result != null && (running || testError != null || (latestAttempt != null && latestAttempt !== result));
  const sampleResult = latestAttempt ?? (!running && !testError ? result : null);
  const status = resultStatus(displayedResult);
  const completedSamples = sampleResult?.samples.filter((sample) => !sample.error).length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-3 p-3">
          <div className="space-y-2 rounded-lg border border-border/50 bg-background/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">Model test</span>
              {running ? <Badge variant="secondary">Running</Badge> : status ? <Badge variant="secondary" className={status.className}>{status.label}</Badge> : null}
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              Runs the Codex candy-math benchmark from codex-candy-eval in isolated, tool-free temporary threads.
            </p>

            <span className="text-[11px] font-medium text-muted-foreground">Probe target</span>
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
                  ? "Select a live Codex session to test, or switch to Fresh session."
                  : "Inherits this session's model, provider, and reasoning effort; the test runs in temporary branches."}
              </p>
            )}

            <span className="text-[11px] font-medium text-muted-foreground">Runs</span>
            <Select value={String(selectedRuns)} onValueChange={(value) => setSelectedRuns(Number(value))} disabled={running}>
              <SelectTrigger size="sm" className="w-full text-foreground/80" aria-label="Number of runs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 3, 5, 10].map((count) => <SelectItem key={count} value={String(count)}>{count} {count === 1 ? "run" : "runs"}</SelectItem>)}
              </SelectContent>
            </Select>

            <Button size="sm" onClick={startTest} disabled={!canRun || running}>
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run test
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground/60">
              Correctness matches the upstream evaluator: an independent <code>21</code> in the final response counts as correct.
              {probeTarget === "fresh" ? " Fresh sessions are used." : " The current session is forked without touching its conversation."}
            </p>
            {modelsError && probeTarget === "fresh" && <p className="text-[10px] text-red-500">{modelsError}</p>}
            {testError && (
              <div role="alert" className="space-y-1 text-[10px] leading-relaxed text-red-500">
                <p>Latest attempt: {testError}</p>
                {!latestAttempt && <p>No samples were returned.</p>}
              </div>
            )}
          </div>

          {displayedResult && <CandyResultSummary result={displayedResult} previous={previousResult} />}

          {sampleResult && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                Latest attempt samples · {completedSamples}/{sampleResult.requestedTests} completed
              </p>
              {sampleResult.samples.map((sample) => (
                <div key={sample.sampleId} className="space-y-1 rounded-lg border border-border/50 bg-background/70 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold text-foreground/70">Run {sample.sampleId + 1}</span>
                    <Badge variant="secondary" className={`h-4 rounded-full px-1.5 text-[9px] tabular-nums ${sample.error ? neutralStyle : sample.passed ? successStyle : failureStyle}`}>
                      {sample.error ? "Error" : sample.passed ? "Correct" : "Incorrect"}
                    </Badge>
                  </div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-foreground/[0.03] p-2 font-mono text-[10px] leading-relaxed text-foreground/75">
                    {sample.response || "(empty response)"}
                  </pre>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
                    <span>Time: {formatDuration(sample.elapsedMs)}</span>
                    <span>TPS: {sample.tps == null ? "—" : sample.tps.toFixed(1)}</span>
                    <span>Output: {formatTokens(sample.outputTokens)}</span>
                    <span>Reasoning: {formatTokens(sample.reasoningOutputTokens)}</span>
                  </div>
                  {sample.error && <p className="wrap-break-word text-[10px] text-red-500">{sample.error}</p>}
                </div>
              ))}
            </div>
          )}

          {!displayedResult && !running && !testError && !modelsError && (
            <div className="flex gap-2 px-1 py-2 text-[10px] leading-relaxed text-muted-foreground/60">
              <TestTube2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>Run this benchmark to compare answer accuracy, latency, output tokens, and reasoning tokens for the selected model.</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

function CandyResultSummary({ result, previous }: { result: CodexCandyTestResult; previous: boolean }) {
  const passed = result.accuracy === 1;
  const partial = result.accuracy != null && result.accuracy > 0 && !passed;
  return (
    <div className="space-y-3 rounded-lg border border-border/50 bg-background/70 p-3">
      {previous && <p className="text-[10px] font-semibold text-muted-foreground">Last valid result · retained from the previous test</p>}
      <div className="flex items-start gap-2">
        {passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" /> : partial ? <TestTube2 className="mt-0.5 h-4 w-4 text-amber-500" /> : <CircleAlert className="mt-0.5 h-4 w-4 text-red-500" />}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-semibold text-foreground">
            {result.error ? result.error : `${result.passedTests}/${result.requestedTests} correct · accuracy ${formatPercent(result.accuracy)}`}
          </p>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {result.mode === "fork" ? "Session fork" : "Fresh sessions"} · {(result.elapsedMs / 1000).toFixed(1)}s total
          </p>
        </div>
      </div>
      <dl className="grid gap-1 text-[10px] text-muted-foreground">
        {result.parentThreadId && <div><dt className="inline">Source session: </dt><dd className="inline wrap-break-word font-mono text-foreground/80">{result.parentThreadId}</dd></div>}
        <div><dt className="inline">Expected model: </dt><dd className="inline wrap-break-word font-mono text-foreground/80">{result.selectedModel}</dd></div>
        <div><dt className="inline">Server-reported model: </dt><dd className="inline wrap-break-word font-mono text-foreground/80">{result.actualModel ?? "Not reported"}</dd></div>
        {result.reasoningEffort && <div><dt className="inline">Reasoning effort: </dt><dd className="inline capitalize">{result.reasoningEffort}</dd></div>}
        {result.modelProvider && <div><dt className="inline">Provider: </dt><dd className="inline wrap-break-word">{result.modelProvider}</dd></div>}
      </dl>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        This is a behavioral benchmark, not a proof of model identity. Use Fingerprint Probe for statistical model-routing evidence.
      </p>
    </div>
  );
}
