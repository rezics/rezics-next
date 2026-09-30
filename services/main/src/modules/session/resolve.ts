import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { InvalidSession, SESSION_COST, type SelectionInput, type SessionSelection } from './contract.ts';

/** Native hosted text and occurrences keep the existing Structure progress
 * owner. External selections use locator progress; descriptive media types
 * (Book, Video, etc.) never choose a second domain-specific store. */
export async function resolveSessionSelections(session: WorkReadSession,
  inputs: SelectionInput[]): Promise<SessionSelection[]> {
  if (!inputs.length || inputs.length > SESSION_COST.selections
    || new Set(inputs.map(input => input.target)).size !== inputs.length) {
    throw new InvalidSession('Request unique bounded session selections');
  }
  const targets = await resolveTargets(session, inputs.map(input => input.target), 'session');
  const rows = await session.query(`SELECT DISTINCT ?resource WHERE {
    VALUES ?resource { ${targets.map(target => iri(target.resource)).join(' ')} }
    { GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?resource } }
    UNION { GRAPH ${iri(GRAPHS.current)} { ?resource a rv:TextContribution } }
    UNION {
      GRAPH ${iri(GRAPHS.current)} {
        ?resource rv:mainVersion ?main . ?main rv:selectionHead ?selection .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:contribution ?contribution }
      GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution }
    }
  } LIMIT ${SESSION_COST.selections + 1}`, SESSION_COST.selections);
  const hosted = new Set(rows.map(row => row.resource!.value));
  return targets.map((target, index) => ({ target, language: inputs[index]!.language ?? null,
    format: inputs[index]!.format ?? null,
    progress: target.base === 'occurrence' || hosted.has(target.resource) ? 'structure' : 'locator' }));
}
