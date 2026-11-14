import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import { isBookSeriesSourceTuple } from './source-registry.ts';

export type CurrentIdentityProvider = 'bangumi' | 'vndb';
export type CurrentIdentityStatus = 'current' | 'identity_mismatch' | 'wrong_type' | 'unknown';

export type ProviderSourceIdentity =
  | Readonly<{ kind: 'value'; property: string; value: string; nativeType?: string; canonicalRedirect: boolean }>
  | Readonly<{ kind: 'source-tuple' }>;

type IdentityStatement = Readonly<{
  rank?: unknown;
  value?: Readonly<{ type?: unknown; content?: unknown }>;
}>;

type IdentityRead = Readonly<{
  subject?: Readonly<{
    id?: unknown;
    type?: unknown;
    statements?: Readonly<Record<string, readonly IdentityStatement[] | undefined>>;
  }>;
}>;

/** Describe the native identifier a selected Work or Release must still expose. */
export function providerSourceIdentity(
  provider: CurrentIdentityProvider,
  externalId: string,
  nativeType: string | undefined,
): ProviderSourceIdentity | undefined {
  if (provider === 'vndb') {
    if (/^v[1-9][0-9]*$/u.test(externalId))
      return {
        kind: 'value',
        property: 'wdt:P3180',
        value: externalId,
        nativeType: 'wd:Q689445',
        canonicalRedirect: true,
      };
    if (/^r[1-9][0-9]*$/u.test(externalId))
      return {
        kind: 'value',
        property: 'wdt:P3180',
        value: externalId,
        nativeType: 'wd:Q20631656',
        canonicalRedirect: false,
      };
    return undefined;
  }

  if (/^person:[1-9][0-9]*$/u.test(externalId)) {
    if (nativeType === 'schema:Organization') return { kind: 'source-tuple' };
    if (nativeType === 'schema:Person') return undefined;
    return {
      kind: 'value',
      property: 'wdt:P6298',
      value: externalId.slice('person:'.length),
      canonicalRedirect: false,
    };
  }
  if (/^character:[1-9][0-9]*$/u.test(externalId))
    return {
      kind: 'value',
      property: 'wdt:P6296',
      value: externalId.slice('character:'.length),
      canonicalRedirect: false,
    };
  if (/^episode:[1-9][0-9]*$/u.test(externalId))
    return { kind: 'value', property: 'schema:url', value: bangumiRecordUrl(externalId), canonicalRedirect: false };
  if (/^[1-9][0-9]*$/u.test(externalId)) {
    if (isBookSeriesSourceTuple(externalId, nativeType)) return { kind: 'source-tuple' };
    return { kind: 'value', property: 'wdt:P5732', value: externalId, canonicalRedirect: true };
  }
  return undefined;
}

/**
 * Classify the current native source identity. Deprecated history and rankless values do not certify an endpoint;
 * all rows are scanned so a later normal or preferred match remains visible.
 */
export function currentProviderIdentity(
  read: IdentityRead | null,
  input: Readonly<{
    provider: CurrentIdentityProvider;
    externalId: string;
    nativeSubjectId: string;
    expectedType: string | undefined;
    allowCanonicalRedirect?: boolean;
  }>,
): CurrentIdentityStatus {
  const subject = read?.subject;
  if (!subject) return 'unknown';
  if (input.expectedType === undefined || subject.type !== input.expectedType) return 'wrong_type';

  const identity = providerSourceIdentity(input.provider, input.externalId, input.expectedType);
  if (!identity) return 'unknown';
  if (identity.kind === 'source-tuple')
    return subject.id === input.nativeSubjectId ? 'current' : 'identity_mismatch';
  if (identity.nativeType !== undefined && input.expectedType !== identity.nativeType) return 'wrong_type';

  const allowCanonicalRedirect = input.allowCanonicalRedirect ?? identity.canonicalRedirect;
  if (!allowCanonicalRedirect && subject.id !== input.nativeSubjectId) return 'identity_mismatch';

  const statements = subject.statements?.[identity.property];
  if (!Array.isArray(statements)) return 'unknown';
  return statements.some(
    (statement) =>
      (statement.rank === 'normal' || statement.rank === 'preferred') &&
      statement.value?.type === 'value' &&
      statement.value.content === identity.value,
  )
    ? 'current'
    : 'identity_mismatch';
}
