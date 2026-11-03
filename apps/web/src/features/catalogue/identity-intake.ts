export type IdentityIntakeInput = {
  q: string;
  language: string;
  typeId: string;
  releaseDigest: string;
  locale: string;
};

export type IdentityIntakeBinding = IdentityIntakeInput & { generation: number };
export type IdentityIntakeStatus =
  | 'ready'
  | 'partial'
  | 'empty'
  | 'stale'
  | 'unavailable'
  | 'signed-out'
  | 'denied'
  | 'invalid';

export type IdentityFact =
  | { kind: 'item'; label?: string }
  | { kind: 'time'; year: number }
  | { kind: 'quantity'; amount: number; unit: string }
  | { kind: 'code'; value: string };

export type IdentityHit = {
  id: string;
  type: string;
  typeLabel?: string;
  labels: { language: string; value: string }[];
  summary: { label?: { language: string; value: string }; creativeWork: boolean; types: string[] } | null;
  facts: { property: string; propertyLabel?: string; value: IdentityFact }[];
};

export type IdentityIntakePage = {
  binding: IdentityIntakeBinding | null;
  status: IdentityIntakeStatus;
  viewer: { state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable' };
  actions: {
    openExisting: boolean;
    continueWithResults: boolean;
    continueUnverified: boolean;
    retry: boolean;
    createAuthority: 'unknown';
  };
  results: IdentityHit[];
};

const languageTag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;

export function normalizeIdentityQuery(value: string): string | null {
  const query = value.trim().replace(/\s+/gu, ' ');
  const codePoints = [...query].length;
  return query.length <= 128 && codePoints >= 1 && codePoints <= 64 ? query : null;
}

export function validIdentityLanguage(value: string): boolean {
  return value.length <= 35 && languageTag.test(value.trim());
}

export function identityIntentKey(
  input: IdentityIntakeInput | null,
  version: number,
  viewerKey: string,
): string | null {
  if (!input) return null;
  const q = normalizeIdentityQuery(input.q);
  const language = input.language.trim();
  if (
    !q ||
    !validIdentityLanguage(language) ||
    !input.typeId ||
    input.typeId.length > 256 ||
    !input.releaseDigest ||
    input.releaseDigest.length > 256 ||
    !languageTag.test(input.locale) ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    return null;
  return JSON.stringify([q, language, input.typeId, input.releaseDigest, input.locale, version, viewerKey]);
}

export function parseIdentityIntakeRequest(params: URLSearchParams): IdentityIntakeBinding | null {
  const allowed = new Set(['q', 'language', 'type', 'release', 'locale', 'generation']);
  if ([...params.keys()].some((key) => !allowed.has(key))) return null;
  for (const key of allowed) if (params.getAll(key).length !== 1) return null;
  const rawQuery = params.get('q') ?? '';
  const q = normalizeIdentityQuery(rawQuery);
  const language = (params.get('language') ?? '').trim();
  const typeId = params.get('type') ?? '';
  const releaseDigest = params.get('release') ?? '';
  const locale = params.get('locale') ?? '';
  const generationValue = params.get('generation') ?? '';
  if (
    new TextEncoder().encode(rawQuery).byteLength > 512 ||
    !q ||
    !validIdentityLanguage(language) ||
    typeId.length < 1 ||
    typeId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(typeId) ||
    releaseDigest.length < 1 ||
    releaseDigest.length > 256 ||
    !languageTag.test(locale) ||
    !/^\d{1,16}$/u.test(generationValue)
  )
    return null;
  const generation = Number(generationValue);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return { q, language, typeId, releaseDigest, locale, generation };
}

export function identityBinding(input: IdentityIntakeInput, generation: number): IdentityIntakeBinding {
  const q = normalizeIdentityQuery(input.q);
  const language = input.language.trim();
  if (!q || !validIdentityLanguage(language)) throw new TypeError('Invalid identity intake intent');
  return { ...input, q, language, generation };
}

export function isIdentityIntakePage(value: unknown): value is IdentityIntakePage {
  if (value === null || typeof value !== 'object') return false;
  const page = value as Partial<IdentityIntakePage>;
  return (
    (page.status === 'ready' ||
      page.status === 'partial' ||
      page.status === 'empty' ||
      page.status === 'stale' ||
      page.status === 'unavailable' ||
      page.status === 'signed-out' ||
      page.status === 'denied' ||
      page.status === 'invalid') &&
    (page.binding === null || (typeof page.binding === 'object' && page.binding !== null)) &&
    typeof page.viewer === 'object' &&
    page.viewer !== null &&
    (page.viewer.state === 'unknown' ||
      page.viewer.state === 'signed-in' ||
      page.viewer.state === 'signed-out' ||
      page.viewer.state === 'unavailable') &&
    typeof page.actions === 'object' &&
    page.actions !== null &&
    page.actions.createAuthority === 'unknown' &&
    Array.isArray(page.results)
  );
}

export async function readIdentityIntake(
  input: IdentityIntakeInput,
  generation: number,
  signal: AbortSignal,
): Promise<IdentityIntakePage> {
  const binding = identityBinding(input, generation);
  const params = new URLSearchParams({
    q: binding.q,
    language: binding.language,
    type: binding.typeId,
    release: binding.releaseDigest,
    locale: binding.locale,
    generation: String(generation),
  });
  const response = await fetch(`/api/catalogue/identity-intake?${params}`, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const value = await response.json().catch(() => undefined);
  if (!isIdentityIntakePage(value)) throw new Error('Identity intake response unavailable');
  if (value.status !== 'invalid' && JSON.stringify(value.binding) !== JSON.stringify(binding))
    throw new Error('Identity intake response no longer matches the current search');
  if (!response.ok && value.status !== 'invalid') throw new Error('Identity intake response unavailable');
  return value;
}
