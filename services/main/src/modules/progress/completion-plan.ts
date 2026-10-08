import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { canReadCompositionWork, compositionTargetReader } from '../composition/disclosure-read.ts';
import { ReadingBoundary } from '../reading-position/boundary.ts';
import { memberAnchoring } from '../reading-position/continuity.ts';
import { readCompositionHeader, CompositionUnavailable } from '../structure/graph.ts';
import { readCompositionPage } from '../structure/read.ts';
import { structureProfileFor } from '../structure/profiles.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMissing, workRead, type WorkReadSession } from '../work/read-session.ts';
import { configureProgressCompletion, ProgressCompletionProjector, type CompletionPlan,
  type CompletionPlanner } from './completion.ts';
import { readProgressOrder } from './order.ts';
import type { StructureProgressStore } from './store.ts';

/** The reader's own record of a target they can already see. Resolved as the
 * public: a target only a signed-in reader may open is not projected, which
 * keeps the record from being a probe of what the reader can reach. Resume
 * still discloses each saved row to the reader that asks. */
async function occurrencePlan(session: WorkReadSession, occurrence: string): Promise<CompletionPlan | null> {
  const env = session.deps.environment;
  const homes = await session.query(`SELECT ?structure WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(occurrence)} rv:structure ?structure } } LIMIT 2`, 2);
  const structure = homes.length === 1 ? homes[0]!.structure?.value : undefined;
  if (!structure) return null;
  const header = await readCompositionHeader(env, structure);
  if (!header) return null;
  const profile = structureProfileFor(header.profile);
  if (!profile.componentPredicate || !await canReadCompositionWork(session, header.work)) return null;
  let record;
  try {
    record = (await readCompositionPage(env, { structure, occurrence, limit: 1, header,
      canReadTarget: compositionTargetReader(session, profile) })).occurrences[0];
  } catch (error) {
    if (error instanceof CompositionUnavailable) return null;
    throw error;
  }
  if (!record || !profile.targetRoles.includes(record.role) || !record.target) return null;
  const order = await readProgressOrder(env, header, occurrence);
  if (!order) return null;
  return { structure, occurrence, order, anchoring: await memberAnchoring(env, header, order) };
}

export function graphCompletionPlanner(work: MainWorkDependencies): CompletionPlanner {
  const read = <T>(operation: (session: WorkReadSession) => Promise<T>) =>
    workRead(work, new Request('http://main.local/v1/internal/progress-completion'), {}, operation);
  return {
    occurrence: occurrence => read(session => occurrencePlan(session, occurrence)),
    lastOf: workId => read(async session => {
      let occurrence: string | null;
      try { occurrence = await new ReadingBoundary(session, 'all').position(workId); }
      catch (error) {
        if (error instanceof WorkReadMissing) return null;
        throw error;
      }
      return occurrence ? occurrencePlan(session, occurrence) : null;
    }),
  };
}

/** Turn on the finish projection for the Content pool this store writes to. */
export function configureGraphCompletion(progress: StructureProgressStore, work: MainWorkDependencies) {
  const pool = progress.owner;
  configureProgressCompletion(pool, new ProgressCompletionProjector(progress, pool, graphCompletionPlanner(work)));
}

const configured = new WeakSet<StructureProgressStore>();

/** Start the order projection and the finish projection once per owner. A
 * route calls this only after consent is verified, so a refused request
 * reaches no owner method; the server also calls it when it starts listening. */
export function configureProgressProjections(work: MainWorkDependencies) {
  const progress = work.progress;
  if (!progress || configured.has(progress)) return;
  configured.add(progress);
  progress.configureOrderProjection?.(work.environment);
  if (progress.owner) configureGraphCompletion(progress, work);
}
