// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import type { Locator } from '../protocol/locator.ts';

export interface TextUnit {
  id: string;
  ordinal: number;
  kind: 'chapter' | 'scene' | 'utterance';
  label: string;
  text: string;
  locator: Locator;
  warnings: string[];
  decoding?: {
    encoding: string;
    basis: 'declared' | 'bom' | 'detected';
    uncertain: boolean;
    alternatives: string[];
  };
  speaker?: string | null;
  route?: string[];
  jumps?: string[];
  ruby?: { base: string; reading: string; start: number; end: number }[];
}
export interface Verification {
  resolution?: 'quote-fallback';
  quote: string;
  context: { prefix: string; suffix: string };
  locator: Locator;
}
export interface ParsedText {
  units: TextUnit[];
  verify(locator: Locator): Verification;
  /** UTF-16 positions in the unit's text, refusing surrogate-pair splits. */
  locate(unit: TextUnit, start: number, end: number): Locator;
}
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function source(bytes: Uint8Array, mediaType: string) {
  return { type: 'external' as const, representationSha256: digest(bytes), mediaType };
}
export function quoteSelector(text: string, start: number, end: number) {
  return {
    type: 'TextQuoteSelector' as const,
    exact: text.slice(start, end),
    prefix: [...text.slice(0, start)].slice(-32).join(''),
    suffix: [...text.slice(end)].slice(0, 32).join(''),
  };
}
export function bounds(text: string, start: number, end: number) {
  const split = (offset: number) =>
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length ||
    split(start) ||
    split(end)
  )
    throw new Error('Invalid text range (UTF-16 boundaries required)');
}
export function verified(locator: Locator, text: string, start: number, end: number): Verification {
  bounds(text, start, end);
  const quote = text.slice(start, end);
  if (
    locator.quote &&
    (locator.quote.exact !== quote ||
      !text.slice(0, start).endsWith(locator.quote.prefix ?? '') ||
      !text.slice(end).startsWith(locator.quote.suffix ?? ''))
  )
    throw new Error('Locator quote does not match the selected text');
  const q = quoteSelector(text, start, end);
  return { quote, context: { prefix: q.prefix, suffix: q.suffix }, locator };
}
