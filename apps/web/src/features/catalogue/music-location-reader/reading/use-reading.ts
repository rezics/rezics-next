import { useEffect, useRef, useState } from 'react';
import type { MusicLocationAddress, MusicLocationRead, MusicLocationTransport } from '../model';
import { accept, previousAddress, streamStart, type Navigation, type Request } from './navigation';

type Failure = Extract<MusicLocationRead, { ok: false }>;
type State = {
  navigation: Navigation;
  requested?: Request | undefined;
  selected?: string | undefined;
  failure?: Failure | undefined;
  busy: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  restoredUnavailable: boolean;
};
const emptyNavigation = (): Navigation => ({ trail: [], evicted: false });

export function useMusicLocationReading(input: {
  snapshot: MusicLocationAddress;
  initial?: MusicLocationRead | undefined;
  restoreStream?: string | undefined;
  transport: MusicLocationTransport;
  current: () => boolean;
  refresh?: ((stream?: string) => Promise<void>) | undefined;
}) {
  const [state, setState] = useState<State>(() => {
    const request: Request = {
      address: { ...input.snapshot, ...(input.restoreStream ? { stream: input.restoreStream } : {}) },
      intent: 'open',
    };
    const navigation = input.initial?.ok ? accept(emptyNavigation(), request, input.initial) : emptyNavigation();
    return {
      navigation,
      selected: input.restoreStream ?? navigation.accepted?.page.stream?.key,
      requested: input.initial?.ok ? undefined : request,
      failure: input.initial && !input.initial.ok ? input.initial : undefined,
      busy: !input.initial,
      refreshing: false,
      refreshFailed: false,
      restoredUnavailable: false,
    };
  });
  const live = useRef(state);
  live.current = state;
  const mounted = useRef(false);
  const dispatching = useRef(false);
  const sequence = useRef(0);
  const update = (value: State) => {
    live.current = value;
    setState(value);
  };

  const read = async (request: Request) => {
    if (!mounted.current || !input.current() || dispatching.current || live.current.refreshing) return;
    dispatching.current = true;
    const turn = ++sequence.current;
    const before = live.current;
    const switching = request.intent === 'stream';
    update({
      ...before,
      navigation: switching ? { ...before.navigation, trail: [], evicted: false } : before.navigation,
      selected: request.address.stream ?? before.selected,
      requested: request,
      failure: undefined,
      busy: true,
      refreshFailed: false,
    });
    let result: MusicLocationRead;
    try {
      result = await input.transport(request.address);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !input.current() || sequence.current !== turn) return;
    dispatching.current = false;
    const pending = live.current;
    if (result.ok) {
      update({
        ...pending,
        navigation: accept(pending.navigation, request, result),
        selected: result.stream?.key,
        requested: undefined,
        failure: undefined,
        busy: false,
      });
    } else {
      update({
        ...pending,
        // Only an unavailable dependency permits the last admitted page to remain readable.
        navigation: result.reason === 'unavailable' ? pending.navigation : emptyNavigation(),
        failure: result,
        busy: false,
        restoredUnavailable: pending.restoredUnavailable || (result.reason === 'invalid' && !!input.restoreStream),
      });
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (!input.initial && live.current.requested) void read(live.current.requested);
    return () => {
      mounted.current = false;
      dispatching.current = false;
      sequence.current++;
      // Drop native sessions and addresses together. No visit cache can revive A after A/B/A.
      live.current = { ...live.current, navigation: emptyNavigation(), requested: undefined, selected: undefined };
    };
    // The shared Subject reading owner remounts on source/authority/locale retirement.
  }, []);

  const start = () => {
    const current = live.current;
    return read({
      address: streamStart(input.snapshot, current.selected, current.navigation.accepted),
      intent: 'start',
    });
  };
  const refresh = async () => {
    if (!input.refresh || !input.current() || dispatching.current || live.current.refreshing) return;
    const selected = live.current.selected;
    const turn = ++sequence.current;
    update({
      ...live.current,
      navigation: emptyNavigation(),
      requested: undefined,
      refreshing: true,
      refreshFailed: false,
    });
    try {
      await input.refresh(selected);
      if (mounted.current && input.current() && sequence.current === turn)
        update({ ...live.current, refreshing: false });
    } catch {
      if (mounted.current && input.current() && sequence.current === turn)
        update({ ...live.current, refreshing: false, refreshFailed: true });
    }
  };
  return {
    ...state,
    previous: previousAddress(state.navigation),
    select: (stream: string) => {
      const current = live.current;
      return read({ address: streamStart(input.snapshot, stream, current.navigation.accepted), intent: 'stream' });
    },
    more: () => {
      const { accepted } = live.current.navigation;
      if (!accepted?.page.next || !accepted.page.stream || live.current.failure) return;
      return read({
        address: {
          ...streamStart(input.snapshot, accepted.page.stream.key, accepted),
          cursor: accepted.page.next,
        },
        intent: 'more',
      });
    },
    back: () => {
      const address = previousAddress(live.current.navigation);
      if (address && !live.current.failure) return read({ address, intent: 'previous' });
    },
    start,
    retry: () => {
      const { requested, failure } = live.current;
      if (failure?.reason === 'unavailable' && requested) return read(requested);
    },
    choices: () => read({ address: input.snapshot, intent: 'open' }),
    refresh,
  };
}
