import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { ContextCommandUnavailable, InvalidContextCommand } from '../context/command.ts';
import { STATEMENT_LIMITS } from './schema.ts';

export class StatementProjectionRefused extends InvalidContextCommand {
  readonly code = 'statement_applicability_too_large';
  constructor() { super('The subject projection and Statement applicability together exceed eight coordinates'); }
}

export function projectionStatementMeaning(subject: string, frames: readonly string[], applicability: readonly string[]) {
  const union = [...new Set([...frames, ...applicability])].sort();
  if (union.length > STATEMENT_LIMITS.applicability) throw new StatementProjectionRefused();
  return { subject, applicability: union };
}

export const STATEMENT_PROJECTION_COST = { subjectQueries: 1, partRows: 9, projectionSummaryReads: 1 } as const;

/** The request digest retains the supplied subject; only the stored meaning is normalized.
 * Projection parts are immutable, so admission retries always resolve to the same meaning. */
export async function normalizeStatementSubject(env: WorkActivationEnvironment,
  input: { subject: string; applicability: string[] }, canReadProjection?: (projection: string) => Promise<boolean>) {
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?subject ?frame WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.subject)} a rv:Projection .
      OPTIONAL { ${iri(input.subject)} rv:projectionOf ?subject }
      OPTIONAL { ${iri(input.subject)} rv:frame ?frame }
    } } LIMIT ${STATEMENT_PROJECTION_COST.partRows}`)).results?.bindings ?? [];
  if (!rows.length) return input;
  // Unlike a direct subject reference, normalization reveals parts the caller
  // may never have seen. The public writer must be able to read the projection.
  if (canReadProjection && !await canReadProjection(input.subject)) {
    throw new ContextCommandUnavailable('Statement projection is unavailable');
  }
  if (rows.length > 8 || rows.some(row => !row.subject || !row.frame)
    || new Set(rows.map(row => row.subject!.value)).size !== 1) {
    throw new ContextCommandUnavailable('Statement projection parts are unavailable');
  }
  return projectionStatementMeaning(rows[0]!.subject!.value, rows.map(row => row.frame!.value), input.applicability);
}
