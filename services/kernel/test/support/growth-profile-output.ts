import { appendFileSync } from 'node:fs';

/** Matches the profile reader's per-line UTF-8 cap so a written record remains admissible. */
export const GROWTH_PROFILE_OUTPUT_LIMITS = {
  lineBytes: 2 * 1024 * 1024,
  depth: 64,
  values: 1_048_576,
} as const;

const OMITTED = Symbol('omitted');
const HEX = '0123456789abcdef';

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

function lineLimitError(kind: 'byte' | 'depth' | 'value'): TypeError {
  if (kind === 'byte')
    return new TypeError(`exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes} byte profile line limit`);
  if (kind === 'depth')
    return new TypeError(`exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.depth} profile serialization depth limit`);
  return new TypeError(`exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.values} profile serialization value limit`);
}

function prepareJsonValue(value: unknown, key: string): unknown {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = (toJSON as (this: unknown, property: string) => unknown).call(value, key);
  }
  if (value instanceof Number) value = Number(value);
  else if (value instanceof String) value = String(value);
  else if (value instanceof Boolean) value = value.valueOf();
  const kind = typeof value;
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return OMITTED;
  if (kind === 'bigint') throw new TypeError('JSON.stringify cannot serialize BigInt.');
  return value;
}

function encodeProfileLine(record: unknown): Buffer {
  const maxJsonBytes = GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes - 1;
  let buffer = Buffer.alloc(Math.min(4096, maxJsonBytes));
  let offset = 0;
  let depth = 0;
  let visits = 0;
  const ancestors = new Set<object>();

  const fail = (kind: 'byte' | 'depth' | 'value'): never => {
    throw lineLimitError(kind);
  };

  const visit = (): void => {
    if (++visits > GROWTH_PROFILE_OUTPUT_LIMITS.values) fail('value');
  };

  const ensure = (count: number): void => {
    if (count > maxJsonBytes - offset) fail('byte');
    if (offset + count <= buffer.length) return;
    const next = Math.min(maxJsonBytes, Math.max(buffer.length * 2, offset + count));
    const grown = Buffer.alloc(next);
    buffer.copy(grown, 0, 0, offset);
    buffer = grown;
  };

  const writeByte = (byte: number): void => {
    ensure(1);
    buffer[offset++] = byte;
  };

  const writeAscii = (text: string): void => {
    ensure(text.length);
    for (let index = 0; index < text.length; index++) buffer[offset++] = text.charCodeAt(index);
  };

  const writeHexEscape = (code: number): void => {
    writeAscii('\\u');
    writeByte(HEX.charCodeAt((code >> 12) & 0xf));
    writeByte(HEX.charCodeAt((code >> 8) & 0xf));
    writeByte(HEX.charCodeAt((code >> 4) & 0xf));
    writeByte(HEX.charCodeAt(code & 0xf));
  };

  const writeUtf8 = (code: number): void => {
    if (code <= 0x7f) writeByte(code);
    else if (code <= 0x7ff) {
      ensure(2);
      buffer[offset++] = 0xc0 | (code >> 6);
      buffer[offset++] = 0x80 | (code & 0x3f);
    } else {
      ensure(3);
      buffer[offset++] = 0xe0 | (code >> 12);
      buffer[offset++] = 0x80 | ((code >> 6) & 0x3f);
      buffer[offset++] = 0x80 | (code & 0x3f);
    }
  };

  const writeString = (text: string): void => {
    writeByte(0x22);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) {
        writeByte(0x5c);
        writeByte(code);
      } else if (code === 0x08) writeAscii('\\b');
      else if (code === 0x09) writeAscii('\\t');
      else if (code === 0x0a) writeAscii('\\n');
      else if (code === 0x0c) writeAscii('\\f');
      else if (code === 0x0d) writeAscii('\\r');
      else if (code < 0x20) writeHexEscape(code);
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          const point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          ensure(4);
          buffer[offset++] = 0xf0 | (point >> 18);
          buffer[offset++] = 0x80 | ((point >> 12) & 0x3f);
          buffer[offset++] = 0x80 | ((point >> 6) & 0x3f);
          buffer[offset++] = 0x80 | (point & 0x3f);
          index++;
        } else writeHexEscape(code);
      } else if (code >= 0xd800 && code <= 0xdfff) writeHexEscape(code);
      else writeUtf8(code);
    }
    writeByte(0x22);
  };

  const writePrepared = (value: unknown): void => {
    switch (typeof value) {
      case 'boolean':
        writeAscii(value ? 'true' : 'false');
        return;
      case 'number':
        writeAscii(Number.isFinite(value) ? JSON.stringify(value)! : 'null');
        return;
      case 'string':
        writeString(value);
        return;
      default:
        break;
    }
    if (value === null) {
      writeAscii('null');
      return;
    }
    const container = value as object;
    if (ancestors.has(container)) throw new TypeError('JSON.stringify cannot serialize cyclic structures.');
    if (++depth > GROWTH_PROFILE_OUTPUT_LIMITS.depth) fail('depth');
    visit();
    ancestors.add(container);
    try {
      if (Array.isArray(container)) {
        writeByte(0x5b);
        for (let index = 0; index < container.length; index++) {
          visit();
          if (index > 0) writeByte(0x2c);
          const prepared = prepareJsonValue(container[index], String(index));
          if (prepared === OMITTED) writeAscii('null');
          else writePrepared(prepared);
        }
        writeByte(0x5d);
        return;
      }
      writeByte(0x7b);
      let first = true;
      for (const key of Object.keys(container)) {
        visit();
        const prepared = prepareJsonValue((container as Record<string, unknown>)[key], key);
        if (prepared === OMITTED) continue;
        if (!first) writeByte(0x2c);
        first = false;
        writeString(key);
        writeByte(0x3a);
        writePrepared(prepared);
      }
      writeByte(0x7d);
    } finally {
      ancestors.delete(container);
      depth--;
    }
  };

  const prepared = prepareJsonValue(record, '');
  if (prepared === OMITTED) throw new TypeError('profile record must serialize to a complete JSON value');
  writePrepared(prepared);
  if (offset === 0) throw new TypeError('profile record must serialize to a complete JSON value');
  const line = Buffer.alloc(offset + 1);
  buffer.copy(line, 0, 0, offset);
  line[offset] = 0x0a;
  return line;
}

function serializeProfileLine(record: unknown): Buffer {
  try {
    return encodeProfileLine(record);
  } catch (error) {
    throw error instanceof Error ? error : new TypeError(String(error));
  }
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
