import { Buffer } from 'node:buffer';

export const MAX_GROWTH_CAPTURE_ENTRIES = 20_000;
export const MAX_GROWTH_CAPTURE_BYTES = 32 * 1024 * 1024;
export const MAX_GROWTH_NATIVE_NOTICE_BYTES = 1024 * 1024;
export const GROWTH_NATIVE_NOTICE_RETAINED_BYTE_MULTIPLIER = 8;
const GROWTH_FAILURE_CONTEXT_RESERVE_BYTES = 72 * 1024;
const GROWTH_FAILURE_CONTEXT_RESERVE_ENTRIES = 16;

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
  #failureEntries = 0;
  #failureBytes = 0;
  #failureReserveEntries: number;
  #failureReserveBytes: number;
  #failureReserveActive = true;

  constructor(captureId: number, limits: Partial<GrowthCaptureBudgetLimits> = {}) {
    this.#label = `Growth capture #${captureId}`;
    this.limits = {
      entries: limitValue('entry', limits.entries, defaultLimits.entries),
      bytes: limitValue('byte', limits.bytes, defaultLimits.bytes),
      nativeNoticeBytes: limitValue('native notice byte', limits.nativeNoticeBytes, defaultLimits.nativeNoticeBytes),
    };
    this.#failureReserveEntries =
      this.limits.entries === 0
        ? 0
        : Math.min(GROWTH_FAILURE_CONTEXT_RESERVE_ENTRIES, Math.max(1, Math.floor(this.limits.entries * 0.001)));
    this.#failureReserveBytes =
      this.limits.bytes === 0
        ? 0
        : Math.min(
            this.limits.bytes,
            GROWTH_FAILURE_CONTEXT_RESERVE_BYTES,
            Math.max(128, Math.floor(this.limits.bytes * 0.001)),
          );
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
    const chargedEntries = 1;
    this.reserve(`${side} native plan notice`, chargedEntries, chargedBytes);
    let retained = true;
    return {
      chargedBytes,
      release: () => {
        if (!retained) return;
        retained = false;
        if (chargedBytes > this.#bytes || chargedEntries > this.#entries)
          throw new Error('Growth capture notice reservation was already released');
        this.#bytes -= chargedBytes;
        this.#entries -= chargedEntries;
      },
    };
  }

  retainFoldedSummary(side: GrowthCaptureEvidenceSide, evidence: string, entries: number, bytes: number): void {
    if (!Number.isSafeInteger(entries) || entries < 0)
      throw new RangeError('Folded evidence entries must be non-negative');
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Folded evidence bytes must be non-negative');
    this.reserve(`${side} folded ${evidence}`, entries, bytes);
  }

  get entriesUsed(): number {
    return this.#entries + this.#failureEntries;
  }

  get chargedBytes(): number {
    return this.#bytes + this.#failureBytes;
  }

  retainNativePlanNode(side: GrowthCaptureEvidenceSide): void {
    this.reserve(`${side} native plan node`, 1, 0);
  }

  /** Charges the small failure envelope from capacity held aside during ordinary capture. */
  retainFailureContext(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Failure context bytes must be non-negative');
    const nextEntries = this.#entries + this.#failureEntries + 1;
    const nextBytes = this.#bytes + this.#failureBytes + bytes;
    if (nextEntries > this.limits.entries || nextBytes > this.limits.bytes)
      throw new GrowthCaptureBudgetExceededError(
        `Growth capture failure context exceeded its reserved capacity; requested ${bytes} bytes and one entry, total ${nextEntries} entries and ${nextBytes} charged bytes of ${this.limits.entries} entries and ${this.limits.bytes} bytes.`,
      );
    this.#failureEntries += 1;
    this.#failureBytes += bytes;
  }

  /** Successful captures return unused failure headroom to ordinary result accounting. */
  releaseFailureContextReserve(): void {
    this.#failureReserveActive = false;
  }

  private reserve(evidence: string, entries: number, bytes: number): void {
    const nextEntries = this.#entries + entries;
    const entryLimit = this.limits.entries - (this.#failureReserveActive ? this.#failureReserveEntries : 0);
    if (nextEntries > entryLimit)
      throw new GrowthCaptureBudgetExceededError(
        `${this.#label} exceeded telemetry entry capacity (${this.limits.entries} entries); current ${this.#entries}, requested ${entries}, total ${nextEntries} entries for ${evidence}; ${this.#failureReserveActive ? `${this.#failureReserveEntries} entries reserved for failure context; ` : ''}charged bytes current ${this.#bytes}, requested ${bytes}, total ${this.#bytes + bytes}.`,
      );
    const nextBytes = this.#bytes + bytes;
    const byteLimit = this.limits.bytes - (this.#failureReserveActive ? this.#failureReserveBytes : 0);
    if (nextBytes > byteLimit)
      throw new GrowthCaptureBudgetExceededError(
        `${this.#label} exceeded telemetry byte capacity (${this.limits.bytes} charged bytes); current ${this.#bytes}, requested ${bytes}, total ${nextBytes} charged bytes for ${evidence}; ${this.#failureReserveActive ? `${this.#failureReserveBytes} bytes reserved for failure context; ` : ''}evidence entries current ${this.#entries}, requested ${entries}, total ${nextEntries}.`,
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
