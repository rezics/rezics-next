import type { ConnectionAddress, ConnectionGroup, ConnectionSelection, ConnectionVisit } from './subject-connections';

export const CONNECTION_HISTORY_LIMIT = 8;

export type ConnectionPageAddress = { cursor?: string; reading: string; page?: number };
export type ConnectionPageState = {
  stream: string;
  history: ConnectionPageAddress[];
  index: number;
  page?: number;
  failed?: { selection: ConnectionSelection; move: PageMove };
};
export type ConnectionWindowResume = {
  group: ConnectionGroup;
  stream: string;
  history: ConnectionPageAddress[];
  index: number;
};

export type ConnectionSnapshot = {
  visit?: Extract<ConnectionVisit, { ok: true }>;
  failure?: number;
  pending: ReadonlySet<string>;
  pages?: Partial<Record<ConnectionGroup, ConnectionPageState>>;
};
export type ConnectionRead = (address: ConnectionAddress, signal: AbortSignal) => Promise<ConnectionVisit>;
type PageMove = {
  kind: 'initial' | 'stream' | 'restart' | 'next' | 'previous' | 'direct';
  targetIndex?: number;
  targetPage?: number;
};
const digest = /^[a-f0-9]{64}$/;
const streamKey = /^(in|out):[^\s\u0000-\u001f\u007f]{1,256}$/u;

function validCursor(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= 32768 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validHistory(value: ConnectionWindowResume, selection?: ConnectionSelection): boolean {
  if (
    !streamKey.test(value.stream) ||
    value.history.length < 1 ||
    value.history.length > CONNECTION_HISTORY_LIMIT ||
    !Number.isInteger(value.index) ||
    value.index < 0 ||
    value.index >= value.history.length
  )
    return false;
  let priorPage: number | undefined;
  for (const address of value.history) {
    if (
      (address.cursor !== undefined && !validCursor(address.cursor)) ||
      !digest.test(address.reading) ||
      (address.page !== undefined &&
        (!Number.isSafeInteger(address.page) || address.page < 1 || (priorPage !== undefined && address.page !== priorPage + 1)))
    )
      return false;
    if (address.page !== undefined) priorPage = address.page;
  }
  const current = value.history[value.index]!;
  return (
    !selection ||
    (selection.stream === value.stream &&
      selection.cursor === current.cursor &&
      selection.reading === current.reading)
  );
}

/** One mounted visit, three independent bounded address histories, and one optional native neighbourhood. */
export function createConnectionWindow(
  address: ConnectionAddress,
  read: ConnectionRead,
  resume?: ConnectionWindowResume,
) {
  let snapshot: ConnectionSnapshot = { pending: new Set() };
  let retired = false;
  const listeners = new Set<() => void>();
  const requests = new Map<string, AbortController>();
  const selections: NonNullable<ConnectionAddress['selection']> = { ...address.selection };
  const pages: Partial<Record<ConnectionGroup, ConnectionPageState>> = {};
  const moves = new Map<string, PageMove>();
  const resumed = resume && validHistory(resume, address.selection?.[resume.group]) ? resume : undefined;
  if (resumed) {
    pages[resumed.group] = {
      stream: resumed.stream,
      history: resumed.history.map((entry) => ({ ...entry })),
      index: resumed.index,
      page: resumed.history[resumed.index]?.page,
    };
  }
  const currentSnapshot = (next: Omit<ConnectionSnapshot, 'pages'>): ConnectionSnapshot =>
    Object.keys(pages).length ? { ...next, pages: { ...pages } } : next;
  const publish = (next: Omit<ConnectionSnapshot, 'pages'>) => {
    snapshot = currentSnapshot(next);
    for (const listener of listeners) listener();
  };
  function clear() {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    moves.clear();
    for (const group of Object.keys(selections) as ConnectionGroup[]) delete selections[group];
    for (const group of Object.keys(pages) as ConnectionGroup[]) delete pages[group];
  }
  function classify(group: ConnectionGroup, selection: ConnectionSelection): PageMove {
    const prior = pages[group];
    if (!prior || prior.stream !== selection.stream) return { kind: 'stream' };
    if (!selection.cursor) return { kind: 'restart' };
    const existing = prior.history.findIndex((entry) => entry.cursor === selection.cursor);
    return existing >= 0 ? { kind: 'direct', targetIndex: existing } : { kind: 'direct' };
  }
  function failed(group: ConnectionGroup, selection: ConnectionSelection, move: PageMove) {
    const prior = pages[group];
    const history = prior?.stream === selection.stream ? prior.history : [];
    const index = prior?.stream === selection.stream ? prior.index : 0;
    const page = prior?.stream === selection.stream ? prior.page : move.targetPage;
    pages[group] = {
      stream: selection.stream,
      history: history.map((entry) => ({ ...entry })),
      index,
      ...(page !== undefined ? { page } : {}),
      failed: { selection, move },
    };
  }
  function completed(group: ConnectionGroup, current: NonNullable<Extract<ConnectionVisit, { ok: true }>['sections'][ConnectionGroup]>, move: PageMove) {
    if (!current.section.ok || !current.reading) return;
    const selection = selections[group] ?? { stream: current.stream.key };
    const prior = pages[group];
    const point = (page: number | undefined): ConnectionPageAddress => ({
      ...(current.section.ok && 'cursor' in current.section.read && current.section.read.cursor
        ? { cursor: current.section.read.cursor }
        : selection.cursor
          ? { cursor: selection.cursor }
          : {}),
      reading: current.reading!,
      ...(page !== undefined ? { page } : {}),
    });
    if (move.kind === 'stream' || move.kind === 'restart' || !prior || prior.stream !== current.stream.key) {
      pages[group] = { stream: current.stream.key, history: [point(1)], index: 0, page: 1 };
      return;
    }
    if (move.kind === 'initial') {
      if (prior.history[prior.index]) {
        const history = prior.history.map((entry) => ({ ...entry }));
        const targetPage = prior.history[prior.index]!.page ?? prior.page;
        history[prior.index] = point(targetPage);
        pages[group] = {
          stream: current.stream.key,
          history,
          index: prior.index,
          ...(targetPage !== undefined ? { page: targetPage } : {}),
        };
      } else pages[group] = { stream: current.stream.key, history: [point(1)], index: 0, page: 1 };
      return;
    }
    if (move.kind === 'previous' && move.targetIndex !== undefined && prior.history[move.targetIndex]) {
      const history = prior.history.map((entry) => ({ ...entry }));
      const targetPage = move.targetPage ?? history[move.targetIndex]!.page;
      history[move.targetIndex] = point(targetPage);
      pages[group] = {
        stream: current.stream.key,
        history,
        index: move.targetIndex,
        ...(targetPage !== undefined ? { page: targetPage } : {}),
      };
      return;
    }
    if (move.kind === 'next' && move.targetIndex !== undefined && prior.history[move.targetIndex]) {
      const history = prior.history.map((entry) => ({ ...entry }));
      const targetPage = move.targetPage ?? history[move.targetIndex]!.page;
      history[move.targetIndex] = point(targetPage);
      pages[group] = {
        stream: current.stream.key,
        history,
        index: move.targetIndex,
        ...(targetPage !== undefined ? { page: targetPage } : {}),
      };
      return;
    }
    if (move.kind === 'direct' && move.targetIndex !== undefined && prior.history[move.targetIndex]) {
      const history = prior.history.map((entry) => ({ ...entry }));
      const targetPage = move.targetPage ?? history[move.targetIndex]!.page;
      history[move.targetIndex] = point(targetPage);
      pages[group] = {
        stream: current.stream.key,
        history,
        index: move.targetIndex,
        ...(targetPage !== undefined ? { page: targetPage } : {}),
      };
      return;
    }
    const page = move.targetPage ?? (prior.page === undefined ? undefined : prior.page + 1);
    const history = prior.history.slice(0, prior.index + 1).map((entry) => ({ ...entry }));
    history.push(point(page));
    if (history.length > CONNECTION_HISTORY_LIMIT) history.shift();
    pages[group] = {
      stream: current.stream.key,
      history,
      index: history.length - 1,
      ...(page !== undefined ? { page } : {}),
    };
  }
  async function issue(
    group: ConnectionGroup | undefined,
    selection?: ConnectionSelection,
    graph?: ConnectionAddress['graph'],
    move?: PageMove,
  ) {
    const key = graph ? 'graph' : (group ?? 'initial');
    if (retired || requests.has(key) || requests.has('initial')) return;
    const navigation = group && selection ? (move ?? classify(group, selection)) : undefined;
    if (group && selection) {
      selections[group] = selection;
      if (navigation?.kind === 'stream' || navigation?.kind === 'restart')
        pages[group] = { stream: selection.stream, history: [], index: 0, page: 1 };
      if (navigation) moves.set(group, navigation);
    }
    const controller = new AbortController();
    requests.set(key, controller);
    const pending = new Set(snapshot.pending).add(key);
    const sections = { ...snapshot.visit?.sections };
    if (group) delete sections[group];
    const visit = snapshot.visit ? { ...snapshot.visit, sections } : undefined;
    if (graph && visit) delete visit.graph;
    publish({ ...(visit ? { visit } : {}), pending });
    const input = {
      ...address,
      ...(snapshot.visit ? { release: snapshot.visit.release } : {}),
      ...(group ? { only: group } : {}),
      selection: { ...selections },
      ...(graph ? { graph } : {}),
    };
    let result: ConnectionVisit;
    try {
      result = await read(input, controller.signal);
    } catch {
      result = { ok: false, status: 503 };
    }
    if (retired || controller.signal.aborted || requests.get(key) !== controller) return;
    requests.delete(key);
    const remaining = new Set(snapshot.pending);
    remaining.delete(key);
    if (!result.ok || result.id !== address.id) {
      clear();
      publish({ failure: result.ok ? 409 : result.status, pending: new Set() });
      return;
    }
    const prior = snapshot.visit;
    if (
      prior &&
      (prior.id !== result.id ||
        prior.release !== result.release ||
        JSON.stringify(prior.context) !== JSON.stringify(result.context))
    ) {
      clear();
      publish({ failure: 409, pending: new Set() });
      return;
    }
    if (group && selection) {
      const current = result.sections[group];
      const pageMove = moves.get(group) ?? navigation ?? { kind: 'direct' as const };
      moves.delete(group);
      if (current?.section.ok) completed(group, current, pageMove);
      else failed(group, selection, pageMove);
    } else if (!group && result.sections) {
      for (const [sectionGroup, current] of Object.entries(result.sections) as [ConnectionGroup, NonNullable<typeof result.sections[ConnectionGroup]>][]) {
        if (!current) continue;
        if (current.section.ok) completed(sectionGroup, current, { kind: 'initial' });
        else failed(
          sectionGroup,
          selections[sectionGroup] ?? { stream: current.stream.key },
          { kind: 'initial' },
        );
      }
    }
    for (const [sectionGroup, current] of Object.entries(result.sections)) {
      const sectionKey = sectionGroup as ConnectionGroup;
      if (!selections[sectionKey]) selections[sectionKey] = { stream: current.stream.key };
    }
    publish({
      visit: {
        ...result,
        sections: { ...prior?.sections, ...result.sections },
        ...(result.graph ? { graph: result.graph } : prior?.graph ? { graph: prior.graph } : {}),
      },
      pending: remaining,
    });
  }
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(group?: ConnectionGroup, selection?: ConnectionSelection, graph?: ConnectionAddress['graph']) {
      return issue(group, selection, graph);
    },
    next(group: ConnectionGroup) {
      const current = snapshot.visit?.sections[group];
      const state = pages[group];
      const cursor = current?.section.ok ? current.section.body.next : undefined;
      if (!current || !current.section.ok || !state || typeof cursor !== 'string' || !cursor) return Promise.resolve();
      const targetIndex = state.index + 1;
      const candidate = state.history[targetIndex];
      const retained = candidate?.cursor === cursor ? candidate : undefined;
      const targetPage = retained?.page ?? (state.page === undefined ? undefined : state.page + 1);
      return issue(
        group,
        {
          stream: current.stream.key,
          cursor,
          ...(retained?.reading ? { reading: retained.reading } : {}),
        },
        undefined,
        { kind: 'next', ...(retained ? { targetIndex } : {}), ...(targetPage !== undefined ? { targetPage } : {}) },
      );
    },
    previous(group: ConnectionGroup) {
      const state = pages[group];
      const targetIndex = state?.index !== undefined ? state.index - 1 : -1;
      const target = state?.history[targetIndex];
      if (!state || targetIndex < 0 || !target) return Promise.resolve();
      return issue(
        group,
        {
          stream: state.stream,
          ...(target.cursor ? { cursor: target.cursor } : {}),
          reading: target.reading,
        },
        undefined,
        { kind: 'previous', targetIndex, ...(target.page !== undefined ? { targetPage: target.page } : {}) },
      );
    },
    retry(group: ConnectionGroup) {
      const failed = pages[group]?.failed;
      return failed
        ? issue(group, failed.selection, undefined, failed.move)
        : issue(group, selections[group], undefined, { kind: 'direct' });
    },
    restartGroup(group: ConnectionGroup) {
      const stream = pages[group]?.stream ?? snapshot.visit?.sections[group]?.stream.key ?? selections[group]?.stream;
      return stream ? issue(group, { stream }, undefined, { kind: 'restart' }) : Promise.resolve();
    },
    activate() {
      retired = false;
    },
    restart() {
      clear();
      publish({ pending: new Set() });
      return issue(undefined);
    },
    retire(silent = false) {
      retired = true;
      clear();
      if (silent) snapshot = { pending: new Set() };
      else publish({ pending: new Set() });
    },
  };
}
