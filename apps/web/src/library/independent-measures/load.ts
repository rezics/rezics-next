import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { loadProgressSession, type ProgressSessionPage, type ProgressSessionView } from '../progress-reads';
import {
  draftsFrom,
  INDEPENDENT_MEASURE_SEAM,
  projectIndependentMeasures,
  sessionHasIndependentMeasures,
  type IndependentMeasure,
  type IndependentVisit,
} from './contract';
import { emptyIndependentWork, finishIndependentWork, observeIndependentWork, type IndependentWork } from './cost';
import { independentCommandsAvailable, measuresFromNative, readNativeIndependentSession } from './native';

export type IndependentLoad =
  | { state: 'signed-out'; work: IndependentWork }
  | { state: 'denied'; work: IndependentWork }
  | { state: 'unavailable'; work: IndependentWork; closed?: boolean; seam: string }
  | { state: 'empty'; work: IndependentWork; sessionId: string; revision: number }
  | {
      state: 'ready';
      work: IndependentWork;
      sessionId: string;
      revision: number;
      measures: IndependentMeasure[];
      page?: Extract<ProgressSessionPage, { signedIn: true }>;
    };

async function bearer(request: Request, env: Partial<SessionEnv>): Promise<string | null> {
  if (await prepareSession(request, env)) return null;
  return viewerCredential(request);
}

/** One session GET with FULL presentation. Owner history N is never listed. */
export async function loadIndependentMeasureVisit(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  sessionId: string,
): Promise<IndependentLoad> {
  const calls: string[] = [];
  const observed = observeIndependentWork(client, (name) => calls.push(name));
  const work = () => emptyIndependentWork();
  if (!independentCommandsAvailable(client)) {
    return { state: 'unavailable', work: work(), seam: INDEPENDENT_MEASURE_SEAM };
  }
  const authorization = await bearer(request, env);
  if (!authorization) return { state: 'signed-out', work: work() };
  try {
    const session = await readNativeIndependentSession(observed, sessionId, authorization);
    if (calls.length === 0) calls.push('progressSessions.get');
    const measures = measuresFromNative(session).slice();
    const retained = {
      id: session.id,
      revision: session.revision,
      measures: measures.map((measure) => ({
        unit: measure.unit,
        amount: measure.amount,
        total: measure.total,
        meaning: measure.meaning,
        recording: measure.recording,
      })),
    };
    const finished = finishIndependentWork(calls, measures, retained);
    if (measures.length <= 1) {
      return { state: 'empty', work: finished, sessionId: session.id, revision: session.revision };
    }
    return {
      state: 'ready',
      work: finished,
      sessionId: session.id,
      revision: session.revision,
      measures,
    };
  } catch (error) {
    if (isPlatformClosedError(error)) {
      return {
        state: 'unavailable',
        work: finishIndependentWork(calls, [], null),
        closed: true,
        seam: INDEPENDENT_MEASURE_SEAM,
      };
    }
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    if (status === 401 || status === 403 || status === 404) {
      return { state: 'denied', work: finishIndependentWork(calls, [], null) };
    }
    return { state: 'unavailable', work: finishIndependentWork(calls, [], null), seam: INDEPENDENT_MEASURE_SEAM };
  }
}

/** Project independent measures from an already loaded session page; adds no native list of history N. */
export function visitFromSessionPage(
  page: ProgressSessionPage,
): IndependentVisit | { kind: 'denied' } | { kind: 'empty' } {
  if (!page.signedIn) return { kind: 'denied' };
  const measures = projectIndependentMeasures(page.session);
  if (!sessionHasIndependentMeasures(page.session) || measures.length <= 1) {
    return { kind: 'empty' };
  }
  return {
    kind: 'ready',
    sessionId: page.session.id,
    revision: page.session.revision,
    measures,
    drafts: draftsFrom(measures),
    edits: [],
    outcome: null,
    retry: null,
  };
}

export async function loadIndependentSessionPage(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: { id: string; changes?: string; units?: string },
): Promise<ProgressSessionPage> {
  return loadProgressSession(client, request, env, input);
}

export function independentMeasuresOf(session: ProgressSessionView): IndependentMeasure[] {
  return projectIndependentMeasures(session);
}
