// SPDX-License-Identifier: Apache-2.0
import { parseLocator } from '../protocol/locator.ts';
import { parseTxt } from './txt.ts';
import { parseEpub } from './epub.ts';
import { parseRenpy } from './renpy.ts';
import { digest, type ParsedText } from './types.ts';
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}
export type { TextUnit, Verification, ParsedText } from './types.ts';
export { parseLocator, checkLocator } from '../protocol/locator.ts';

/** Local-only, O(input + expanded text) parsing. The caller supplies bytes; no I/O or inference. */
export function parseFile(
  bytes: Uint8Array,
  format: 'txt' | 'epub' | 'rpy',
  options: { encoding?: string } = {},
): ParsedText {
  // A copy isolates parsing and verification from caller mutation.
  const original = Uint8Array.from(bytes);
  const parsed =
    format === 'txt'
      ? parseTxt(original, options.encoding)
      : format === 'epub'
        ? parseEpub(original)
        : format === 'rpy'
          ? parseRenpy(original)
          : undefined;
  if (!parsed) throw new Error('Unsupported format; use TXT, EPUB or literal .rpy source');
  for (const unit of parsed.units) parseLocator(unit.locator);
  // Verification must continue to read the pinned text, even if a caller edits its unit.
  freeze(parsed.units);
  const sha256 = digest(original);
  return {
    units: parsed.units,
    locate: parsed.locate,
    verify(input) {
      const locator = parseLocator(input);
      if (
        locator.source.type !== 'external' ||
        locator.source.representationSha256 !== sha256 ||
        locator.source.mediaType !==
          (format === 'txt'
            ? 'text/plain'
            : format === 'epub'
              ? 'application/epub+zip'
              : 'text/x-renpy')
      )
        throw new Error(
          'Locator belongs to a different representation (SHA-256 or format mismatch)',
        );
      return parsed.verify(locator);
    },
  };
}
