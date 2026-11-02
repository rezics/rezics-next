import { GROWTH_CALIBRATION_LIMITS } from './growth-calibration.ts';
import { GROWTH_REPETITION_CAPACITY } from './growth-numeric.ts';

export type GrowthProfileInputSource = Readonly<{ name: string; text: string }>;

export const GROWTH_PROFILE_INPUT_LIMITS = {
  totalBytes: 64 * 1024 * 1024,
  lineBytes: 2 * 1024 * 1024,
  lines: 250_000,
  records: 50_000,
} as const;

/** Rows, blocks and statements retained on mapped samples and copied into per-metric tensors. */
const GROWTH_PROFILE_METRIC_COUNT = 3;

/** Numerical repetition ceiling and calibration point×metric aggregate, applied before mapping. */
export const GROWTH_PROFILE_EXPANSION = {
  repetitions: GROWTH_REPETITION_CAPACITY,
  values: GROWTH_CALIBRATION_LIMITS.points * GROWTH_CALIBRATION_LIMITS.repetitions * GROWTH_PROFILE_METRIC_COUNT,
} as const;

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function isTrimWhitespace(codePoint: number): boolean {
  return (
    codePoint === 0x0009 ||
    codePoint === 0x000a ||
    codePoint === 0x000b ||
    codePoint === 0x000c ||
    codePoint === 0x000d ||
    codePoint === 0x0020 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

function inputError(source: GrowthProfileInputSource, line: number, detail: string): TypeError {
  return new TypeError(`${source.name || '<unnamed profile>'}:${line} ${detail}`);
}

/** Reject excessive profile text before JSON parsing or calibration grouping. */
export function admitGrowthProfileInput(sources: readonly GrowthProfileInputSource[]): void {
  let totalBytes = 0;
  let totalLines = 0;
  let totalRecords = 0;

  for (const source of sources) {
    let line = 1;
    let lineBytes = 0;
    let hasRecord = false;
    totalLines++;
    if (totalLines > GROWTH_PROFILE_INPUT_LIMITS.lines)
      throw inputError(source, line, `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.lines} physical profile line limit`);

    for (let offset = 0; offset < source.text.length;) {
      const codePoint = source.text.codePointAt(offset)!;
      const width = utf8Width(codePoint);
      totalBytes += width;
      if (totalBytes > GROWTH_PROFILE_INPUT_LIMITS.totalBytes)
        throw inputError(
          source,
          line,
          `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.totalBytes} byte profile input limit`,
        );

      if (codePoint === 0x000a) {
        if (hasRecord && ++totalRecords > GROWTH_PROFILE_INPUT_LIMITS.records)
          throw inputError(source, line, `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.records} profile record limit`);
        line++;
        totalLines++;
        if (totalLines > GROWTH_PROFILE_INPUT_LIMITS.lines)
          throw inputError(
            source,
            line,
            `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.lines} physical profile line limit`,
          );
        lineBytes = 0;
        hasRecord = false;
      } else {
        lineBytes += width;
        if (lineBytes > GROWTH_PROFILE_INPUT_LIMITS.lineBytes)
          throw inputError(
            source,
            line,
            `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.lineBytes} byte profile line limit`,
          );
        if (!isTrimWhitespace(codePoint)) hasRecord = true;
      }

      offset += codePoint > 0xffff ? 2 : 1;
    }

    if (hasRecord && ++totalRecords > GROWTH_PROFILE_INPUT_LIMITS.records)
      throw inputError(source, line, `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.records} profile record limit`);
  }
}

/** Iterate JSONL lines without allocating an array proportional to the input. */
export function* growthProfileLines(source: GrowthProfileInputSource): Iterable<{ line: number; text: string }> {
  let start = 0;
  let line = 1;
  for (let offset = 0; offset < source.text.length; offset++) {
    if (source.text.charCodeAt(offset) !== 0x000a) continue;
    const end = offset > start && source.text.charCodeAt(offset - 1) === 0x000d ? offset - 1 : offset;
    yield { line: line++, text: source.text.slice(start, end) };
    start = offset + 1;
  }
  yield { line, text: source.text.slice(start) };
}
