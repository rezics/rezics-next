import { useEffect, useRef, useState } from 'react';
import { useEditorLifetime } from '../../catalogue/editor-lifetime';
import type { ProducerHistoryRead, ProducerHistoryStream } from '../../catalogue/producer-history';
import type { RelationSlot } from '../../../subject/relation-candidates';
import type { ProducerHistoryTransport } from '../producer-history';

type Admitted = Extract<ProducerHistoryRead, { ok: true }>;
type Failure = Extract<ProducerHistoryRead, { ok: false }>;

/** Only native coordinates survive a window replacement; never row or editor state. */
export type HistoryCoordinate = Readonly<{
  stream: string | undefined;
  cursor: string | undefined;
  session: string | undefined;
}>;
type Movement = 'replace' | 'more' | 'previous' | 'first' | 'restart' | 'reload';
type HistoryPath = { previous: HistoryCoordinate[]; current?: HistoryCoordinate };

/** Navigation intent is private, bounded and never serialized into a URL or storage. */
export type HistoryIntent = HistoryCoordinate &
  Readonly<{
    movement: Movement;
    selection?: Readonly<{ index: number; holder: string; statement: string; slot?: RelationSlot }>;
  }>;
export type HistorySlice =
  | { phase: 'loading'; revision: number; intent: HistoryIntent; streams: ProducerHistoryStream[] }
  | { phase: 'ready'; revision: number; intent: HistoryIntent; read: Admitted }
  | { phase: 'failed'; revision: number; intent: HistoryIntent; failure: Failure };

/** One read owns installation. Equal arguments and A/B/A choices still have distinct leases. */
export function useProducerHistorySlice({
  transport,
  initial,
}: {
  id: string;
  locale: string;
  transport: ProducerHistoryTransport;
  initial?: ProducerHistoryRead | undefined;
}) {
  const lifetime = useEditorLifetime();
  const first: HistoryIntent = {
    stream: undefined,
    cursor: undefined,
    session: undefined,
    movement: 'replace',
  };
  const [slice, setSlice] = useState<HistorySlice>(() =>
    initial?.ok
      ? { phase: 'ready', revision: 0, intent: first, read: initial }
      : initial
        ? { phase: 'failed', revision: 0, intent: first, failure: initial }
        : { phase: 'loading', revision: 0, intent: first, streams: [] },
  );
  const path = useRef<HistoryPath>({
    previous: [],
    ...(initial?.ok ? { current: { stream: initial.stream?.key, cursor: undefined, session: initial.session } } : {}),
  });
  const sequence = useRef(0);
  const mounted = useRef(true);
  const current = useRef(slice);
  current.current = slice;
  const transportRef = useRef(transport);
  transportRef.current = transport;

  function owned(revision: number) {
    return mounted.current && lifetime.active() && sequence.current === revision;
  }
  async function request(intent: HistoryIntent) {
    if (!lifetime.active()) return;
    const revision = ++sequence.current;
    const before = current.current;
    const next: HistorySlice = {
      phase: 'loading',
      revision,
      intent,
      streams: before.phase === 'ready' ? before.read.streams : before.phase === 'loading' ? before.streams : [],
    };
    // Supersede synchronously, including two deliberate choices in one React batch.
    current.current = next;
    setSlice(next);
    try {
      const value = await transportRef.current.read(intent.stream, intent.cursor, intent.session);
      if (!owned(revision)) return;
      if (value.ok) {
        const history = path.current;
        const coordinate = {
          stream: value.stream?.key,
          cursor: intent.cursor,
          // A cursor keeps the context which admitted it. The returned token belongs to next.
          session: intent.session ?? value.session,
        };
        if (history.current?.stream !== coordinate.stream || ['replace', 'first', 'restart'].includes(intent.movement))
          history.previous = [];
        else if (intent.movement === 'more' && history.current)
          history.previous = [...history.previous, history.current].slice(-8);
        else if (intent.movement === 'previous') history.previous = history.previous.slice(0, -1);
        history.current = coordinate;
      } else if (value.reason !== 'unavailable') path.current = { previous: [] };
      const result: HistorySlice = value.ok
        ? { phase: 'ready', revision, intent, read: value }
        : { phase: 'failed', revision, intent, failure: value };
      current.current = result;
      setSlice(result);
    } catch (error) {
      // The existing transport fence rejects an obsolete read after reader retirement.
      if (owned(revision)) throw error;
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (!initial) void request(first);
    return () => {
      mounted.current = false;
      sequence.current++;
    };
    // The catalogue host remounts this hook on producer, locale or account retirement.
  }, []);

  const read = slice.phase === 'ready' ? slice.read : undefined;
  const streams = read?.streams ?? (slice.phase === 'loading' ? slice.streams : []);
  const key = read?.stream?.key ?? slice.intent.stream;
  const intent = (
    coordinate: HistoryCoordinate,
    movement: Movement,
    selection?: HistoryIntent['selection'],
  ): HistoryIntent => ({
    ...coordinate,
    movement,
    ...(selection ? { selection } : {}),
  });
  const beginning = (movement: 'first' | 'restart') =>
    intent(
      {
        stream: slice.phase === 'failed' && slice.failure.reason === 'invalid' ? undefined : key,
        cursor: undefined,
        session: undefined,
      },
      movement,
    );
  return {
    slice,
    read,
    streams,
    key,
    request,
    owned,
    currentRevision: () => sequence.current,
    admitted: (revision: number) => current.current.phase === 'ready' && current.current.revision === revision,
    previous: path.current.previous.length ? () => intent(path.current.previous.at(-1)!, 'previous') : undefined,
    more: () =>
      intent(
        { stream: key, cursor: read?.next ?? undefined, session: read?.session ?? path.current.current?.session },
        'more',
      ),
    reload: (selection?: HistoryIntent['selection']) => intent(path.current.current!, 'reload', selection),
    replace: (stream: string) =>
      intent({ stream, cursor: undefined, session: read?.session ?? slice.intent.session }, 'replace'),
    first: () => beginning('first'),
    /** Restart is fresh native admission, never a rewind using a stale page token. */
    restart: () => beginning('restart'),
  };
}
