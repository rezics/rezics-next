import type { AgentOption } from '../auth/acting-identity.ts';
import { resolveStudioAgent, studioSegmentIri } from '../studio/agent.ts';

/**
 * Who a recipe editor link acts as. The segment is Studio's `@handle` or `@sid`.
 * A segment that names an address this account's list does not contain is still
 * that Agent: Main refuses it. Only a link with no segment uses the session Agent.
 */
export type RecipeActor =
  | { kind: 'session'; actingSubject: string }
  | { kind: 'named'; actingSubject: string }
  /** The link names an Agent and it is not an address we can send. The session does not replace it. */
  | { kind: 'unresolved' };

export function recipeActor(segment: string | null, options: readonly AgentOption[], sessionSubject: string): RecipeActor {
  if (!segment) return { kind: 'session', actingSubject: sessionSubject };
  const resolved = resolveStudioAgent(segment, options);
  if (resolved.kind === 'agent') return { kind: 'named', actingSubject: resolved.agent.iri };
  const iri = studioSegmentIri(segment);
  return iri ? { kind: 'named', actingSubject: iri } : { kind: 'unresolved' };
}
