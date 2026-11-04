import { locales } from '../../../paraglide/runtime.js';

const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function originatingClassification(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
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
