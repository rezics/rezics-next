import type { VerifiedPrincipal } from '../access/admission.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { DATASET, GRAPHS, RV, iri } from '../work/activate.ts';
import { WorkReadSession, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import { ReadingBoundary } from './boundary.ts';

/** Add position filtering after the transport's existing authentication and
 * disclosure gates. This helper neither admits a reader nor changes scopes.
 * Two constant-size graph checks bracket the owner's bounded read. */
export async function readingPositionRead<T>(deps: MainWorkDependencies, request: Request,
  principal: VerifiedPrincipal | null, actingSubject: string | undefined,
  operation: (boundary: ReadingBoundary) => Promise<T>): Promise<T> {
  const position = async () => {
    const rows = (await deps.environment.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.epoch || !rows[0].sequence) throw new WorkReadUnavailable('Reading position is unavailable');
    return { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value };
  };
  const start = await position();
  const session = new WorkReadSession(deps, request, { actingSubject }, start);
  session.principal = principal;
  const boundary = new ReadingBoundary(session);
  const result = await operation(boundary);
  await boundary.fence();
  const end = await position();
  if (start.dataEpoch !== end.dataEpoch || start.sequence !== end.sequence) throw new WorkReadMoved('Reading position changed during the read');
  return result;
}
