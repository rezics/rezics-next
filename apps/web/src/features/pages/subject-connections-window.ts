import type { ConnectionAddress, ConnectionGroup, ConnectionSelection, ConnectionVisit } from './subject-connections';

export type ConnectionSnapshot = {
  visit?: Extract<ConnectionVisit, { ok: true }>;
  failure?: number;
  pending: ReadonlySet<string>;
};
export type ConnectionRead = (address: ConnectionAddress, signal: AbortSignal) => Promise<ConnectionVisit>;

/** One mounted visit, three independent finite pages, and one optional native neighbourhood. No query cache. */
export function createConnectionWindow(address: ConnectionAddress, read: ConnectionRead) {
  let snapshot: ConnectionSnapshot = { pending: new Set() };
  let retired = false;
  const listeners = new Set<() => void>();
  const requests = new Map<string, AbortController>();
  const selections: NonNullable<ConnectionAddress['selection']> = {};
  const publish = (next: ConnectionSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  function clear() {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
    for (const group of Object.keys(selections) as ConnectionGroup[]) delete selections[group];
  }
  async function load(group?: ConnectionGroup, selection?: ConnectionSelection, graph?: ConnectionAddress['graph']) {
    const key = graph ? 'graph' : (group ?? 'initial');
    if (retired || requests.has(key) || requests.has('initial')) return;
    if (group && selection) selections[group] = selection;
    const controller = new AbortController();
    requests.set(key, controller);
    const pending = new Set(snapshot.pending).add(key);
    // Replacing a selection removes that section's old private rows before issuing its read.
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
      // A refused current identity/reading removes all pages and fences sibling results, including graph reads.
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
    load,
    activate() {
      retired = false;
    },
    restart() {
      clear();
      publish({ pending: new Set() });
      return load();
    },
    retire(silent = false) {
      retired = true;
      clear();
      if (silent) snapshot = { pending: new Set() };
      else publish({ pending: new Set() });
    },
  };
}
