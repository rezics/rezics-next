import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { snapshot } from './reads.ts';
import { prepareEditionSubjectIdentities } from './edition-subject.ts';
import { knowledgeSubjectTargets } from './knowledge-model.ts';
import metadata from './knowledge-discovery-metadata.sql';

/** Native immutable selection identity. None of these fields grants read authority. */
export type KnowledgeDiscoveryCandidate = Readonly<{
  subjectId: string;
  documentId: string;
  publicationId: string;
  revisionId: string;
  publishedAt: string;
}>;

/** Navigation for the exact admitted selection; no private container, author, body or reference list. */
export type KnowledgeDiscoverySummary = KnowledgeDiscoveryCandidate &
  Readonly<{
    title: string;
    language: string | null;
    licence: string;
    sha256: string;
  }>;
export type KnowledgeDiscoveryContext = Readonly<{ deadline: number }>;
export type KnowledgeDiscoveryCurrent =
  | Readonly<{ status: 'ready'; value: KnowledgeDiscoverySummary | null }>
  | Readonly<{ status: 'unavailable' }>;
export type KnowledgeDiscoverySource = Readonly<{
  /** The requested original Subject is checked as anonymous, even for a signed-in owner. */
  subject(subjectId: string, context: KnowledgeDiscoveryContext): Promise<'available' | 'withheld' | 'unavailable'>;
  /** Event receiving reads only the exact current selection's index keys. */
  selected(
    documentId: string,
    publicationId: string,
    context: KnowledgeDiscoveryContext,
  ): Promise<KnowledgeDiscoveryCandidate | null>;
  current(
    candidate: KnowledgeDiscoveryCandidate,
    context: KnowledgeDiscoveryContext,
  ): Promise<KnowledgeDiscoveryCurrent>;
}>;

/** The direct public reader and this seam use the same native current pointer and anonymous Subject checks.
 * This does not copy Content bytes or establish another publication authority. */
export function createKnowledgeDiscoverySource(
  deps: Readonly<{ pool: Pool; access: Access }>,
): KnowledgeDiscoverySource {
  const read = async (documentId: string, context: KnowledgeDiscoveryContext) => {
    const result = await snapshot(deps, documentId, context, (client) =>
      metadata.run(client, { route: routeOf(documentId)!, document_id: documentId }),
    );
    return result.value;
  };
  const identity = (row: NonNullable<Awaited<ReturnType<typeof read>>>): KnowledgeDiscoveryCandidate => ({
    subjectId: row.subject_id,
    documentId: row.document_id,
    publicationId: row.publication_id,
    revisionId: row.revision_id,
    publishedAt: row.published_at!,
  });
  const matches = (candidate: KnowledgeDiscoveryCandidate, row: NonNullable<Awaited<ReturnType<typeof read>>>) =>
    candidate.documentId === row.document_id &&
    candidate.publicationId === row.publication_id &&
    candidate.revisionId === row.revision_id &&
    candidate.subjectId === row.subject_id &&
    candidate.publishedAt === row.published_at;
  return {
    async subject(subjectId, context) {
      const current = await prepareEditionSubjectIdentities(deps, [subjectId], {
        actor: { kind: 'anonymous' },
        deadline: context.deadline,
      });
      return (await current()).get(subjectId)?.kind === 'available' ? 'available' : 'withheld';
    },
    async selected(documentId, publicationId, context) {
      const row = await read(documentId, context);
      return row?.publication_id === publicationId ? identity(row) : null;
    },
    async current(candidate, context) {
      const initial = await read(candidate.documentId, context);
      if (!initial || !matches(candidate, initial)) return { status: 'ready', value: null };
      const subjects = knowledgeSubjectTargets(initial.subject_id, initial.subject_ids as string[]);
      const currentSubjects = await prepareEditionSubjectIdentities(deps, subjects, {
        actor: { kind: 'anonymous' },
        deadline: context.deadline,
      });
      const visible = async () => {
        const identities = await currentSubjects();
        return subjects.every((id) => identities.get(id)?.kind === 'available');
      };
      if (!(await visible())) return { status: 'ready', value: null };
      const final = await read(candidate.documentId, context);
      if (!final || !matches(candidate, final) || final.sha256 !== initial.sha256 || !(await visible()))
        return { status: 'ready', value: null };
      return {
        status: 'ready',
        value: {
          ...identity(final),
          title: final.title,
          language: final.language,
          licence: final.licence,
          sha256: final.sha256!,
        },
      };
    },
  };
}
