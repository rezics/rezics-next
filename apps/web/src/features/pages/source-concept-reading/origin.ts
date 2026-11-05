import { locales } from '../../../paraglide/runtime.js';
import { workTagOriginatingReturn } from '../subject-visit-navigation';

/** Work tags retain an admitted visit address; ordinary classification origins keep the existing allowlist. */
export function originatingConceptReturn(value: unknown, locale?: string): string | undefined {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 2048) return;
  const work = workTagOriginatingReturn(value, locale);
  if (work) return work;
  const ordinary = originatingReturn(value);
  if (ordinary && (locale === undefined || ordinary.split('/')[1] === locale)) return ordinary;
}

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function originatingClassification(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    new TextEncoder().encode(value).byteLength > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n?#]/.test(value) ||
    /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return;
  try {
    const target = new URL(value, 'https://rezics.invalid');
    const parts = target.pathname.split('/');
    if (
      target.origin !== 'https://rezics.invalid' ||
      target.search ||
      target.hash ||
      parts.length !== 6 ||
      !locales.includes(decodeURIComponent(parts[1] ?? '') as (typeof locales)[number]) ||
      parts[2] !== 'subjects' ||
      !subjectId.test(decodeURIComponent(parts[3] ?? '')) ||
      !parts[4] ||
      parts[5] !== 'graph'
    )
      return;
    return value;
  } catch {
    return;
  }
}

/** A local subject overview or classification return path, with no query or fragment. */
export function originatingReturn(value: unknown): string | undefined {
  const classification = originatingClassification(value);
  if (classification) return classification;
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    new TextEncoder().encode(value).byteLength > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n?#]/.test(value) ||
    /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return;
  try {
    const target = new URL(value, 'https://rezics.invalid');
    const parts = target.pathname.split('/');
    if (
      target.origin !== 'https://rezics.invalid' ||
      target.search ||
      target.hash ||
      parts.length !== 5 ||
      !locales.includes(decodeURIComponent(parts[1] ?? '') as (typeof locales)[number]) ||
      parts[2] !== 'subjects' ||
      !subjectId.test(decodeURIComponent(parts[3] ?? '')) ||
      !parts[4]
    )
      return;
    return value;
  } catch {
    return;
  }
}
