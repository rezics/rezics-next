import { useEffect, useRef, useState } from 'react';
import { addressLease } from '../../../../reader/lease';
import type { ArcAddress, ArcRead, ArcTransport } from '../model';

export type Ready = Extract<ArcRead, { ok: true }>;
type Failure = Extract<ArcRead, { ok: false }>;
type Intent = 'open' | 'more' | 'previous' | 'start' | 'stream' | 'discover';
type Request = { address: ArcAddress; intent: Intent };
type Admitted = { page: Ready; address: ArcAddress };
type State = {
  accepted?: Admitted;
  trail: ArcAddress[];
  evicted: boolean;
  pending?: Request;
  failure?: Failure;
  busy: boolean;
  version: number;
};
const normalized = (address: ArcAddress, page: Ready): ArcAddress => ({
  ...address,
  ...(page.stream ? { stream: page.stream.key } : {}),
});

/** Eight addresses, never eight page bodies. Every navigation uses the native transport again. */
export function useArcWindow(input: {
  base: ArcAddress;
  initial?: ArcRead | undefined;
  transport: ArcTransport;
  current: () => boolean;
  beforeReplace: () => void;
}) {
  const [state, setState] = useState<State>(() => ({
    ...(input.initial?.ok ? { accepted: { page: input.initial, address: normalized(input.base, input.initial) } } : {}),
    trail: [],
    evicted: false,
    busy: !input.initial,
    version: 0,
    ...(input.initial && !input.initial.ok ? { failure: input.initial } : {}),
    pending: { address: input.base, intent: 'open' },
  }));
  const live = useRef(state);
  live.current = state;
  const mounted = useRef(false);
  const dispatching = useRef(false);
  const sequence = useRef(0);
  const episode = useRef(addressLease(input.current));
  const update = (value: State) => {
    live.current = value;
    setState(value);
  };
  const replace = () => {
    episode.current.retire();
    episode.current = addressLease(input.current);
    input.beforeReplace();
  };
  const read = async (request: Request) => {
    if (!mounted.current || !input.current() || dispatching.current) return;
    dispatching.current = true;
    const turn = ++sequence.current;
    const before = live.current;
    // A stream choice immediately retires any selected member, even if discovery later fails.
    if (request.intent === 'stream' || request.intent === 'discover') replace();
    update({
      ...before,
      pending: request,
      failure: undefined,
      busy: true,
      ...(['stream', 'discover'].includes(request.intent) ? { trail: [], evicted: false } : {}),
    });
    let result: ArcRead;
    try {
      result = await input.transport({ ...request.address });
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !input.current() || turn !== sequence.current) return;
    dispatching.current = false;
    const prior = live.current;
    if (!result.ok) {
      if (result.reason !== 'unavailable') replace();
      update({
        ...prior,
        failure: result,
        busy: false,
        ...(result.reason !== 'unavailable' ? { accepted: undefined, trail: [], evicted: false } : {}),
      });
      return;
    }
    let trail = prior.trail;
    let evicted = prior.evicted;
    if (request.intent === 'more' && before.accepted) {
      trail = [...trail, before.accepted.address];
      if (trail.length > 8) {
        trail = trail.slice(-8);
        evicted = true;
      }
    } else if (request.intent === 'previous') trail = trail.slice(0, -1);
    else if (request.intent !== 'more') {
      trail = [];
      evicted = false;
    }
    replace();
    update({
      accepted: { page: result, address: normalized(request.address, result) },
      trail,
      evicted,
      busy: false,
      version: prior.version + 1,
    });
  };
  useEffect(() => {
    mounted.current = true;
    if (!input.initial) void read({ address: input.base, intent: 'open' });
    return () => {
      mounted.current = false;
      dispatching.current = false;
      sequence.current++;
      episode.current.retire();
    };
  }, []);
  const page = state.accepted?.page;
  return {
    ...state,
    page,
    episode: episode.current,
    previous: state.trail.at(-1),
    read,
    retry: () => {
      const request = live.current.pending;
      if (request && live.current.failure) return read(request);
    },
    start: () =>
      read({
        address: {
          ...input.base,
          ...(live.current.accepted?.page.stream ? { stream: live.current.accepted.page.stream.key } : {}),
        },
        intent: 'start',
      }),
    discover: () => read({ address: input.base, intent: 'discover' }),
    select: (stream: string) => read({ address: { ...input.base, stream }, intent: 'stream' }),
    more: () => {
      const accepted = live.current.accepted;
      if (accepted?.page.next && !live.current.failure)
        return read({ address: { ...accepted.address, cursor: accepted.page.next }, intent: 'more' });
    },
    back: () => {
      const address = live.current.trail.at(-1);
      if (address) return read({ address, intent: 'previous' });
    },
  };
}
