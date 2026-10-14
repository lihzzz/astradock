import bankData from "./fingerprint/modeltrace-bank.json";
import type {
  CodexFingerprintAnalysis,
  CodexFingerprintCandidate,
  CodexFingerprintDiagnostic,
  CodexFingerprintSample,
  CodexFingerprintVerdict,
} from "../types/codex-fingerprint";

const VALUE_MIN = 1;
const VALUE_MAX = 355;
const DIMENSION = VALUE_MAX - VALUE_MIN + 1;
const ALPHA = 0.5;
const MISMATCH_CONFIDENCE = 0.8;
const MISMATCH_MARGIN = 0.5;
const COMPARISON_EPSILON = 1e-9;

interface BankModel {
  id: string;
  display_name?: string;
  family?: string;
  family_name?: string;
  counts: number[];
}

interface BankArtifact {
  feature_mean: number[];
  feature_scale: number[];
  nuisance_basis?: number[][];
  centroids: number[][];
  environment_centroids?: number[][][];
  weight?: number;
}

interface ModelTraceBank {
  models: BankModel[];
  robust: {
    hellinger: BankArtifact;
    ordered_blocks?: BankArtifact;
  };
  calibration: Record<"1" | "2" | "3", { beta: number; cv_accuracy: number }>;
  method?: { name?: string };
}

const bank = bankData as unknown as ModelTraceBank;

export function parseFingerprintNumbers(text: string): number[] {
  const runs: number[][] = [];
  let current: number[] = [];
  let previousEnd = 0;
  const matches = text.matchAll(/\d+/g);

  for (const match of matches) {
    const separator = text.slice(previousEnd, match.index ?? 0);
    const value = Number.parseInt(match[0], 10);
    if (current.length > 0 && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = (match.index ?? 0) + match[0].length;
  }
  if (current.length > 0) runs.push(current);

  return runs.sort((left, right) => right.length - left.length)[0] ?? [];
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardize(values: number[]): number[] {
  const center = mean(values);
  const variance = mean(values.map((value) => (value - center) ** 2));
  const scale = Math.max(Math.sqrt(variance), 1e-12);
  return values.map((value) => (value - center) / scale);
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function normalized(values: number[]): number[] {
  const scale = Math.max(Math.sqrt(dot(values, values)), 1e-12);
  return values.map((value) => value / scale);
}

function subtractBasis(values: number[], basis?: number[][]): number[] {
  let output = [...values];
  for (const vector of basis ?? []) {
    const projection = dot(output, vector);
    output = output.map((value, index) => value - projection * vector[index]);
  }
  return output;
}

function countNumbers(numbers: number[]): number[] {
  const counts = new Array<number>(DIMENSION).fill(0);
  for (const number of numbers) counts[number - VALUE_MIN] += 1;
  return counts;
}

function hellingerFeature(counts: number[]): number[] {
  const total = counts.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  return counts.map((value) => Math.sqrt((value + ALPHA) / total));
}

function orderedBlockFeature(numbers: number[]): number[] {
  const base = Math.floor(numbers.length / 4);
  const remainder = numbers.length % 4;
  const pieces: number[] = [];

  for (let block = 0; block < 4; block += 1) {
    const size = base + (block < remainder ? 1 : 0);
    const start = block * base + Math.min(block, remainder);
    const bins = new Array<number>(16).fill(0.5);
    for (const value of numbers.slice(start, start + size)) {
      bins[Math.min(15, Math.floor(((value - 1) / VALUE_MAX) * 16))] += 1;
    }
    const total = bins.reduce((sum, value) => sum + value, 0);
    pieces.push(...bins.map((value) => Math.sqrt(value / total)));
  }

  const lastDigits = new Array<number>(10).fill(0.5);
  for (const value of numbers) lastDigits[value % 10] += 1;
  const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
  pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
  return pieces;
}

function robustScoreCounts(counts: number[]): number[] {
  const artifact = bank.robust.hellinger;
  const feature = hellingerFeature(counts)
    .map((value, index) => (value - artifact.feature_mean[index]) / artifact.feature_scale[index]);
  const projected = normalized(subtractBasis(feature, artifact.nuisance_basis));
  return standardize(artifact.centroids.map((centroid) => dot(projected, centroid)));
}

function orderedBlockScores(numbers: number[]): number[] {
  const artifact = bank.robust.ordered_blocks;
  if (!artifact) return [];
  const feature = orderedBlockFeature(numbers)
    .map((value, index) => (value - artifact.feature_mean[index]) / artifact.feature_scale[index]);
  const unit = normalized(feature);
  const environmentScores = artifact.environment_centroids?.map((centroids) =>
    centroids.map((centroid) => dot(unit, centroid)),
  ) ?? [];
  const template = standardize(artifact.centroids.map((_, index) =>
    Math.max(...environmentScores.map((scores) => scores[index])),
  ));
  const projected = normalized(subtractBasis(feature, artifact.nuisance_basis));
  const nuisance = standardize(artifact.centroids.map((centroid) => dot(projected, centroid)));
  return standardize(artifact.centroids.map((_, index) => 0.5 * template[index] + 0.5 * nuisance[index]));
}

function robustScoreNumbers(numbers: number[]): number[] {
  const marginal = robustScoreCounts(countNumbers(numbers));
  const artifact = bank.robust.ordered_blocks;
  const weight = artifact?.weight ?? 0;
  if (!artifact || weight === 0) return marginal;
  const ordered = orderedBlockScores(numbers);
  return marginal.map((value, index) => (1 - weight) * value + weight * ordered[index]);
}

function softmax(values: number[]): number[] {
  const maximum = Math.max(...values);
  const weights = values.map((value) => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => value / total);
}

function jsSimilarity(left: number[], right: number[]): number {
  const leftTotal = left.reduce((sum, value) => sum + value, 0);
  const rightTotal = right.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  const p = left.map((value) => value / leftTotal);
  const q = right.map((value) => (value + ALPHA) / rightTotal);
  const midpoint = p.map((value, index) => (value + q[index]) / 2);
  const divergence = (values: number[]) =>
    values.reduce((sum, value, index) => (value ? sum + value * Math.log(value / midpoint[index]) : sum), 0);
  const js = (divergence(p) + divergence(q)) / 2;
  return 1 - Math.sqrt(js / Math.log(2));
}

function minimumNumbers(expectedCount: number): number {
  return expectedCount > 0 ? Math.max(80, Math.ceil(expectedCount * 0.55)) : 80;
}

export function analyzeFingerprintSamples(samples: CodexFingerprintSample[]): CodexFingerprintAnalysis | null {
  const diagnostics: CodexFingerprintDiagnostic[] = [];
  const valid: Array<{ numbers: number[]; counts: number[]; scores: number[] }> = [];

  samples.forEach((sample, index) => {
    const numbers = parseFingerprintNumbers(sample.response);
    const minimum = minimumNumbers(sample.requestedCount);
    // Transport/tool failures may still contain a long sequence of numbers.
    // Preserve the probe runner's rejection when validating its text.
    const accepted = sample.accepted && sample.error === undefined && numbers.length >= minimum;
    diagnostics.push({
      index,
      parsedNumbers: numbers.length,
      minimumNumbers: minimum,
      accepted,
    });
    if (accepted) {
      valid.push({
        numbers,
        counts: countNumbers(numbers),
        scores: robustScoreNumbers(numbers),
      });
    }
  });

  if (valid.length === 0) return null;

  const combined = bank.models.map((_, modelIndex) =>
    mean(valid.map((item) => item.scores[modelIndex])),
  );
  const calibrationKey = (String(Math.min(valid.length, 3)) as "1" | "2" | "3");
  const calibration = bank.calibration[calibrationKey];
  const probabilities = softmax(combined.map((score) => calibration.beta * score));
  const pooled = valid.reduce(
    (accumulator, item) => accumulator.map((value, index) => value + item.counts[index]),
    new Array<number>(DIMENSION).fill(0),
  );

  const results = bank.models.map((model, index): CodexFingerprintCandidate => ({
    model: model.id,
    displayName: model.display_name ?? model.id,
    family: model.family ?? "models",
    familyName: model.family_name ?? model.family ?? "models",
    probability: probabilities[index],
    conditionalProbability: probabilities[index],
    profileSimilarity: jsSimilarity(pooled, model.counts),
    score: combined[index],
  })).sort((left, right) => right.probability - left.probability);

  const families = [...new Set(bank.models.map((model) => model.family ?? "models"))];
  const familyProbabilities = families.map((family) => ({
    family,
    displayName: bank.models.find((model) => (model.family ?? "models") === family)?.family_name ?? family,
    probability: results
      .filter((result) => result.family === family)
      .reduce((sum, result) => sum + result.probability, 0),
  }));
  for (const result of results) {
    result.conditionalProbability = result.probability /
      (familyProbabilities.find((item) => item.family === result.family)?.probability || 1);
  }

  const topFamily = familyProbabilities.sort((left, right) => right.probability - left.probability)[0];
  return {
    prediction: results[0].model,
    predictionName: results[0].displayName,
    probability: results[0].probability,
    usedOutputs: valid.length,
    results,
    diagnostics,
    calibration: {
      queries: calibrationKey,
      beta: calibration.beta,
      cvAccuracy: calibration.cv_accuracy,
    },
    familyPrediction: topFamily.family,
    familyPredictionName: topFamily.displayName,
    familyProbability: topFamily.probability,
    familyProbabilities,
    method: bank.method?.name ?? "Ordered-block + nuisance-Hellinger",
  };
}

function normalizeModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function modelVersion(model: string): [number, number] | null {
  const match = /(?:^|-)(\d+)(?:[.-](\d{1,2}))?(?=$|-)/.exec(model);
  return match ? [Number.parseInt(match[1], 10), Number.parseInt(match[2] ?? "0", 10)] : null;
}

function modelSize(model: string): number {
  const tags: Array<[string, number]> = [
    ["nano", 0], ["mini", 1], ["spark", 1], ["lite", 1], ["small", 1], ["flash", 1],
    ["reserve", 1], ["auto-review", 1],
  ];
  let size = 2;
  for (const [tag, value] of tags) {
    if (model.includes(tag)) size = Math.min(size, value);
  }
  return /(^|-)(pro|ultra)($|-)/.test(model) ? 3 : size;
}

function classifyChange(selected: string, predicted: string): CodexFingerprintVerdict["direction"] {
  const selectedVersion = modelVersion(selected);
  const predictedVersion = modelVersion(predicted);
  if (selectedVersion && predictedVersion && selectedVersion.some((value, index) => value !== predictedVersion[index])) {
    return predictedVersion[0] + predictedVersion[1] / 100 > selectedVersion[0] + selectedVersion[1] / 100
      ? "upgrade"
      : "downgrade";
  }
  const selectedSize = modelSize(selected);
  const predictedSize = modelSize(predicted);
  if (selectedSize !== predictedSize) return predictedSize > selectedSize ? "upgrade" : "downgrade";
  return "lateral";
}

export function assessFingerprint(selectedModel: string | null, analysis: CodexFingerprintAnalysis | null): CodexFingerprintVerdict {
  if (!analysis || analysis.results.length === 0) {
    return {
      verdict: "INVALID",
      direction: null,
      topModel: null,
      selectedModelProbability: null,
      margin: null,
      confidence: null,
      message: "未能得到可用的数字样本，无法判定模型归属。",
    };
  }

  const selected = normalizeModel(selectedModel ?? "");
  const top = analysis.results[0];
  const selectedResult = analysis.results.find((result) => result.model === selected) ?? null;
  const base = {
    topModel: top.model,
    selectedModelProbability: selectedResult?.probability ?? null,
    margin: selectedResult ? top.score - selectedResult.score : null,
  };

  if (!selected) {
    return {
      ...base,
      verdict: "UNKNOWN",
      direction: null,
      confidence: null,
      message: "未能确定所选模型，无法判断指纹是否匹配。",
    };
  }

  if (!selectedResult) {
    return {
      ...base,
      verdict: "UNLISTED",
      direction: null,
      confidence: null,
      message: "所选模型不在当前指纹库中；以下只表示最接近的已知模型，不构成替换结论。",
    };
  }

  if (top.model === selected) {
    return {
      ...base,
      verdict: "MATCH",
      direction: "lateral",
      confidence: top.probability >= MISMATCH_CONFIDENCE ? "high" : "low",
      message: "指纹与所选模型一致。",
    };
  }

  // Version numbers from different model families do not describe a shared
  // capability scale. A confident cross-family match is a reroute.
  const direction = selectedResult.family === top.family ? classifyChange(selected, top.model) : "lateral";
  const confident = analysis.usedOutputs >= 2 &&
    top.probability + COMPARISON_EPSILON >= MISMATCH_CONFIDENCE &&
    selectedResult.probability <= 1 - MISMATCH_CONFIDENCE + COMPARISON_EPSILON &&
    top.score - selectedResult.score + COMPARISON_EPSILON >= MISMATCH_MARGIN;

  return {
    ...base,
    verdict: confident ? "MISMATCH" : "SUSPICIOUS",
    direction,
    confidence: confident ? "high" : "low",
    message: confident
      ? `高置信不匹配：指纹更接近 ${top.displayName}。`
      : `疑似偏差：指纹更接近 ${top.displayName}，但置信条件不足。`,
  };
}
