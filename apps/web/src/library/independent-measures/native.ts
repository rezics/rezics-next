import type { KernelClient } from '@rezics/client';
import {
  nativeProgressPresentation,
  supportedProgressState,
  nativeProgressPresentationQuery,
  type NativeProgressSession,
  type ProgressRecorded,
  type ProgressRecordInput,
  type ProgressFailure,
} from '../progress-reads';
import { libraryFullQuery } from '../reads';
import {
  INDEPENDENT_MEASURE_CREATE_SEAM,
  INDEPENDENT_MEASURE_READ_SEAM,
  INDEPENDENT_MEASURE_SEAM,
  type IndependentMeasure,
} from './contract';

type RecordResource = {
  $record?: { post?: unknown };
  get?: unknown;
};

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

/** Installed typed methods; a missing producer stays unavailable at this seam. */
export function independentMeasureMethods(client: KernelClient): {
  record: boolean;
  read: boolean;
  create: boolean;
  seam: string;
} {
  const create = isFunction(client.progressSessions?.post);
  let record = false;
  let read = false;
  try {
    const resource = client.progressSessions({ sessionId: '00000000-0000-7000-8000-000000000000' }) as RecordResource;
    record = isFunction(resource.$record?.post);
    read = isFunction(resource.get);
  } catch {
    record = false;
    read = false;
  }
  const seam = !record
    ? INDEPENDENT_MEASURE_SEAM
    : !read
      ? INDEPENDENT_MEASURE_READ_SEAM
      : INDEPENDENT_MEASURE_CREATE_SEAM;
  return { record, read, create, seam: record && read ? INDEPENDENT_MEASURE_SEAM : seam };
}

export function independentCommandsAvailable(client: KernelClient): boolean {
  const methods = independentMeasureMethods(client);
  return methods.record && methods.read;
}

export async function readNativeIndependentSession(
  client: KernelClient,
  sessionId: string,
  authorization: string,
): Promise<NativeProgressSession> {
  const result = await client.progressSessions({ sessionId }).get({
    query: { ...libraryFullQuery(), ...nativeProgressPresentationQuery() },
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  const session = result.data?.progressSession;
  if (!session) {
    const error = result.error as { status?: number; value?: unknown } | undefined;
    throw Object.assign(new Error('Independent measure session unavailable'), {
      status: result.status ?? error?.status ?? 0,
      body: error?.value ?? result.error,
    });
  }
  return session;
}

function recordingFromPresentation(
  presentation:
    | NonNullable<NativeProgressSession['measures']>[number]['presentation']
    | ReturnType<typeof nativeProgressPresentation>,
): IndependentMeasure['recording'] {
  if (!presentation) return 'unavailable';
  if (presentation.meaning === 'unknown' || presentation.meaning === 'unavailable') return 'historical';
  if (presentation.recording.state === 'supported') return 'supported';
  if (presentation.recording.state === 'unsupported') return 'unsupported';
  return 'unavailable';
}

function independentFromNativeMeasure(
  measure: NonNullable<NativeProgressSession['measures']>[number],
  primary: boolean,
): IndependentMeasure {
  const presentation = measure.presentation;
  const recording = recordingFromPresentation(presentation);
  return {
    unit: measure.unit,
    primary,
    label: presentation?.meaning === 'known' ? presentation.unitLabel || measure.unit : measure.unit,
    total: measure.total,
    meaning: presentation?.meaning ?? 'unavailable',
    recording,
    ...(presentation?.recording.state === 'supported' ? { inputRules: presentation.recording.inputRules } : {}),
    amount: measure.amount,
    kind:
      measure.amount === null
        ? 'absent'
        : measure.amount === '0' || /^0(?:\.0+)?$/.test(measure.amount)
          ? 'zero'
          : 'recorded',
  };
}

export function measuresFromNative(session: NativeProgressSession): IndependentMeasure[] {
  const nativeMeasures = session.measures;
  if (session.mode === 'scalar_amount' && nativeMeasures && nativeMeasures.length > 0) {
    const primary = nativeMeasures.find((measure) => measure.unit === session.unit) ?? nativeMeasures[0]!;
    const additional = nativeMeasures
      .filter((measure) => measure.unit !== primary.unit)
      .slice()
      .sort((left, right) => (left.unit < right.unit ? -1 : left.unit > right.unit ? 1 : 0));
    return [
      independentFromNativeMeasure(primary, true),
      ...additional.map((measure) => independentFromNativeMeasure(measure, false)),
    ];
  }
  if (session.mode !== 'scalar_amount') return [];
  const presentation = nativeProgressPresentation(session);
  return [
    {
      unit: session.unit,
      primary: true,
      label: presentation?.unitLabel || session.unit,
      total: session.total,
      meaning: presentation?.meaning ?? 'unavailable',
      recording: recordingFromPresentation(presentation),
      ...(presentation?.recording.state === 'supported' ? { inputRules: presentation.recording.inputRules } : {}),
      amount: session.amount,
      kind:
        session.amount === null
          ? 'absent'
          : session.amount === '0' || /^0(?:\.0+)?$/.test(session.amount)
            ? 'zero'
            : 'recorded',
    },
  ];
}

export function recordBodyFromOperands(operands: ProgressRecordInput): {
  revision: number;
  measureId?: string;
  amount?: string;
  clear?: true;
} {
  return {
    revision: operands.revision,
    ...(operands.measureId === undefined ? {} : { measureId: operands.measureId }),
    ...(operands.clear === true ? { clear: true as const } : {}),
    ...(operands.amount === undefined ? {} : { amount: operands.amount }),
  };
}

export function snapshotFromNative(session: NativeProgressSession): ProgressRecorded['session'] {
  const measures = session.measures?.map((measure) => ({
    unit: measure.unit,
    amount: measure.amount,
    total: measure.total,
  }));
  return {
    id: session.id,
    revision: session.revision,
    amount: session.amount,
    locator: session.locator,
    position: session.position,
    completedUnitCount: session.completedUnitCount,
    state: supportedProgressState(session.state),
    completedAt: session.completedAt,
    total: session.total,
    ...(measures?.length ? { measures } : {}),
  };
}

export function nativeFailure(status: number, body: unknown): ProgressFailure {
  if (status === 409) return { ok: false, reason: 'conflict' };
  if (
    status === 422 &&
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    (body as { code?: unknown }).code === 'unsupported_library_profile'
  )
    return { ok: false, reason: 'unsupported_library_profile' };
  if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
  if (status === 401 || status === 403 || status === 404) return { ok: false, reason: 'forbidden' };
  return { ok: false, reason: 'unavailable' };
}
