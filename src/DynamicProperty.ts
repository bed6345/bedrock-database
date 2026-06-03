import { world } from "@minecraft/server";

/**
 * The maximum number of bytes a single dynamic property string can hold.
 *
 * Exceeding it throws, for example:
 * ```
 * ArgumentOutOfBoundsError: Unsupported or out of bounds value passed to
 * function argument [0]: String length for dynamic property 'allPlayers',
 * Value: 32838, Argument max: 32767
 * ```
 */
export const MAX_DYNAMIC_PROPERTY_BYTES = 32767;

/**
 * Byte budget used per chunk. Kept comfortably under
 * {@link MAX_DYNAMIC_PROPERTY_BYTES} to leave headroom and to stay safe
 * whether the engine measures the limit in UTF-8 bytes or UTF-16 code units
 * (a chunk of N UTF-8 bytes can never exceed N code units).
 */
const CHUNK_BUDGET_BYTES = 32000;

/** Number of UTF-8 bytes used to encode a single Unicode code point. */
function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Splits a string into chunks that each stay within {@link CHUNK_BUDGET_BYTES}
 * UTF-8 bytes, so every chunk can be safely stored in a single dynamic
 * property without hitting the engine's byte limit.
 *
 * Iteration is per code point, so multi-byte characters (e.g. emoji) are
 * never split across a chunk boundary.
 */
export function chunkString(value: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const bytes = utf8ByteLength(char.codePointAt(0)!);
    if (currentBytes + bytes > CHUNK_BUDGET_BYTES) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Stores a value of any size under `identifier`, transparently splitting it
 * across multiple dynamic properties so the per-property byte limit is never
 * exceeded.
 *
 * Use this in place of `world.setDynamicProperty(id, bigString)` whenever the
 * value can grow beyond {@link MAX_DYNAMIC_PROPERTY_BYTES}.
 */
export function setLargeProperty(identifier: string, value: unknown): void {
  const chunks = chunkString(JSON.stringify(value));
  const previousLength = world.getDynamicProperty(identifier);

  world.setDynamicProperty(identifier, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    world.setDynamicProperty(`${identifier}_${i}`, chunks[i]);
  }

  // Remove chunks left over from a previously larger value.
  if (typeof previousLength === "number") {
    for (let i = chunks.length; i < previousLength; i++) {
      world.setDynamicProperty(`${identifier}_${i}`, undefined);
    }
  }
}

/**
 * Reads a value previously stored with {@link setLargeProperty}.
 * @returns the stored value, or `undefined` if nothing is stored or the data
 *          is corrupt.
 */
export function getLargeProperty<T = any>(identifier: string): T | undefined {
  const length = world.getDynamicProperty(identifier);
  if (typeof length !== "number" || length <= 0) return undefined;

  let collected = "";
  for (let i = 0; i < length; i++) {
    const chunk = world.getDynamicProperty(`${identifier}_${i}`);
    if (typeof chunk !== "string") return undefined;
    collected += chunk;
  }

  try {
    return JSON.parse(collected) as T;
  } catch {
    return undefined;
  }
}

/**
 * Deletes a value previously stored with {@link setLargeProperty}, including
 * all of its chunks.
 */
export function deleteLargeProperty(identifier: string): void {
  const length = world.getDynamicProperty(identifier);
  world.setDynamicProperty(identifier, undefined);
  if (typeof length !== "number") return;
  for (let i = 0; i < length; i++) {
    world.setDynamicProperty(`${identifier}_${i}`, undefined);
  }
}
