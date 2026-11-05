import {
  json,
  requestKey,
  unavailable,
  type NativeConformanceWorld,
  type NativeRequest,
} from './native-conformance.ts';

type Entry = { revision: number; incarnationId: string };
type Assignment = {
  id: string;
  labelId: string;
  subjectId: string;
  revision: number;
};
type Holding = { id: string; subjectId: string; revision: number };
type Session = Holding & { state: 'active' | 'completed' | 'abandoned' };

export type PrivateFactRemoval = {
  kind: 'entry' | 'label' | 'holding';
  subjectId: string;
  /** The original wire value, including the real CAS/Undo identity. */
  original: Entry | Assignment | Holding;
  request: NativeRequest;
  /** Unconsumed copy of the actual response, including deletion receipt headers. */
  response: Response;
};

/** Owner-only command binding. No private rows, derived membership or clocks are edited here. */
export function createNativePrivateFactsFixture(world: NativeConformanceWorld) {
  const removals: PrivateFactRemoval[] = [];
  const retainedSessions = new Map<string, readonly Session[]>();

  async function remove(
    kind: PrivateFactRemoval['kind'],
    subjectId: string,
    original: PrivateFactRemoval['original'],
    input: NativeRequest,
  ) {
    const request = { ...input, headers: { 'Idempotency-Key': requestKey() } };
    const response = await world.native.request('owner', request);
    removals.push({
      kind,
      subjectId,
      original,
      request,
      response: response.clone(),
    });
    return response;
  }

  /** Finish the original cursor walk before any mutation can change its pages. */
  async function page<T extends { subjectId: string }, K extends string>(
    path: string,
    field: K,
    subjectId: string,
  ): Promise<{ response: Response; values?: T[] }> {
    const values: T[] = [];
    let cursor: string | null = null;
    while (true) {
      const query = new URLSearchParams({ subjectId, limit: '100' });
      if (cursor !== null) query.set('cursor', cursor);
      const response = await world.native.request('owner', {
        method: 'GET',
        path: `${path}?${query}`,
      });
      if (response.status !== 200) return { response };
      const body = await json<{ next: string | null } & Record<K, T[]>>(response.clone());
      for (const value of body[field]) {
        if (value.subjectId !== subjectId) throw new Error('Native private-fact page escaped its subject');
        values.push(value);
      }
      cursor = body.next;
      if (cursor === null) return { response, values };
    }
  }

  async function clearEntryState(subjectId: string) {
    const response = await world.native.request('owner', {
      method: 'GET',
      path: `/v1/libraryEntries/${subjectId}`,
    });
    if (response.status !== 200) return response;
    const { libraryEntry } = await json<{ libraryEntry: Entry }>(response.clone());
    const query = new URLSearchParams({
      revision: String(libraryEntry.revision),
      incarnationId: libraryEntry.incarnationId,
    });
    return remove('entry', subjectId, libraryEntry, {
      method: 'DELETE',
      path: `/v1/libraryEntries/${subjectId}?${query}`,
    });
  }

  async function removeLabels(subjectId: string, labelId?: string) {
    const captured = await page<Assignment, 'assignments'>('/v1/libraryLabelAssignments', 'assignments', subjectId);
    let response = captured.response;
    if (!captured.values) return response;
    if (labelId !== undefined && !captured.values.some((value) => value.labelId === labelId))
      throw new Error('Native assignment is absent');
    for (const original of captured.values) {
      if (labelId !== undefined && original.labelId !== labelId) continue;
      response = await remove('label', subjectId, original, {
        method: 'POST',
        path: `/v1/libraryLabels/${original.labelId}:unassign`,
        body: {
          subjectId,
          assignmentId: original.id,
          revision: original.revision,
        },
      });
      if (!response.ok) return response;
    }
    return response;
  }

  async function removeHoldings(subjectId: string) {
    const captured = await page<Holding, 'copies'>('/v1/copies', 'copies', subjectId);
    let response = captured.response;
    if (!captured.values) return response;
    for (const original of captured.values) {
      response = await remove('holding', subjectId, original, {
        method: 'DELETE',
        path: `/v1/copies/${original.id}?revision=${original.revision}`,
      });
      if (!response.ok) return response;
    }
    return response;
  }

  async function removeSessions(subjectId: string) {
    const captured = await page<Session, 'progressSessions'>('/v1/progressSessions', 'progressSessions', subjectId);
    if (!captured.values) return captured.response;
    retainedSessions.set(subjectId, captured.values);
    if (captured.values.length)
      return unavailable(
        `owner-scoped progress-session deletion/retention command for ${subjectId}; retained originals: ` +
          captured.values.map((session) => `${session.id}@${session.revision} (${session.state})`).join(', '),
      );
    return captured.response;
  }

  async function removeAllPrivateFacts(subjectId: string): Promise<Response> {
    let last: Response | undefined;
    const entry = await clearEntryState(subjectId);
    if (entry.status !== 404) {
      if (!entry.ok) return entry;
      last = entry;
    }
    for (const operation of [removeLabels, removeHoldings]) {
      const before = removals.length;
      const response = await operation(subjectId);
      if (!response.ok) return response;
      if (removals.length > before) last = response;
    }
    // Abandonment still retains a fact, including completed history. Accounts owns terminal erasure;
    // no accepted subject-scoped session deletion/retention producer is installed in progress-routes.
    const sessions = await removeSessions(subjectId);
    if (!sessions.ok) return sessions;
    // Return the last actual mutation (or the real empty-session read), never an aggregate success.
    return last ?? sessions;
  }

  return {
    removals: removals as readonly PrivateFactRemoval[],
    retainedSessions: retainedSessions as ReadonlyMap<string, readonly Session[]>,
    clearEntryState,
    removeLabels,
    removeHoldings,
    removeSessions,
    removeAllPrivateFacts,
    replay: (removal: PrivateFactRemoval) => world.native.request('owner', removal.request),
  };
}
