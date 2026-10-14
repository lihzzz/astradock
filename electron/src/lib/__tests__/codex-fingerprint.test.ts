import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeFingerprintSamples, assessFingerprint, parseFingerprintNumbers } from "@shared/lib/codex-fingerprint";
import type {
  CodexFingerprintAnalysis,
  CodexFingerprintCandidate,
  CodexFingerprintSample,
} from "@shared/types/codex-fingerprint";
import parity from "./fixtures/modeltrace-parity.json";

interface ReferenceOutput {
  model_id: string;
  requested_count: number;
  text: string;
}

function readReference(value: unknown): ReferenceOutput {
  if (typeof value !== "object" || value === null ||
    !("model_id" in value) || typeof value.model_id !== "string" ||
    !("requested_count" in value) || typeof value.requested_count !== "number" ||
    !("text" in value) || typeof value.text !== "string") {
    throw new Error("Invalid ModelTrace reference fixture");
  }
  return { model_id: value.model_id, requested_count: value.requested_count, text: value.text };
}

const fixturePath = path.join(process.cwd(), "electron/src/lib/__tests__/fixtures/modeltrace-reference.jsonl");
const fixture = readFileSync(fixturePath, "utf8").trim().split("\n")
  .map((line) => readReference(JSON.parse(line)));
const modelIds = [...new Set(fixture.map((row) => row.model_id))];

function sampleAt(index: number, overrides: Partial<CodexFingerprintSample> = {}): CodexFingerprintSample {
  const row = fixture[index];
  return {
    sampleId: index,
    threadId: `${row.model_id}-${index}`,
    requestedCount: row.requested_count,
    prompt: "test",
    response: row.text,
    parsedCount: parseFingerprintNumbers(row.text).length,
    accepted: true,
    ...overrides,
  };
}

function candidate(model: string, probability: number, score: number, family = "gpt"): CodexFingerprintCandidate {
  return { model, displayName: model, family, familyName: family, probability, score,
    conditionalProbability: probability, profileSimilarity: 0.5 };
}

function analysisFor(results: CodexFingerprintCandidate[], usedOutputs = 3): CodexFingerprintAnalysis {
  const top = results[0];
  return {
    prediction: top?.model ?? "",
    predictionName: top?.displayName ?? "",
    probability: top?.probability ?? 0,
    usedOutputs,
    results,
    diagnostics: [],
    calibration: { queries: String(usedOutputs), beta: 12, cvAccuracy: 1 },
    familyPrediction: top?.family ?? "",
    familyPredictionName: top?.familyName ?? "",
    familyProbability: 1,
    familyProbabilities: [],
    method: "test",
  };
}

function mismatchAnalysis(usedOutputs = 3): CodexFingerprintAnalysis {
  return analysisFor([
    candidate("gpt-5.5", 0.8, 1),
    candidate("gpt-6-astra", 0.2, 0.5),
  ], usedOutputs);
}

describe("codex fingerprint scoring", () => {
  it.each([
    ["ignore 400 and 2, but 12 34 56 is valid", [12, 34, 56]],
    ["1 2 中文说明 3 4 5", [3, 4, 5]],
    ["1 2 разделитель 3 4 5", [3, 4, 5]],
    ["1 2 é 3 4 5", [3, 4, 5]],
    ["1 2 then 3 4", [1, 2]],
    ["0, 1, 355, 356", [1, 355]],
  ])("parses the longest integer run in %s", (text, numbers) => {
    expect(parseFingerprintNumbers(text)).toEqual(numbers);
  });

  it.each(modelIds)("attributes three reference outputs to %s", (modelId) => {
    const samples = fixture.flatMap((row, index) => row.model_id === modelId ? [sampleAt(index)] : []);
    const analysis = analyzeFingerprintSamples(samples);
    expect(analysis?.prediction).toBe(modelId);
    expect(analysis?.usedOutputs).toBe(3);
  });

  // Golden values come from the pinned upstream scorer, not this implementation.
  // They exercise 1/2/3-output calibration and all 16 candidate scores.
  it.each(parity.cases)("matches upstream numerical results for case %#", (expected) => {
    const analysis = analyzeFingerprintSamples(expected.sampleIndexes.map((index) => sampleAt(index)));
    expect(analysis).not.toBeNull();
    if (!analysis) throw new Error("Reference samples must be usable");
    expect(analysis.prediction).toBe(expected.prediction);
    expect(analysis.usedOutputs).toBe(expected.usedOutputs);
    expect(analysis.calibration.queries).toBe(expected.calibration.queries);
    expect(analysis.calibration.beta).toBeCloseTo(expected.calibration.beta, 9);
    expect(analysis.calibration.cvAccuracy).toBeCloseTo(expected.calibration.cv_accuracy, 9);
    expect(analysis.familyPrediction).toBe(expected.familyPrediction);
    expect(analysis.results).toHaveLength(expected.results.length);
    expected.results.forEach((row, index) => {
      const actual = analysis.results[index];
      expect(actual.model).toBe(row.model);
      expect(actual.probability).toBeCloseTo(row.probability, 9);
      expect(actual.score).toBeCloseTo(row.score, 9);
      expect(actual.profileSimilarity).toBeCloseTo(row.profileSimilarity, 9);
      expect(actual.conditionalProbability).toBeCloseTo(row.conditionalProbability, 9);
    });
    expected.familyProbabilities.forEach((family) => {
      expect(analysis.familyProbabilities.find((item) => item.family === family.family)?.probability)
        .toBeCloseTo(family.probability, 9);
    });
  });

  it("excludes rejected and failed samples even when their text contains enough numbers", () => {
    const good = sampleAt(0);
    const analysis = analyzeFingerprintSamples([
      good,
      sampleAt(1, { accepted: false }),
      sampleAt(2, { error: "attempted a tool" }),
    ]);
    expect(analysis?.usedOutputs).toBe(1);
    expect(analysis?.calibration.queries).toBe("1");
    expect(analysis?.results).toEqual(analyzeFingerprintSamples([good])?.results);
    expect(analysis?.diagnostics.map((item) => item.accepted)).toEqual([true, false, false]);
  });

  it("uses the number of usable samples to select the calibration", () => {
    const analysis = analyzeFingerprintSamples([sampleAt(0), sampleAt(1), sampleAt(2, { accepted: false })]);
    expect(analysis?.usedOutputs).toBe(2);
    expect(analysis?.calibration.queries).toBe("2");
  });

  it.each([[300, 165], [0, 80]])("requires the calibrated minimum for a %i-number request", (requestedCount, minimum) => {
    const response = Array(minimum).fill("42").join(" ");
    expect(analyzeFingerprintSamples([sampleAt(0, { requestedCount, response })])?.diagnostics[0])
      .toMatchObject({ parsedNumbers: minimum, minimumNumbers: minimum, accepted: true });
    expect(analyzeFingerprintSamples([sampleAt(0, { requestedCount, response: response.slice(3) })])).toBeNull();
  });

  it("has no analysis when every answer is unusable", () => {
    expect(analyzeFingerprintSamples([])).toBeNull();
    expect(analyzeFingerprintSamples([sampleAt(0, { response: "I cannot answer" })])).toBeNull();
    expect(analyzeFingerprintSamples([sampleAt(0, { accepted: false })])).toBeNull();
    expect(analyzeFingerprintSamples([sampleAt(0, { error: "failed turn" })])).toBeNull();
  });
});

describe("codex fingerprint verdicts", () => {
  it("treats missing analysis and empty candidates as invalid", () => {
    expect(assessFingerprint("gpt-6-astra", null).verdict).toBe("INVALID");
    expect(assessFingerprint("gpt-6-astra", analysisFor([])).verdict).toBe("INVALID");
  });

  it.each([null, "", "  "])("cannot assess a missing selected model (%s)", (selected) => {
    expect(assessFingerprint(selected, mismatchAnalysis()).verdict).toBe("UNKNOWN");
  });

  it("does not infer substitution for a model outside the bank", () => {
    expect(assessFingerprint("gpt-7-nova", mismatchAnalysis())).toMatchObject({
      verdict: "UNLISTED", direction: null, selectedModelProbability: null,
    });
  });

  it("normalizes provider prefixes and retains low confidence on a weak match", () => {
    const analysis = analysisFor([candidate("gpt-6-astra", 0.55, 1), candidate("gpt-5.5", 0.45, 0.9)]);
    expect(assessFingerprint(" OpenAI/gpt-6-astra ", analysis)).toMatchObject({ verdict: "MATCH", confidence: "low" });
    expect(assessFingerprint("relay/openai/gpt-6-astra", analysis).verdict).toBe("MATCH");
  });

  it("requires at least two usable answers for a mismatch", () => {
    const analysis = analysisFor([candidate("gpt-5.5", 0.99, 2), candidate("gpt-6-astra", 0.01, 0)], 1);
    expect(assessFingerprint("gpt-6-astra", analysis).verdict).toBe("SUSPICIOUS");
    expect(assessFingerprint("gpt-6-astra", { ...analysis, usedOutputs: 2 }).verdict).toBe("MISMATCH");
  });

  it("includes the probability and margin thresholds despite floating point noise", () => {
    expect(assessFingerprint("gpt-6-astra", mismatchAnalysis()).verdict).toBe("MISMATCH");
    const analysis = analysisFor([
      candidate("gpt-5.5", 0.8 - Number.EPSILON, 1),
      candidate("gpt-6-astra", 0.2 + Number.EPSILON, 0.5 + Number.EPSILON),
    ]);
    expect(assessFingerprint("gpt-6-astra", analysis).verdict).toBe("MISMATCH");
  });

  it.each([
    [0.79, 0.1, 1],
    [0.8, 0.21, 1],
    [0.95, 0.04, 0.25],
    [0.8 - 1e-8, 0.2, 0.5],
  ])("keeps insufficient confidence suspicious (top=%f, selected=%f, margin=%f)", (top, selected, margin) => {
    const analysis = analysisFor([candidate("gpt-5.5", top, margin), candidate("gpt-6-astra", selected, 0)]);
    expect(assessFingerprint("gpt-6-astra", analysis).verdict).toBe("SUSPICIOUS");
  });

  it("does not compare generation numbers across different model families", () => {
    const analysis = analysisFor([
      candidate("claude-opus-4-8", 0.99, 2, "claude"),
      candidate("gpt-6-astra", 0.01, 0, "gpt"),
    ]);
    expect(assessFingerprint("gpt-6-astra", analysis)).toMatchObject({ verdict: "MISMATCH", direction: "lateral" });
    expect(assessFingerprint("gpt-6-astra", mismatchAnalysis()).direction).toBe("downgrade");
  });
});
