import type { ReviewedSubjectRead } from './import-client.ts';
import type { Provider } from './cross-media-bindings.ts';

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

export type PersonIdentityObservation = CurrentPersonIdentity | Readonly<{
  state: Exclude<PersonIdentityCurrentness, 'current'>;
  identity: PersonIdentity;
}>;

/** Only exact source-key identities qualify; names and credit evidence never create a binding. */
export function personIdentityForSource(
  source: Provider,
  externalId: string,
  expectedType: string | undefined,
): PersonIdentity | undefined {
  if (expectedType !== 'schema:Person') return undefined;
  if (source === 'bangumi' && /^person:[1-9][0-9]*$/u.test(externalId))
    return { source, externalId, property: 'wdt:P6298', value: externalId.slice('person:'.length) };
  if (source === 'vndb' && /^s[1-9][0-9]*$/u.test(externalId))
    return { source, externalId, property: 'wdt:P3180', value: externalId };
  return undefined;
}

/**
 * A native merge may redirect the original source binding to a canonical Person.
 * Accept that current endpoint only while its type and single exact provider key remain present.
 */
export function observePersonIdentity(
  identity: PersonIdentity,
  read: ReviewedSubjectRead,
): PersonIdentityObservation {
  const subject = read.subject;
  if (subject.type !== 'schema:Person') return { state: 'wrong_type', identity };
  const values = (subject.statements[identity.property] ?? []).flatMap((statement) =>
    statement.value.type === 'value' && typeof statement.value.content === 'string'
      ? [statement.value.content]
      : [],
  );
  if (!values.length) return { state: 'missing', identity };
  const unique = new Set(values);
  if (unique.size !== 1 || !unique.has(identity.value)) return { state: 'conflicting', identity };
  return { state: 'current', currentSubjectId: subject.id, identity };
}
