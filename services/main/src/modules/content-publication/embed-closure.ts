import type { ContentCore, ExactContentReference } from '../../../../content/src/core.ts';
import { CONTENT_EMBED_LIMITS, ContentEmbedInvalid, directContentEmbeds }
  from '../../../../content/src/embed.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';

export class ContentEmbedDenied extends Error {}
export class ContentEmbedUnavailable extends Error {}

export interface EmbedClosure {
  dependencies: ExactContentReference[];
  cost: { revisionsRead: number; edges: number; depth: number; bytesRead: number;
    publicChecks: number };
}

const exactIri = (revisionId: string) => `urn:rezics:content:revision:${revisionId}`;

/** Read each exact immutable Content body, including nested embeds, within a fixed budget. */
export async function readContentEmbedClosure(content: Pick<ContentCore, 'readExactBatch'>,
  rootRevisionId: string): Promise<EmbedClosure> {
  const seen = new Set([rootRevisionId]);
  const dependencies: ExactContentReference[] = [];
  let frontier = [rootRevisionId];
  let depth = 0;
  let bytesRead = 0;
  let edges = 0;
  let revisionsRead = 0;
  while (frontier.length) {
    if (depth > CONTENT_EMBED_LIMITS.depth || seen.size > CONTENT_EMBED_LIMITS.closure) {
      throw new ContentEmbedDenied('Content embed dependency closure exceeds its bound');
    }
    const batch = await content.readExactBatch(frontier,
      async ids => new Set(ids));
    const next: string[] = [];
    for (const exact of batch) {
      if (exact.status !== 'available') {
        throw new ContentEmbedUnavailable('exact Content embed dependency is unavailable');
      }
      revisionsRead++;
      bytesRead += Buffer.byteLength(exact.serializedJson, 'utf8');
      if (bytesRead > CONTENT_EMBED_LIMITS.bytes) {
        throw new ContentEmbedDenied('Content embed bytes exceed the closure bound');
      }
      if (exact.revisionId !== rootRevisionId) dependencies.push(exact.reference);
      let direct: string[];
      try { direct = directContentEmbeds(exact.body.embeds); }
      catch (error) {
        if (error instanceof ContentEmbedInvalid) {
          throw new ContentEmbedDenied('Content embed dependency set is invalid');
        }
        throw error;
      }
      edges += direct.length;
      for (const child of direct) {
        if (child === rootRevisionId) {
          throw new ContentEmbedDenied('Content embed dependency cycle is invalid');
        }
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    frontier = next;
    depth++;
  }
  return { dependencies, cost: { revisionsRead, edges,
    depth: depth - 1, bytesRead, publicChecks: dependencies.length } };
}

/** Public search eligibility is the explicit disclosure decision for each exact embedded revision. */
export async function assertPublicContentEmbeds(env: WorkActivationEnvironment,
  content: Pick<ContentCore, 'readExactBatch'>, rootRevisionId: string): Promise<EmbedClosure> {
  const closure = await readContentEmbedClosure(content, rootRevisionId);
  if (!closure.dependencies.length) return closure;
  const pairs = closure.dependencies.map(ref =>
    `(${iri(ref.variantId)} ${iri(exactIri(ref.revisionId))})`).join(' ');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?variant ?revision WHERE {
      VALUES (?variant ?revision) { ${pairs} }
      GRAPH ${iri(GRAPHS.current)} { ?variant rv:contentPublicationHead ?publication ;
        rv:publicSearchEligibilityHead ?eligibility . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?publication a rv:ContentPublicationDecision ; rv:contentRevision ?revision .
        ?eligibility a rv:ContentSearchEligibilityDecision ;
          rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      }
    }`, 128 * 1024);
  const publicPairs = new Set((result.results?.bindings ?? []).map(row =>
    `${row.variant?.value}\0${row.revision?.value}`));
  if (closure.dependencies.some(ref => !publicPairs.has(
    `${ref.variantId}\0${exactIri(ref.revisionId)}`))) {
    throw new ContentEmbedDenied('an exact Content embed lacks public disclosure');
  }
  return closure;
}

/** Rechecks the exact disclosure heads atomically with the publication graph switch. */
export function publicContentEmbedGuards(dependencies: readonly ExactContentReference[]): string {
  return dependencies.map(ref => `FILTER EXISTS {
    GRAPH ${iri(GRAPHS.current)} { ${iri(ref.variantId)} rv:contentPublicationHead ?embedPublication${ref.revisionId.replaceAll('-', '')} ;
      rv:publicSearchEligibilityHead ?embedEligibility${ref.revisionId.replaceAll('-', '')} . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?embedPublication${ref.revisionId.replaceAll('-', '')} a rv:ContentPublicationDecision ;
        rv:contentRevision ${iri(exactIri(ref.revisionId))} .
      ?embedEligibility${ref.revisionId.replaceAll('-', '')} a rv:ContentSearchEligibilityDecision ;
        rv:publicationDecision ?embedPublication${ref.revisionId.replaceAll('-', '')} ;
        rv:disclosure rv:Public . }
  }`).join('\n');
}
