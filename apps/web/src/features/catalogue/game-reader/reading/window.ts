import { useEffect, useRef, useState } from 'react';
import type { GameReaderAddress, GameReaderRead, GameReaderReady, GameReaderTransport } from '../model';

type Intent = 'next' | 'previous' | 'start';
type Request = { address: GameReaderAddress; intent: Intent };

/** Only addresses survive a successful replacement; no former response or row is retained. */
export function useEditionWindow(input: {
  address: GameReaderAddress;
  initial?: GameReaderRead | undefined;
  transport: GameReaderTransport;
  current: () => boolean;
  replaced: () => void;
}) {
  const { address, initial, transport, current, replaced } = input;
  const [page, setPage] = useState<GameReaderReady | undefined>(initial?.ok ? initial : undefined);
  const [failure, setFailure] = useState<Exclude<GameReaderRead, GameReaderReady> | undefined>(
    initial && !initial.ok ? initial : undefined,
  );
  const [busy, setBusy] = useState(!initial);
  const [revision, setRevision] = useState(0);
  const [requested, setRequested] = useState<GameReaderAddress>(address);
  const mounted = useRef(false);
  const flight = useRef(false);
  const turn = useRef(0);
  const pending = useRef<Request>({ address, intent: 'start' });
  const accepted = useRef<GameReaderAddress | undefined>(initial?.ok ? address : undefined);
  const history = useRef<GameReaderAddress[]>([]);
  const cursors = useRef(new Set<string>());
  const successes = useRef(initial?.ok ? 1 : 0);

  const read = async (request: Request) => {
    if (!mounted.current || !current() || flight.current) return false;
    flight.current = true;
    const sequence = ++turn.current;
    pending.current = request;
    const { address: target, intent } = request;
    setRequested(target);
    // Even a failed revisit removes the old edition destinations. Work evidence may remain
    // within this live admission, but is never presented as a successful new window.
    replaced();
    setPage((previous) =>
      intent !== 'start' && previous
        ? { ...previous, editions: [], workReleaseCards: { state: 'unavailable' }, next: null }
        : undefined,
    );
    setFailure(undefined);
    if (
      intent !== 'start' &&
      (successes.current >= 64 || (intent === 'next' && target.cursor && cursors.current.has(target.cursor)))
    ) {
      flight.current = false;
      setBusy(false);
      setFailure({ ok: false, reason: 'restart' });
      return false;
    }
    setBusy(true);
    let result: GameReaderRead;
    try {
      result = await transport(target);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !current() || sequence !== turn.current) return false;
    flight.current = false;
    setBusy(false);
    if (
      result.ok &&
      result.public.subject.id === address.id &&
      result.public.subject.context === address.context &&
      result.public.subject.type === address.type
    ) {
      if (intent === 'start') {
        history.current = [];
        cursors.current.clear();
        successes.current = 0;
      } else if (intent === 'previous') {
        history.current.pop();
      } else if (accepted.current) {
        history.current = [...history.current, accepted.current].slice(-8);
      }
      successes.current++;
      if (target.cursor) cursors.current.add(target.cursor);
      accepted.current = target;
      setPage(result);
      setRevision((value) => value + 1);
      // Equal payloads also replace the observation of the selected row and spoiler gates.
      replaced();
    } else {
      if (result.ok || result.reason === 'withheld' || result.reason === 'invalid') {
        setPage(undefined);
        history.current = [];
        accepted.current = undefined;
        cursors.current.clear();
      }
      setFailure(result.ok ? { ok: false, reason: 'withheld' } : result);
    }
    return true;
  };
  useEffect(() => {
    mounted.current = true;
    if (!initial) void read({ address, intent: 'start' });
    return () => {
      mounted.current = false;
      flight.current = false;
      turn.current++;
      history.current = [];
      cursors.current.clear();
      accepted.current = undefined;
    };
  }, []);
  return {
    page,
    failure,
    busy,
    revision,
    requested,
    previous: history.current.at(-1),
    start: () => read({ address, intent: 'start' }),
    next: (cursor: string) => read({ address: { ...address, cursor }, intent: 'next' }),
    back: () => {
      const target = history.current.at(-1);
      return target ? read({ address: target, intent: 'previous' }) : Promise.resolve(false);
    },
    retry: () => read(pending.current),
  };
}
