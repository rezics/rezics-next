import type { Pool } from 'pg';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { ContextNotFound, readContextRevision } from '../context/read.ts';
import { PrivateContextSelections } from '../context/private-selection.ts';
import type { RankingBasis, RankingViewer } from './ranking.ts';
import { RecommendationUnavailable } from './derived-generation.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Resolve the pinned revision against the Context owner and its current selection.
 * The exact head check also withholds a page immediately after a selection change. */
export async function verifyRankingSemanticBasis(env: WorkActivationEnvironment, access: Pool,
  selections: PrivateContextSelections, viewer: RankingViewer, basis: RankingBasis): Promise<boolean> {
  const semantic = basis.semantic;
  if (!semantic) return true;
  try {
    const definition = await readContextRevision(env, semantic.context, semantic.contextRevision,
      context => selections.canReadPrivate(viewer.principal, viewer.actingSubject, context));
    if (definition.state !== 'active' || (basis.population.kind !== 'personal'
      && definition.disclosure === 'private')) return false;
    const preference = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(semantic.context)} a rv:SemanticContext .
        OPTIONAL { ${iri(semantic.context)} rv:preferenceHead ?head } }
    }`)).results?.bindings ?? [];
    if (preference.length !== 1 || (preference[0]?.head?.value ?? null) !== semantic.preferenceRevision) return false;
    if (basis.population.kind === 'personal') {
      if (!uuid.test(semantic.selectionRevision)) return false;
      const selected = await access.query(`SELECT 1 FROM access.context_selection_revision r
        JOIN access.context_selection s ON s.id = r.selection_id AND s.head_revision = r.id
        JOIN access.principal p ON p.id = s.principal_id
        WHERE r.id = $1::uuid AND p.account_issuer = $2 AND p.account_subject = $3 AND p.active
          AND r.state = 'selected' AND r.context = $4 AND r.semantic_revision = $5
          AND r.preference_revision IS NOT DISTINCT FROM $6 LIMIT 1`,
      [semantic.selectionRevision, viewer.principal.issuer, viewer.principal.subject,
        semantic.context, semantic.contextRevision, semantic.preferenceRevision]);
      return selected.rowCount === 1;
    }
    if (basis.population.kind === 'realm') {
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?selection ?selectedPreference WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?selection a rv:ContextSelection ;
          rv:consumer ${iri(basis.population.realm)} ; rv:selectionHead ${iri(semantic.selectionRevision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(semantic.selectionRevision)} rv:component ?selection ;
          rv:selectionState rv:Selected ; rv:context ${iri(semantic.context)} ;
          rv:semanticRevision ${iri(semantic.contextRevision)} .
          OPTIONAL { ${iri(semantic.selectionRevision)} rv:preferenceRevision ?selectedPreference } }
      } LIMIT 2`)).results?.bindings ?? [];
      return rows.length === 1 && (rows[0]?.selectedPreference?.value ?? null) === semantic.preferenceRevision;
    }
    // Public rankings have no Context selection owner in this profile.
    return false;
  } catch (error) {
    if (error instanceof ContextNotFound) return false;
    throw new RecommendationUnavailable('Context owner is unavailable');
  }
}
