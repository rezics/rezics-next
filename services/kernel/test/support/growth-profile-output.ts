import { appendFileSync } from 'node:fs';

/** Matches the profile reader's per-line UTF-8 cap so a written record remains admissible. */
export const GROWTH_PROFILE_OUTPUT_LIMITS = {
  lineBytes: 2 * 1024 * 1024,
} as const;

export type GrowthProfileExportMode = 'best-effort' | 'required';

export type GrowthProfileExport = Readonly<{
  destination: string;
  record: unknown;
  mode?: GrowthProfileExportMode;
}>;

export type GrowthProfileExportDelivery = Readonly<{
  destination: string;
  bytes: number;
}>;

const warnedDestinations = new Set<string>();

export class GrowthProfileExportError extends Error {
  readonly destination: string;

  constructor(destination: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`GROWTH_PROFILE ${destination} was not written: ${detail}`);
    this.name = 'GrowthProfileExportError';
    this.destination = destination;
    if (cause instanceof Error) this.cause = cause;
  }
}

/** Unset is best-effort; the only explicit required opt-in is `1`. */
export function growthProfileExportMode(value: string | undefined): GrowthProfileExportMode {
  if (value === undefined) return 'best-effort';
  if (value === '1') return 'required';
  throw new TypeError("GROWTH_PROFILE_REQUIRED must be '1' when set");
}

function serializeProfileLine(record: unknown): Buffer {
  let text: string;
  try {
    text = JSON.stringify(record);
  } catch (error) {
    throw error instanceof Error ? error : new TypeError(String(error));
  }
  if (typeof text !== 'string' || text.length === 0)
    throw new TypeError('profile record must serialize to a complete JSON value');
  const line = `${text}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes)
    throw new TypeError(`exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes} byte profile line limit`);
  return Buffer.from(line, 'utf8');
}

function warnExportFailure(destination: string, error: unknown): void {
  if (warnedDestinations.has(destination)) return;
  warnedDestinations.add(destination);
  console.warn(
    `GROWTH_PROFILE ${destination} was not written: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Appends one complete JSONL record. Best-effort warns once per destination and returns undefined;
 * required mode throws GrowthProfileExportError naming the destination and original failure.
 */
export function appendGrowthProfile(request: GrowthProfileExport): GrowthProfileExportDelivery | undefined {
  const mode = request.mode ?? 'best-effort';
  try {
    const line = serializeProfileLine(request.record);
    appendFileSync(request.destination, line);
    return { destination: request.destination, bytes: line.byteLength };
  } catch (error) {
    if (mode === 'required') throw new GrowthProfileExportError(request.destination, error);
    warnExportFailure(request.destination, error);
    return undefined;
  }
}
