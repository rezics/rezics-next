import type { SuppliedLanguage } from './field-support-contract.ts';
import { canonicalLanguage } from '../display-language/tag.ts';

/** A bounded native text slot, independent of the single-line metadata summary.
 * Larger candidates remain exact retained evidence with an explicit disposition. */
export const SYNOPSIS_TEXT_LIMIT = 1_048_576;
export function validSynopsisText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SYNOPSIS_TEXT_LIMIT
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
export function validSuppliedLanguage(value: unknown): value is SuppliedLanguage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.state === 'omitted' || row.state === 'null') && Object.keys(row).length === 1
    || row.state === 'value' && Object.keys(row).length === 2 && typeof row.value === 'string'
      && row.value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(row.value);
}
export function suppliedLanguage(value: { language?: string | null }): SuppliedLanguage {
  return !Object.hasOwn(value, 'language') ? { state: 'omitted' } : value.language === null
    ? { state: 'null' } : { state: 'value', value: value.language! };
}
export function synopsisPropertyValue(text: string, language: SuppliedLanguage) {
  const tag = language.state === 'value' ? canonicalLanguage(language.value) : null;
  return tag && !['mul', 'other', 'unknown'].includes(tag)
    ? { kind: 'language-string' as const, lexical: text, language: tag }
    : { kind: 'string' as const, lexical: text };
}
