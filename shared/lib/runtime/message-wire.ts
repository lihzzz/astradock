/** Immutable structural witnesses keep in-place/nested edits visible without
 * re-encoding every unchanged message's (potentially huge) string contents. */
type Shape = { kind: "primitive"; value: null | undefined | string | number | boolean }
  | { kind: "array"; values: Shape[] }
  | { kind: "object"; entries: Array<readonly [string, Shape]> };
export interface WireMessageSnapshot { id: string; json: string; shape: Shape | null }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function plain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && !("toJSON" in value);
}
function capture(value: unknown, ancestors = new Set<object>()): Shape | null {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return { kind: "primitive", value };
  }
  if (typeof value !== "object" || ancestors.has(value)) return null;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if ("toJSON" in value) return null;
      const values: Shape[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (descriptor?.get || descriptor?.set) return null;
        const child = capture(value[i], ancestors);
        if (!child) return null;
        values.push(child);
      }
      return { kind: "array", values };
    }
    if (!record(value) || !plain(value)) return null;
    const entries: Array<readonly [string, Shape]> = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get || descriptor?.set) return null;
      const child = capture(value[key], ancestors);
      if (!child) return null;
      entries.push([key, child]);
    }
    return { kind: "object", entries };
  } finally { ancestors.delete(value); }
}
function matches(value: unknown, shape: Shape, ancestors = new Set<object>()): boolean {
  if (shape.kind === "primitive") return Object.is(value, shape.value);
  if (typeof value !== "object" || value === null || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (shape.kind === "array") {
      if (!Array.isArray(value) || "toJSON" in value || value.length !== shape.values.length) return false;
      return shape.values.every((child, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        return !descriptor?.get && !descriptor?.set && matches(value[i], child, ancestors);
      });
    }
    if (!record(value) || !plain(value)) return false;
    const keys = Object.keys(value);
    return keys.length === shape.entries.length && shape.entries.every(([key, child], i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return keys[i] === key && !descriptor?.get && !descriptor?.set && matches(value[key], child, ancestors);
    });
  } finally { ancestors.delete(value); }
}
export function prepareWireMessages<T extends { id: string }>(
  messages: ReadonlyArray<T>, previous: ReadonlyArray<WireMessageSnapshot> = [],
  encode: (message: T) => string = JSON.stringify,
): WireMessageSnapshot[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  return messages.map((message) => {
    const old = byId.get(message.id);
    if (old?.shape && matches(message, old.shape)) return old;
    // Unsupported objects/getters/toJSON always use the original JSON path.
    // The snapshot is captured BEFORE encode, avoiding a mutating toJSON cache.
    const shape = capture(message);
    return { id: message.id, json: encode(message), shape };
  });
}
