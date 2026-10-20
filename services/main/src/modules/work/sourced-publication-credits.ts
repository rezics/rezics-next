import { hash } from './activate.ts';
import { readCreditAttribution } from '../profiles/attribution.ts';
import { readWorkBasis } from './read-header.ts';
import { selectedPublicationAttribution } from './sourced-structure-publication.ts';
import type { WorkReadSession } from './read-session.ts';

/** Selected-publication credits disappear on withdrawal, independently of retained Source custody. */
export async function sourcedPublicationCreditReferences(session: WorkReadSession, works: readonly string[]) {
  const refs: Array<{ work: string; id: string; key: string; ordinal: number; role: string;
    provider: string; agent: string | null; displayName: string | null }> = [];
  for (const work of works) {
    const basis = await readWorkBasis(session, work);
    const attribution = await selectedPublicationAttribution(session, basis.structuredPublication);
    if (!attribution || !basis.structuredPublication || !('record' in attribution)) continue;
    const transcriber = await readCreditAttribution(session, attribution.transcriber);
    const hex = hash(basis.structuredPublication.source).slice(0, 32);
    const authorId = `https://rezics.com/id/${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    refs.push({ work, id: authorId, key: `${attribution.externalId}/author`,
      ordinal: 0, role: 'author', provider: attribution.provider, agent: null, displayName: attribution.author },
    { work, id: basis.structuredPublication.decision, key: attribution.transcriber,
      ordinal: 0, role: 'transcriber', provider: attribution.provider, agent: attribution.transcriber,
      displayName: transcriber.displayName });
  }
  return refs;
}
