import type { ReviewedSubjectRead } from './import-client.ts';
import type { Provider } from './cross-media-bindings.ts';
import type { SourceRecord } from '@rezics/conversion';

export type PersonIdentity = Readonly<{
  source: Provider;
  externalId: string;
  property: 'wdt:P6298' | 'wdt:P3180';
  value: string;
}>;

export type PersonIdentityCurrentness = 'current' | 'missing' | 'wrong_type' | 'conflicting';

export type CurrentPersonIdentity = Readonly<{
  state: 'current';
  currentSubjectId: string;
  identity: PersonIdentity;
}>;

export type PersonIdentityObservation =
  | CurrentPersonIdentity
  | Readonly<{
      state: Exclude<PersonIdentityCurrentness, 'current'>;
      identity: PersonIdentity;
    }>;

/** Private seed handoff. The binding is the original native UUID, even after a merge. */
export type PersonReviewSource = Readonly<{
  identity: PersonIdentity;
  boundSubjectId: string;
  sourceAlias: string;
  record: SourceRecord;
  digest: string;
  converterRevision: string;
}>;

export type PersonReviewSelection = Readonly<{
  bangumi: string;
  vndb: string;
}>;

/** Acquisition selects this human; native review still requires fresh evidence and explicit consent. */
export const showcasePersonReview = {
  selection: { bangumi: 'person:1916', vndb: 's224' },
  independentEvidence: 'https://artist.cdjournal.com/a/maeda-jun/842760',
} as const;

export type PersonReviewPair =
  | Readonly<{ state: 'selected'; sources: readonly [PersonReviewSource, PersonReviewSource] }>
  | Readonly<{
      state: 'incomplete';
      missing: readonly Readonly<{ source: Provider; externalId: string }>[];
    }>;

/** Use the converter's actual type and digest, never a name match or a fabricated native ID. */
export function personReviewSource(input: {
  record: SourceRecord;
  nativeType: string;
  boundSubjectId: string;
  sourceAlias: string;
  digest: string;
  converterRevision: string;
}): PersonReviewSource | undefined {
  const { record } = input;
  if (record.source !== 'bangumi' && record.source !== 'vndb') return undefined;
  const identity = personIdentityForSource(record.source, record.key, input.nativeType);
  if (!identity) return undefined;
  const { nativeType: _, ...source } = input;
  return { identity, ...structuredClone(source) };
}

/** Select exact admitted records for comparison. Selection is not an identity decision. */
export function selectPersonReviewPair(
  sources: readonly PersonReviewSource[],
  selection: PersonReviewSelection,
): PersonReviewPair {
  const bangumi = sources.find(
    (entry) => entry.identity.source === 'bangumi' && entry.identity.externalId === selection.bangumi,
  );
  const vndb = sources.find(
    (entry) => entry.identity.source === 'vndb' && entry.identity.externalId === selection.vndb,
  );
  if (bangumi && vndb) return { state: 'selected', sources: [bangumi, vndb] };
  return {
    state: 'incomplete',
    missing: [
      ...(!bangumi ? [{ source: 'bangumi' as const, externalId: selection.bangumi }] : []),
      ...(!vndb ? [{ source: 'vndb' as const, externalId: selection.vndb }] : []),
    ],
  };
}

/** Only exact source-key identities qualify; names and credit evidence never create a binding. */
export function personIdentityForSource(
  source: Provider,
  externalId: string,
  expectedType: string | undefined,
): PersonIdentity | undefined {
  if (expectedType !== 'schema:Person') return undefined;
  if (source === 'bangumi' && /^person:[1-9][0-9]*$(?![\s\S])/u.test(externalId))
    return { source, externalId, property: 'wdt:P6298', value: externalId.slice('person:'.length) };
  if (source === 'vndb' && /^s[1-9][0-9]*$(?![\s\S])/u.test(externalId))
    return { source, externalId, property: 'wdt:P3180', value: externalId };
  return undefined;
}

/**
 * A native merge may redirect the original source binding to a canonical Person.
 * Accept that current endpoint only while its type and single exact provider key remain present.
 */
export function observePersonIdentity(identity: PersonIdentity, read: ReviewedSubjectRead): PersonIdentityObservation {
  const subject = read.subject;
  if (subject.type !== 'schema:Person') return { state: 'wrong_type', identity };
  const selected = (subject.statements[identity.property] ?? []).filter((statement) => statement.rank !== 'deprecated');
  if (selected.some((statement) => statement.value.type !== 'value' || typeof statement.value.content !== 'string'))
    return { state: 'conflicting', identity };
  const values = selected.flatMap((statement) =>
    statement.value.type === 'value' ? [statement.value.content as string] : [],
  );
  if (!values.length) return { state: 'missing', identity };
  const unique = new Set(values);
  if (unique.size !== 1 || !unique.has(identity.value)) return { state: 'conflicting', identity };
  return { state: 'current', currentSubjectId: subject.id, identity };
}
