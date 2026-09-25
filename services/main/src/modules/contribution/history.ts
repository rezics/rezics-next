import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState, RevisionCorrupt, RevisionNotFound } from '../work/history.ts';
import { CONTRIBUTION_PROFILE } from './draft.ts';

export interface ExactContributionDraft {
  contribution: string;
  revision: string;
  work: string;
  author: string;
  language: string;
  body: string;
  predecessor?: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** Exact immutable draft read, gated by current private Contribution authority. */
export async function readExactContributionDraft(
  env: WorkActivationEnvironment, contribution: string, revision: string,
  canRead: (contribution: string) => Promise<boolean>,
): Promise<ExactContributionDraft> {
  if (!await canRead(contribution)) {
    throw new RevisionNotFound('draft revision is unavailable');
  }
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?component ?manifest ?model ?shape ?dataset ?epoch ?sequence ?predecessor WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ?component ;
          rv:manifest ?manifest ; rv:modelRevision ?model ; rv:shapeRevision ?shape ;
          rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) throw new RevisionNotFound('draft revision is unavailable');
  if (rows.length !== 1) throw new RevisionCorrupt('draft revision anchor is ambiguous');
  const row = rows[0]!;
  if (row.component?.value !== contribution) {
    throw new RevisionNotFound('draft revision is unavailable');
  }
  if (row.model?.value !== CONTRIBUTION_PROFILE || row.shape?.value !== CONTRIBUTION_PROFILE
    || row.dataset?.value !== DATASET || !row.epoch?.value
    || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new RevisionCorrupt('draft revision anchor is incomplete');
  }
  const state = readComponentState(env.objectDirectory, row.manifest?.value ?? '',
    contribution, CONTRIBUTION_PROFILE);
  if (typeof state.work !== 'string' || typeof state.author !== 'string'
    || typeof state.language !== 'string' || typeof state.body !== 'string'
    || state.publication !== 'draft') {
    throw new RevisionCorrupt('draft payload does not match Contribution profile');
  }
  const identity = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(state.work)} ;
        rv:author ${iri(state.author)} ; rv:language ${lit(state.language)} .
    }
  }`);
  if (identity.boolean !== true) throw new RevisionCorrupt('draft payload differs from Contribution identity');
  return { contribution, revision, work: state.work, author: state.author,
    language: state.language, body: state.body,
    ...(row.predecessor ? { predecessor: row.predecessor.value } : {}),
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value,
      sequence: row.sequence.value } };
}
