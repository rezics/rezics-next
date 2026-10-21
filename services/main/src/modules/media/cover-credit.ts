import { t } from 'elysia';

export interface CoverCredit {
  kind: 'copyright';
  text: string;
  holder: string | null;
  source: { name: string; href: string };
  permittedRole: 'cover' | 'portrait' | 'screenshot';
}

export const coverCreditSchema = t.Union([
  t.Null(),
  t.Object(
    {
      kind: t.Literal('copyright'),
      text: t.String({ minLength: 1, maxLength: 500 }),
      holder: t.Nullable(t.String({ minLength: 1, maxLength: 200 })),
      source: t.Object(
        {
          name: t.String({ minLength: 1, maxLength: 200 }),
          href: t.String({ format: 'uri', maxLength: 2048 }),
        },
        { additionalProperties: false },
      ),
      permittedRole: t.Union([t.Literal('cover'), t.Literal('portrait'), t.Literal('screenshot')]),
    },
    { additionalProperties: false },
  ),
]);

/** Derive the public mark from sealed provenance, never from Work text or licence obligations. */
export function coverCreditFromProvenance(value: unknown): CoverCredit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provenance = value as Record<string, unknown>;
  const role = provenance.format === 'media-imported-art-v2' ? provenance.role : 'cover';
  if (role !== 'cover' && role !== 'portrait' && role !== 'screenshot') return null;
  const source = provenance.source;
  const holderEvidence = provenance.holderEvidence;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const sourceRecord = source as Record<string, unknown>;
  if (
    typeof sourceRecord.displayName !== 'string' ||
    !sourceRecord.displayName ||
    typeof sourceRecord.href !== 'string' ||
    !sourceRecord.href
  )
    return null;
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceRecord.href);
  } catch {
    return null;
  }
  if (
    /^\s|[\u0000-\u001f\u007f-\u009f]/u.test(sourceRecord.href) ||
    (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:')
  )
    return null;
  let holder: string | null = null;
  if (holderEvidence !== null) {
    if (!holderEvidence || typeof holderEvidence !== 'object' || Array.isArray(holderEvidence))
      return null;
    const name = (holderEvidence as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name) return null;
    holder = name;
  }
  return {
    kind: 'copyright',
    text: holder ?? `(c) rights holder via ${sourceRecord.displayName}`,
    holder,
    source: { name: sourceRecord.displayName, href: sourceRecord.href },
    permittedRole: role,
  };
}
