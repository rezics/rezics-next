import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { ContextCommandUnavailable, commitCommand, runAdmittedCommand,
  type ContextCommandReceipt } from '../context/command.ts';
import { DATASET, GRAPHS, ID, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { targetRead } from '../target/resolve.ts';
import { WORK_READ_COST } from '../work/read-contract.ts';
import { WorkReadMoved } from '../work/read-session.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { PROJECTION_ACTION, PROJECTION_FAMILY, PROJECTION_PROFILE, PROJECTION_SCOPE, PROJECTION_WRITE_SCOPE,
  ProjectionUnavailable, projectionDigest, type ProjectionKey, type ProjectionView } from './schema.ts';
import { readProjectionViews } from './read.ts';
import type { ProjectionStore } from './store.ts';
import { resolveProjection } from './validate.ts';

/** A referenced Resource has a type in the current graph; a fixed release is retained in the revisions graph. */
const existsGuard = (resource: string) => `FILTER EXISTS {
  { GRAPH ${iri(GRAPHS.current)} { ${iri(resource)} a ?refType } }
  UNION { GRAPH ${iri(GRAPHS.revisions)} { ${iri(resource)} a <${RV}FixedRelease> } } }`;

/** The graph moves with every write anywhere, so a read that straddles one is repeated, with the same bounded
 * backoff as an ordinary read. Only reads are repeated: a command has its own receipt. */
async function stable<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (!(error instanceof WorkReadMoved) || attempt + 1 === WORK_READ_COST.attempts) throw error;
      const wait = Math.min(WORK_READ_COST.retryDelayMs * 2 ** attempt, WORK_READ_COST.maximumRetryDelayMs);
      // Jitter keeps concurrent callers from retrying in step behind the same write.
      await delay(wait + randomInt(0, wait));
    }
  }
}

/** Create the graph Resource of an already reserved identity, once. The guards prove the identity is unused and that the
 * subject and every frame still exist; a command whose guards fail wrote nothing, and its caller adopts the Resource
 * a concurrent creation committed. One guarded update: its work grows with the frame count, never with other Resources. */
async function createProjection(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  store: Pick<ProjectionStore, 'reserve'>, key: ProjectionKey, digest: string): Promise<ContextCommandReceipt | null> {
  const { projection } = await store.reserve({ ...key, admission: admission.id });
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await profileValidations(env.fuseki, 'projection-v1', [
    { shape: `${PROJECTION_PROFILE}/projection-shape`, focus: [projection], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${PROJECTION_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ], { projection, revision });
  const frames = key.frames.map(frame => `rv:frame ${iri(frame)}`).join(' ; ');
  return commitCommand(env, admission, { family: PROJECTION_FAMILY, digest, validations, operation,
    component: projection, revision, expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(projection)} a rv:Projection ;
        rv:projectionOf ${iri(key.subject)} ; ${frames} ; rv:projectionHead ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ProjectionRevision, rv:RevisionAnchor ;
        rv:component ${iri(projection)} ; rv:projectionOf ${iri(key.subject)} ; ${frames} ;
        rv:operation ${iri(operation)} ; rv:modelRevision ${iri(PROJECTION_PROFILE)} ;
        rv:shapeRevision ${iri(PROJECTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `${[key.subject, ...key.frames].map(existsGuard).join('\n')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(projection)} ?occupiedP ?occupiedO } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?revisionP ?revisionO } }` });
}

export interface ProjectionWrite {
  projection: ProjectionView;
  /** The graph Resource was created by this request's admission. */
  created: boolean;
  replayed: boolean;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** Get-or-create the one projection of a subject within frames. The reads validate and name the identity; if it is
 * already reserved and present, nothing is written. Otherwise one admission reserves the identity row (the first
 * concurrent caller's wins) and commits the graph Resource; a caller whose command found the Resource already created
 * by a concurrent one is sealed as a no-op and answers with that Resource, so every caller names one identity. */
export async function getOrCreateProjection(deps: MainWorkDependencies, request: Request,
  input: { subject: string; frames: readonly string[]; actingSubject: string; idempotencyKey: string }): Promise<ProjectionWrite> {
  const env = deps.environment;
  const store = deps.projections;
  if (!store) throw new ProjectionUnavailable('Projection owner is unavailable');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await deps.account.verify(request, [PROJECTION_WRITE_SCOPE]);
  const authority = { access: deps.access, principal, actingSubject: input.actingSubject,
    readers: { account: deps.account, governance: deps.governance, media: deps.media, mediaAccess: deps.mediaAccess,
      contextSelections: deps.contextSelections } };
  const key = await stable(() => targetRead(env, authority, session => resolveProjection(session, input)));
  const present = async (): Promise<ProjectionWrite | null> => {
    const id = await store.lookup(key.key);
    if (!id) return null;
    return stable(() => targetRead(env, authority, async session => {
      const [view] = await readProjectionViews(session, [id]);
      return view ? { projection: view, created: false, replayed: false, sourcePosition: { datasetId: 'product' as const,
        dataEpoch: session.position.dataEpoch, sequence: session.position.sequence } } : null;
    }));
  };
  // An existing projection is a read, unless this very request already reached admission: then it replays.
  if (!await store.admitted(principal, input.idempotencyKey)) {
    const existing = await present();
    if (existing) return existing;
  }
  const digest = projectionDigest(key, input.actingSubject);
  try {
    const receipt = await runAdmittedCommand(env, deps.account, deps.access, request, { family: PROJECTION_FAMILY,
      oauthScope: PROJECTION_WRITE_SCOPE, scope: PROJECTION_SCOPE, action: PROJECTION_ACTION,
      actingSubject: input.actingSubject, digest, input: key, idempotencyKey: input.idempotencyKey,
      execute: async admission => {
        const committed = await createProjection(env, admission, store, key, digest);
        if (!committed) throw new ContextCommandUnavailable('Projection exists or its subject or frames changed');
        return committed;
      } });
    const id = receipt.component!;
    return await stable(() => targetRead(env, authority, async session => {
      const [view] = await readProjectionViews(session, [id]);
      if (!view) throw new ProjectionUnavailable('Created projection is unavailable to its creator');
      return { projection: view, created: true, replayed: receipt.replayed,
        sourcePosition: { datasetId: 'product' as const, dataEpoch: receipt.dataEpoch, sequence: receipt.sequence } };
    }));
  } catch (error) {
    if (!(error instanceof ContextCommandUnavailable)) throw error;
    // A concurrent creation of the same key committed first: adopt its Resource.
    const adopted = await present();
    if (adopted) return adopted;
    throw new ProjectionUnavailable('Projection subject or frames changed during creation');
  }
}
