import { isCompleteStableAncestorPath, type StableAncestor } from './hosted-chapters-tree.ts';
import { KNOWLEDGE_ANCESTOR_LIMIT } from './knowledge-model.ts';

/** The notebook owns its tree policy. This shared primitive checks a full keyed path without Book limits. */
export function admitsKnowledgeAncestorPath(path: readonly StableAncestor[]): boolean {
  return isCompleteStableAncestorPath(path, KNOWLEDGE_ANCESTOR_LIMIT);
}
