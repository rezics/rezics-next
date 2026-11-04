import { Buffer } from 'node:buffer';

export const MAX_GROWTH_CAPTURE_ENTRIES = 20_000;
export const MAX_GROWTH_CAPTURE_BYTES = 32 * 1024 * 1024;
export const MAX_GROWTH_NATIVE_NOTICE_BYTES = 1024 * 1024;
export const GROWTH_NATIVE_NOTICE_RETAINED_BYTE_MULTIPLIER = 8;

export type GrowthCaptureEvidenceSide = 'foreground' | 'background';

export type GrowthCaptureBudgetLimits = {
  readonly entries: number;
  readonly bytes: number;
  readonly nativeNoticeBytes: number;
};

export type GrowthNativeNoticeReservation = Readonly<{
  readonly chargedBytes: number;
  release(): void;
}>;

const defaultLimits: GrowthCaptureBudgetLimits = {
  entries: MAX_GROWTH_CAPTURE_ENTRIES,
  bytes: MAX_GROWTH_CAPTURE_BYTES,
  nativeNoticeBytes: MAX_GROWTH_NATIVE_NOTICE_BYTES,
};

function limitValue(name: string, value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum)
    throw new RangeError(`Growth capture ${name} limit must be an integer from 0 to ${maximum}`);
  return result;
}

export class GrowthCaptureBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrowthCaptureBudgetExceededError';
  }
}

/** One shared capacity for foreground and background evidence retained by a capture. */
export class GrowthCaptureBudget {
  readonly #label: string;
  readonly limits: GrowthCaptureBudgetLimits;
  #entries = 0;
  #bytes = 0;

  constructor(captureId: number, limits: Partial<GrowthCaptureBudgetLimits> = {}) {
    this.#label = `Growth capture #${captureId}`;
    this.limits = {
      entries: limitValue('entry', limits.entries, defaultLimits.entries),
      bytes: limitValue('byte', limits.bytes, defaultLimits.bytes),
      nativeNoticeBytes: limitValue('native notice byte', limits.nativeNoticeBytes, defaultLimits.nativeNoticeBytes),
    };
  }

  retainStatementText(side: GrowthCaptureEvidenceSide, bytes: number): void {
    this.reserve(`${side} statement text`, 1, bytes);
  }

  retainStatementError(side: GrowthCaptureEvidenceSide, bytes: number): void {
    this.reserve(`${side} statement error`, 1, bytes);
  }

  retainNativeNotice(bytes: number, side: GrowthCaptureEvidenceSide): GrowthNativeNoticeReservation {
    if (bytes > this.limits.nativeNoticeBytes)
      throw new GrowthCaptureBudgetExceededError(
        `${this.#label} exceeded native notice byte capacity (${this.limits.nativeNoticeBytes} bytes); current 0, requested ${bytes}, total ${bytes} UTF-8 bytes for ${side} notice; capture has ${this.#bytes} charged bytes and ${this.#entries} evidence entries.`,
      );
    const chargedBytes = bytes * GROWTH_NATIVE_NOTICE_RETAINED_BYTE_MULTIPLIER;
    this.reserve(`${side} native plan notice`, 1, chargedBytes);
    let retained = true;
    return {
      chargedBytes,
      release: () => {
        if (!retained) return;
        retained = false;
        if (chargedBytes > this.#bytes) throw new Error('Growth capture notice reservation was already released');
        this.#bytes -= chargedBytes;
      },
    };
  }

  retainFoldedSummary(side: GrowthCaptureEvidenceSide, evidence: string, entries: number, bytes: number): void {
    if (!Number.isSafeInteger(entries) || entries < 0) throw new RangeError('Folded evidence entries must be non-negative');
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Folded evidence bytes must be non-negative');
    this.reserve(`${side} folded ${evidence}`, entries, bytes);
  }

  get entriesUsed(): number {
    return this.#entries;
  }

  get chargedBytes(): number {
    return this.#bytes;
  }

  retainNativePlanNode(side: GrowthCaptureEvidenceSide): void {
    this.reserve(`${side} native plan node`, 1, 0);
  }

  private reserve(evidence: string, entries: number, bytes: number): void {
    const nextEntries = this.#entries + entries;
    if (nextEntries > this.limits.entries)
      throw new GrowthCaptureBudgetExceededError(
        `${this.#label} exceeded telemetry entry capacity (${this.limits.entries} entries); current ${this.#entries}, requested ${entries}, total ${nextEntries} entries for ${evidence}; charged bytes current ${this.#bytes}, requested ${bytes}, total ${this.#bytes + bytes}.`,
      );
    const nextBytes = this.#bytes + bytes;
    if (nextBytes > this.limits.bytes)
      throw new GrowthCaptureBudgetExceededError(
        `${this.#label} exceeded telemetry byte capacity (${this.limits.bytes} charged bytes); current ${this.#bytes}, requested ${bytes}, total ${nextBytes} charged bytes for ${evidence}; evidence entries current ${this.#entries}, requested ${entries}, total ${nextEntries}.`,
      );
    this.#entries = nextEntries;
    this.#bytes = nextBytes;
  }
}

/** Reserves bounded notice storage before invoking the parser. */
export function parseNativePlanNotice<T>(
  budget: GrowthCaptureBudget,
  message: string,
  side: GrowthCaptureEvidenceSide,
  parse: () => T,
): T {
  budget.retainNativeNotice(Buffer.byteLength(message, 'utf8'), side);
  return parse();
}
