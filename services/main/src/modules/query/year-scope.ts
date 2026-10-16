import { compileQuery, QueryRejected } from './compile.ts';
import type { TemplateInput } from './template-schema.ts';
import { browseCandidates, browseFilter, readBrowseBatch } from '../zone-modules/browse.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { WorkReadInvalid, type WorkReadSession } from '../work/read-session.ts';

/** Conditions have exactly the same admission and evaluation as Realm browse.
 * The year index supplies a bounded window, never a sampled Realm roster. */
export function publicationYearScope(parameters: TemplateInput['parameters']) {
  const { realm, filter, text } = parameters;
  if (!realm) {
    if (filter !== undefined || text !== undefined) throw new WorkReadInvalid('Year Conditions require a Realm');
    return null;
  }
  const plan = compileQuery({ profile: 'filter-document-v2', context: { realm }, scope: { kind: 'realm', realm },
    filter, ...(text ? { text: { phrase: text } } : {}), sort: 'newest', page: { size: 20 } });
  if (plan.template !== 'zone-browse') throw new QueryRejected('unsupported_query_shape', 'Year Conditions require a Realm browse plan');
  return { realm, query: plan.request };
}

export async function scopedPublicationWorks(session: WorkReadSession,
  scope: NonNullable<ReturnType<typeof publicationYearScope>>, works: string[]) {
  await readRealmBasis(session, scope.realm);
  const filter = browseFilter(scope.query);
  const batch = await readBrowseBatch(session, scope.realm, works, filter, undefined, scope.query.publicationYear);
  return new Set(browseCandidates(batch.candidates, filter, scope.query.q ?? null, 'newest').found.map(row => row.work));
}
