import { useEffect, useRef, useState } from 'react';
import { useEditorLifetime } from '../../catalogue/editor-lifetime';
import type { ProducerHistoryRead, ProducerHistoryStream } from '../../catalogue/producer-history';
import type { ProducerHistoryTransport } from '../producer-history';

type Admitted = Extract<ProducerHistoryRead, { ok: true }>;
type Failure = Extract<ProducerHistoryRead, { ok: false }>;

/** Navigation intent is private, bounded and never serialized into a URL or storage. */
export type HistoryIntent = Readonly<{
  producer: string;
  locale: string;
  stream: string | undefined;
  cursor: string | undefined;
  session: string | undefined;
  selection?: Readonly<{ index: number; holder: string; statement: string }>;
}>;
export type HistorySlice =
  | { phase: 'loading'; revision: number; intent: HistoryIntent; streams: ProducerHistoryStream[] }
  | { phase: 'ready'; revision: number; intent: HistoryIntent; read: Admitted }
  | { phase: 'failed'; revision: number; intent: HistoryIntent; failure: Failure };

/** One read owns installation. Equal arguments and A/B/A choices still have distinct leases. */
export function useProducerHistorySlice({
  id,
  locale,
  transport,
  initial,
}: {
  id: string;
  locale: string;
  transport: ProducerHistoryTransport;
  initial?: ProducerHistoryRead | undefined;
}) {
  const lifetime = useEditorLifetime();
  const first: HistoryIntent = { producer: id, locale, stream: undefined, cursor: undefined, session: undefined };
  const [slice, setSlice] = useState<HistorySlice>(() =>
    initial?.ok
      ? { phase: 'ready', revision: 0, intent: first, read: initial }
      : initial
        ? { phase: 'failed', revision: 0, intent: first, failure: initial }
        : { phase: 'loading', revision: 0, intent: first, streams: [] },
  );
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
    if (!lifetime.active() || intent.producer !== id || intent.locale !== locale) return;
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
      const result: HistorySlice = value.ok
        ? { phase: 'ready', revision, intent, read: value }
        : { phase: 'failed', revision, intent, failure: value };
      current.current = result;
      setSlice(result);
    } catch {
      if (!owned(revision)) return;
      const result: HistorySlice = { phase: 'failed', revision, intent, failure: { ok: false, reason: 'unavailable' } };
      current.current = result;
      setSlice(result);
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
  const session = read?.session ?? slice.intent.session;
  const intent = (stream = key, cursor?: string, selection?: HistoryIntent['selection']): HistoryIntent => ({
    producer: id,
    locale,
    stream,
    cursor,
    session,
    ...(selection ? { selection } : {}),
  });
  return {
    slice,
    read,
    streams,
    key,
    intent,
    request,
    owned,
    currentRevision: () => sequence.current,
    /** Restart is fresh native admission, never a rewind using a stale page token. */
    restart: (): HistoryIntent => ({
      producer: id,
      locale,
      stream: slice.phase === 'failed' && slice.failure.reason === 'invalid' ? undefined : key,
      cursor: undefined,
      session: undefined,
    }),
  };
}
