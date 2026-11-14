import type { NativeProgressPresentation, NativeProgressSession } from '../../library/progress-reads';
import type { FakeRoute } from '../fake-modules';
import type { KernelRecording } from '../fake';

/** Constructed native responses for the mounted Progress interface, not API acceptance evidence. */
export type ProgressInterfaceScenario = 'units' | 'clear' | 'refresh' | 'unknown' | 'failure';
export const progressInterfaceSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000001901';
export const progressInterfaceSessionId = '0192f3a0-6c1e-7b2a-9d4e-000000001902';
const versionId = '0192f3a0-6c1e-7b2a-9d4e-000000001903';
const earlierSessionId = '0192f3a0-6c1e-7b2a-9d4e-000000001904';
export const progressInterfaceCursor = 'progress-review/earlier+window==';

function presentation(unitLabel: string, max: string): NativeProgressPresentation {
  return {
    meaning: 'known',
    unitLabel,
    unitLabelLanguage: 'en',
    structure: 'unverified',
    recording: { state: 'supported', inputRules: { min: '0', max, step: '1', total: 'optional' } },
  };
}

type NativeMeasure = {
  unit: string;
  amount: string | null;
  total: string | null;
  presentation: NativeProgressPresentation;
};
type Session = NativeProgressSession & { measures: NativeMeasure[] };
type ChangeIntent = { amount: string; measureId?: string } | { clear: true; measureId?: string };
type Change = { id: string; revision: number; createdAt: string; intent: ChangeIntent };
const chapter = presentation('chapters', '24');
const volume = presentation('volumes', '6');

function initialSession(scenario: ProgressInterfaceScenario): Session {
  const measures: NativeMeasure[] = [
    { unit: 'chapter', amount: '10', total: '24', presentation: chapter },
    { unit: 'volume', amount: '2', total: '6', presentation: volume },
  ];
  if (scenario === 'unknown') {
    measures.push({
      unit: 'historic-leaf-x',
      amount: '12.250001',
      total: null,
      presentation: { meaning: 'unknown', structure: 'unverified', recording: { state: 'unavailable' } },
    });
  }
  return {
    id: progressInterfaceSessionId,
    subjectId: progressInterfaceSubjectId,
    versionSubjectId: versionId,
    mode: 'scalar_amount',
    unit: 'chapter',
    amount: '10',
    total: '24',
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision: 3,
    startedAt: '2026-10-18T09:30:00.000Z',
    completedAt: null,
    subject: { id: progressInterfaceSubjectId, type: 'schema:Book', label: 'The Glass Observatory' },
    versionSubject: { id: versionId, type: 'schema:Book', label: 'English edition · revised 2025' },
    presentation: chapter,
    measures,
  };
}

type ScenarioState = {
  scenario: ProgressInterfaceScenario;
  session: Session;
  reads: number;
  responseLost: boolean;
  changes: Change[];
  replays: Map<string, { body: string; response: KernelRecording }>;
};
let state: ScenarioState | undefined;

export function setProgressInterfaceScenario(scenario?: ProgressInterfaceScenario): void {
  state =
    scenario === undefined
      ? undefined
      : {
          scenario,
          session: initialSession(scenario),
          reads: 0,
          responseLost: false,
          changes: [
            {
              id: `${progressInterfaceSessionId}:2`,
              revision: 2,
              createdAt: '2026-10-19T18:00:00.000Z',
              intent: { measureId: 'chapter', amount: '8' },
            },
          ],
          replays: new Map(),
        };
}

function earlierSession(current: Session): Session {
  return {
    ...current,
    id: earlierSessionId,
    state: 'completed',
    amount: '18',
    startedAt: '2026-08-01T09:30:00.000Z',
    completedAt: '2026-08-20T16:00:00.000Z',
    measures: current.measures.map((measure) => ({
      ...measure,
      amount: measure.unit === 'chapter' ? '18' : measure.amount,
    })),
  };
}

function savedResponse(session: Session): KernelRecording {
  return { status: 200, progressSession: structuredClone(session) };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/progressSessions',
    story: ({ request }) => {
      if (!state || new URL(request.url).searchParams.get('subjectId') !== progressInterfaceSubjectId) return;
      const cursor = new URL(request.url).searchParams.get('cursor');
      return {
        status: 200,
        progressSessions:
          cursor === progressInterfaceCursor ? [earlierSession(state.session)] : [structuredClone(state.session)],
        next: cursor === progressInterfaceCursor ? null : progressInterfaceCursor,
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)$/,
    story: ({ match }) => {
      if (!state) return;
      if (match?.[1] === earlierSessionId) return savedResponse(earlierSession(state.session));
      if (match?.[1] !== progressInterfaceSessionId) return;
      state.reads += 1;
      // The next explicit current read represents a save from another device. No timer or producer call runs.
      if (state.scenario === 'refresh' && state.reads === 2 && state.session.revision === 3) {
        state.session = {
          ...state.session,
          revision: 4,
          amount: '11',
          measures: state.session.measures.map((measure) => ({
            ...measure,
            amount: measure.unit === 'chapter' ? '11' : '3',
          })),
        };
      }
      return savedResponse(state.session);
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)\/changes$/,
    story: ({ match }) => {
      if (!state || (match?.[1] !== progressInterfaceSessionId && match?.[1] !== earlierSessionId)) return;
      return {
        status: 200,
        changes: match?.[1] === earlierSessionId ? [] : structuredClone(state.changes),
        next: null,
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/progressSessions\/([^/]+)\/completedUnits$/,
    story: ({ match }) => {
      if (!state || (match?.[1] !== progressInterfaceSessionId && match?.[1] !== earlierSessionId)) return;
      return { status: 200, completedUnits: [], next: null };
    },
  },
  {
    method: 'POST',
    path: `/v1/progressSessions/${progressInterfaceSessionId}:record`,
    story: async ({ request }) => {
      const current = state;
      if (!current) return;
      const body = await request.text();
      const replayKey = request.headers.get('idempotency-key')!;
      const replay = current.replays.get(replayKey);
      if (replay) {
        return replay.body === body ? structuredClone(replay.response) : { status: 409, code: 'idempotency_conflict' };
      }
      const data = JSON.parse(body) as { revision: number; measureId?: string; amount?: string; clear?: true };
      if (data.revision !== current.session.revision) return { status: 409, code: 'conflict' };
      const unit = data.measureId ?? current.session.unit;
      const amount = data.clear ? null : data.amount!;
      current.session = {
        ...current.session,
        revision: current.session.revision + 1,
        amount: unit === current.session.unit ? amount : current.session.amount,
        measures: current.session.measures.map((measure) => (measure.unit === unit ? { ...measure, amount } : measure)),
      };
      current.changes.unshift({
        id: `${current.session.id}:${current.session.revision}`,
        revision: current.session.revision,
        createdAt: '2026-11-14T09:30:00.000Z',
        intent: data.clear ? { measureId: unit, clear: true } : { measureId: unit, amount: amount! },
      });
      const response = savedResponse(current.session);
      current.replays.set(replayKey, { body, response });
      if (current.scenario === 'failure' && !current.responseLost) {
        current.responseLost = true;
        return { status: 503, code: 'unavailable' };
      }
      return response;
    },
  },
];
