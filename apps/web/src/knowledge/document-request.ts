import { notFound } from '@tanstack/react-router';
import { knowledgeDiscoverySearch } from './discovery-visit';
import {
  knowledgeId,
  knowledgeRevisionQuery,
  parseKnowledgeExactCitation,
  type KnowledgeReadRequest,
} from './public-read';

type KnowledgeDocumentSearch = { revisionId?: string; returnTo?: string; sha256?: string; blockId?: string };

export function knowledgeDocumentSearch(search: Record<string, unknown>): KnowledgeDocumentSearch {
  const returning = knowledgeDiscoverySearch(search);
  const pinned = search.sha256 !== undefined || search.blockId !== undefined;
  if (!pinned && (search.revisionId === undefined || search.revisionId === '')) return returning;
  const revisionId = knowledgeRevisionQuery(search.revisionId);
  if (!revisionId) throw notFound();
  if (!pinned) return { revisionId, ...returning };
  const citation = parseKnowledgeExactCitation(search.sha256, search.blockId);
  if (!citation) throw notFound();
  return { revisionId, ...citation, ...returning };
}

export function knowledgeDocumentRequest(
  documentId: string,
  revisionId: string | undefined,
  locale: string,
  search?: Pick<KnowledgeDocumentSearch, 'sha256' | 'blockId'>,
): KnowledgeReadRequest | null {
  const id = knowledgeId(documentId);
  if (!id) return null;
  const pinned = search?.sha256 !== undefined || search?.blockId !== undefined;
  const citation = pinned ? parseKnowledgeExactCitation(search?.sha256, search?.blockId) : null;
  if (pinned && !citation) return null;
  if (revisionId === undefined) return pinned ? null : { documentId: id, revisionId: null, locale };
  const exact = knowledgeId(revisionId);
  return exact ? { documentId: id, revisionId: exact, locale, ...(citation ? { citation } : {}) } : null;
}
