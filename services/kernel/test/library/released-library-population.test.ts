import { expect, test } from 'bun:test';
import type { HttpResponse, Subject } from '../../../../specs/semantic-driver.ts';
import { discoveryKey, type DiscoveryPersona } from '../support/released-discovery.ts';
import {
  createReleasedLibraryPopulation,
  type ReleasedLibraryPopulation,
  type SessionHandle,
  type CopyHandle,
  type OccurrenceHandle,
} from './support/released-library-population.ts';

function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify({ status: response.status, body: response.body })).toBe(expected);
  return response;
}
function problem(response: HttpResponse, expected: number, code: string) {
  status(response, expected);
  expect(response.body.code).toBe(code);
}
async function population(run: (fixture: ReleasedLibraryPopulation) => Promise<void>) {
  const fixture = await createReleasedLibraryPopulation({ version: 1 });
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}
function native(title: string, run: (fixture: ReleasedLibraryPopulation) => Promise<void>) {
  test(title, () => population(run), 120_000);
}
async function page<T>(f: ReleasedLibraryPopulation, path: string, field: string, persona: DiscoveryPersona = 'alice') {
  const response = status(await f.request(persona, 'GET', path), 200);
  expect(Array.isArray(response.body[field]), JSON.stringify(response.body)).toBe(true);
  expect(response.body.next).toBeNull();
  return response.body[field] as T[];
}
async function noEntry(f: ReleasedLibraryPopulation, subjectId: string, persona: DiscoveryPersona = 'alice') {
  problem(await f.request(persona, 'GET', `/v1/libraryEntries/${subjectId}`), 404, 'not_found');
}
async function noCopies(f: ReleasedLibraryPopulation, subjectId: string) {
  expect(await page(f, `/v1/copies?subjectId=${subjectId}&limit=100`, 'copies')).toEqual([]);
}
async function noSessions(f: ReleasedLibraryPopulation, subjectId: string) {
  expect(await page(f, `/v1/progressSessions?subjectId=${subjectId}&limit=100`, 'progressSessions')).toEqual([]);
}
async function everything(f: ReleasedLibraryPopulation) {
  const rows = await page<{ id: string; membershipKind: string; builtinKind?: string }>(
    f,
    `/v1/collections?curatorAccountId=${f.base.personas.alice.accountId}&limit=100`,
    'collections',
  );
  const found = rows.filter((row) => row.membershipKind === 'dynamic' && row.builtinKind === 'everything');
  expect(found, JSON.stringify(rows)).toHaveLength(1);
  // The ID is discovered from the native owner response; no fixture-derived ID or fake Collection port.
  return found[0]!;
}
async function members(f: ReleasedLibraryPopulation, collectionId: string) {
  return page<{ kind: string; subjectId: string }>(f, `/v1/collections/${collectionId}/members?limit=100`, 'members');
}

native(
  'released native Library population is created only through actual owner APIs and discriminates state-only label-only retained-session holding shell follow-only and other-owner support without a synthetic released model',
  async (f) => {
    expect(f.version).toBe(1);
    const active = status(await f.request('anonymous', 'GET', '/v1/definitions/active'), 200);
    expect(active.body.digest).toBe(f.base.release.digest);
    // This assertion requires actual released metadata, before a profiled owner write can be made legally.
    const own = await f.state();
    expect(own.response.status).toBe(201);
    status(await f.request('alice', 'GET', `/v1/libraryEntries/${own.subject.id}`), 200);
    expect(f.calls.some((call) => call.method === 'PUT' && call.response === own.response)).toBe(true);
  },
);

native(
  'Released personal supports are independent: own native state does not invent a label session holding or payment',
  async (f) => {
    const entitlements = await page(f, '/v1/entitlements?limit=100', 'entitlements');
    const own = await f.state();
    const read = status(await f.request('alice', 'GET', `/v1/libraryEntries/${own.subject.id}`), 200);
    expect(read.body.libraryEntry).toEqual(own.entry);
    expect(own.entry.state).toBe(
      own.accepted.profile.entryStateSet!.states.find((choice) => choice.role === 'active')!.id,
    );
    expect(await page(f, `/v1/libraryLabelAssignments?subjectId=${own.subject.id}`, 'assignments')).toEqual([]);
    await noCopies(f, own.subject.id);
    await noSessions(f, own.subject.id);
    expect(await page(f, '/v1/entitlements?limit=100', 'entitlements')).toEqual(entitlements);
    // No payment or entitlement command participates in setup. Native commerce outcome suites own payment effects.
    expect(
      f.calls.every((call) => call.method === 'GET' || !/checkout|orders|entitlements|payments/.test(call.path)),
    ).toBe(true);
  },
);

native(
  'Released label-only B-long and a private vegetarian label preserve no-entry support and public Recipe classification',
  async (f) => {
    const group = await f.labels();
    const labels = await page<{ id: string; name: string; revision: number }>(
      f,
      '/v1/libraryLabels?limit=100',
      'labels',
    );
    expect(labels).toContainEqual({ ...group.label, name: 'vegetarian' });
    const rows = await page(f, `/v1/libraryLabelAssignments?subjectId=${group.subject.id}`, 'assignments');
    expect(rows).toEqual([{ ...group.assignment.assignment, labelId: group.label.id, subjectId: group.subject.id }]);
    await noEntry(f, group.subject.id);
    await noCopies(f, group.subject.id);
    await noSessions(f, group.subject.id);
    await noEntry(f, group.recipe.id);
    const after = status(await f.base.read(group.recipe), 200);
    expect(after.body).toEqual(group.publicBefore.body);
    const recipe = after.body.subject as Subject;
    expect(recipe.statements['schema:suitableForDiet'] ?? []).toEqual([]);
  },
);

native(
  'Released active-session-only and completed-history-only supports create neither entry nor copy and retain actual changes',
  async (f) => {
    const group = await f.sessions();
    for (const [item, state] of [
      [group.active, 'active'],
      [group.history, 'completed'],
    ] as const) {
      const read = status(await f.request('alice', 'GET', `/v1/progressSessions/${item.session.id}`), 200);
      expect(read.body.progressSession).toEqual(item.session);
      expect(item.session.state).toBe(state);
      const changes = await page<{ revision: number; intent: unknown }>(
        f,
        `/v1/progressSessions/${item.session.id}/changes`,
        'changes',
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]!.revision).toBe(2);
      await noEntry(f, item.subject.id);
      await noCopies(f, item.subject.id);
    }
    expect(group.history.session.completedAt).toEqual(expect.any(String));
  },
);

native('Released holding-only support retains a native copy without an entry session or payment', async (f) => {
  const entitlements = await page(f, '/v1/entitlements?limit=100', 'entitlements');
  const group = await f.holdings();
  const read = status(await f.request('alice', 'GET', `/v1/copies/${group.copy.id}`), 200);
  expect(read.body.copy).toEqual(group.copy);
  expect(await page<CopyHandle>(f, `/v1/copies?subjectId=${group.subject.id}`, 'copies')).toEqual([group.copy]);
  await noEntry(f, group.subject.id);
  await noSessions(f, group.subject.id);
  expect(await page(f, '/v1/entitlements?limit=100', 'entitlements')).toEqual(entitlements);
  expect(
    f.calls.every((call) => call.method === 'GET' || !/checkout|orders|entitlements|payments/.test(call.path)),
  ).toBe(true);
});

native(
  'Shared controlled labels copies and session history retain no-entry supports while Bob facts never become Alice private rows',
  async (f) => {
    const group = await f.labels();
    const bob = await page(f, `/v1/libraryLabelAssignments?subjectId=${group.subject.id}`, 'assignments', 'bob');
    expect(bob).toEqual([
      { ...group.bobAssignment.assignment, labelId: group.bob.label.id, subjectId: group.subject.id },
    ]);
    const alice = await page(f, `/v1/libraryLabelAssignments?subjectId=${group.subject.id}`, 'assignments');
    expect(alice).toEqual([{ ...group.assignment.assignment, labelId: group.label.id, subjectId: group.subject.id }]);
    for (const persona of ['bob', 'outsider'] as const) {
      const labels = await page<{ id: string }>(f, '/v1/libraryLabels?limit=100', 'labels', persona);
      expect(labels.some((row) => row.id === group.label.id)).toBe(false);
    }
    const sessions = await f.sessions();
    const holding = await f.holdings();
    for (const persona of ['bob', 'outsider', 'anonymous'] as const) {
      problem(await f.request(persona, 'GET', `/v1/copies/${holding.copy.id}`), 404, 'not_found');
      problem(await f.request(persona, 'GET', `/v1/progressSessions/${sessions.history.session.id}`), 404, 'not_found');
    }
    for (const subject of [group.subject, holding.subject, sessions.history.subject]) await noEntry(f, subject.id);
  },
);

native('Unscoped native identities cannot create private Library support', async (f) => {
  const subject = await f.base.createSubject('schema:Book', 'Unscoped owner write control');
  const before = await page(f, '/v1/follows?limit=100', 'follows', 'alice');
  problem(await f.request('unscoped', 'PUT', `/v1/follows/${subject.id}`, undefined, discoveryKey()), 403, 'forbidden');
  expect(await page(f, '/v1/follows?limit=100', 'follows', 'alice')).toEqual(before);
  await noEntry(f, subject.id);
  expect(f.prerequisites.ownerReadonly.state).toBe('prerequisite');
});

native(
  'Native revoked and invalid bearers remain401 controls distinct from the missing valid suspended403 prerequisite',
  async (f) => {
    problem(await f.request('suspended', 'GET', '/v1/definitions/active'), 401, 'invalid_credentials');
    problem(
      await f.request('anonymous', 'GET', '/v1/definitions/active', undefined, {
        authorization: 'Bearer invalid-library-control',
      }),
      401,
      'invalid_credentials',
    );
    problem(
      await f.request(
        'suspended',
        'GET',
        `/v1/collections?curatorAccountId=${f.base.personas.alice.accountId}&limit=100`,
      ),
      401,
      'invalid_credentials',
    );
    // Base v1 does not deliver a valid suspended bearer. This control cannot certify the required403.
    expect(f.prerequisites.validSuspended.state).toBe('prerequisite');
  },
);

native(
  'Discovered Everything has the exact own support union once and excludes empty follow curated and Bob-only controls',
  async (f) => {
    const collection = await everything(f);
    const own = await f.state();
    const labels = await f.labels();
    const sessions = await f.sessions();
    const holding = await f.holdings();
    const multiple = await f.multiple();
    const controls = await f.controls();
    const sources = await f.sources();
    expect(sources.sources).toHaveLength(3);
    const rows = await members(f, collection.id);
    const expected = [
      own.subject.id,
      labels.subject.id,
      labels.recipe.id,
      sessions.active.subject.id,
      sessions.history.subject.id,
      holding.subject.id,
    ];
    expect(rows.map((row) => row.subjectId).sort()).toEqual(expected.sort());
    expect(rows.every((row) => row.kind === 'dynamic' && !('id' in row) && !('note' in row))).toBe(true);
    expect(multiple.subject.id).toBe(own.subject.id);
    for (const subject of [labels.subject, holding.subject]) await noEntry(f, subject.id);
    for (const id of [
      controls.empty.id,
      controls.followed.subject.id,
      controls.bob.subject.id,
      controls.curatedOnly.id,
    ])
      expect(rows.some((row) => row.subjectId === id)).toBe(false);
    // Empty subject and empty entry shell are distinct. The owner currently admits no shell constructor.
    expect(f.prerequisites.shell.state).toBe('prerequisite');
  },
);

native('State clear removes only state while native history holding and exact Undo descriptor survive', async (f) => {
  const group = await f.multiple();
  const removed = status(
    await f.request(
      'alice',
      'DELETE',
      `/v1/libraryEntries/${group.subject.id}?revision=${group.entry.revision}`,
      undefined,
      discoveryKey(),
    ),
    204,
  );
  const deletionId = removed.headers.get('Library-Entry-Deletion-Id');
  const revision = removed.headers.get('Library-Entry-Deletion-Revision');
  expect(deletionId).toEqual(expect.any(String));
  expect(revision).toBe(String(group.entry.revision + 1));
  await noEntry(f, group.subject.id);
  expect(status(await f.request('alice', 'GET', `/v1/copies/${group.holding.copy.id}`), 200).body.copy).toEqual(
    group.holding.copy,
  );
  expect(
    status(await f.request('alice', 'GET', `/v1/progressSessions/${group.history.session.id}`), 200).body
      .progressSession,
  ).toEqual(group.history.session);
  const collection = await everything(f);
  expect((await members(f, collection.id)).map((row) => row.subjectId)).toContain(group.subject.id);
  const restored = status(
    await f.request(
      'alice',
      'POST',
      `/v1/libraryEntries/${group.subject.id}:restore`,
      { deletionId, revision: Number(revision) },
      discoveryKey(),
    ),
    200,
  );
  expect(restored.body.libraryEntry).toEqual({ ...group.entry, revision: group.entry.revision + 2 });
  expect(status(await f.request('alice', 'GET', `/v1/libraryEntries/${group.subject.id}`), 200).body).toEqual(
    restored.body,
  );
  // owner_write_seq is private backend state. This HTTP fixture never manufactures or reads a counter value.
});

native(
  'Removing the final live label support removes presence on the next owner read and deleted parents never qualify',
  async (f) => {
    const group = await f.labels();
    const collection = await everything(f);
    const before = await members(f, collection.id);
    expect(before.map((row) => row.subjectId)).toContain(group.subject.id);
    const deleted = status(
      await f.request(
        'alice',
        'DELETE',
        `/v1/libraryLabels/${group.label.id}?revision=${group.label.revision}`,
        undefined,
        discoveryKey(),
      ),
      200,
    );
    expect(deleted.body).toEqual({ deleted: true });
    expect(await page(f, `/v1/libraryLabelAssignments?subjectId=${group.subject.id}`, 'assignments')).toEqual([]);
    expect((await members(f, collection.id)).map((row) => row.subjectId)).not.toContain(group.subject.id);
    await noEntry(f, group.subject.id);
    // Bob's independently live label still cannot retain Alice's membership.
    expect(
      await page(f, `/v1/libraryLabelAssignments?subjectId=${group.subject.id}`, 'assignments', 'bob'),
    ).toHaveLength(1);
  },
);

native(
  'Released Recipe cooking history belongs to Alice on R-cooked and only Bob on R-other-cooked without state or copy',
  async (f) => {
    const group = await f.recipes();
    for (const [item, persona, other] of [
      [group.alice, 'alice', 'bob'],
      [group.bob, 'bob', 'alice'],
    ] as const) {
      expect(item.session.state).toBe('completed');
      expect(item.session.mode).toBe('scalar_amount');
      expect(item.session.unit).toBe('minute');
      expect(
        status(await f.request(persona, 'GET', `/v1/progressSessions/${item.session.id}`), 200).body.progressSession,
      ).toEqual(item.session);
      expect(
        await page<SessionHandle>(f, `/v1/progressSessions?subjectId=${item.subject.id}`, 'progressSessions', other),
      ).toEqual([]);
      await noEntry(f, item.subject.id, persona);
      expect(await page(f, `/v1/copies?subjectId=${item.subject.id}`, 'copies', persona)).toEqual([]);
    }
    expect(f.calls.every((call) => !call.path.includes('notCooked'))).toBe(true);
  },
);

native(
  'Bundled Book game Recipe and record choices are actual release bindings without a universal active state or synthetic pin',
  async (f) => {
    for (const type of ['schema:Book', 'schema:VideoGame', 'schema:Recipe', 'schema:MusicAlbum']) {
      const accepted = f.profile(type);
      expect(accepted.profile.id).toBe(accepted.pin.profileId);
      expect(accepted.pin.releaseDigest).toBe(f.base.release.digest);
      expect(accepted.pin.acceptingType).toBe(type);
      expect(accepted.profile.entryStateSet!.states.length).toBeGreaterThan(0);
      const choice = accepted.profile.entryStateSet!.states[0]!;
      const subject = await f.base.createSubject(type, `Released ${type} state control`);
      const created = status(
        await f.request('alice', 'PUT', `/v1/libraryEntries/${subject.id}`, { state: choice.id }, discoveryKey()),
        201,
      );
      expect(status(await f.request('alice', 'GET', `/v1/libraryEntries/${subject.id}`), 200).body).toEqual(
        created.body,
      );
    }
  },
);

native(
  'Released curated source setup preserves raw duplicate occurrences and public unlisted private controls',
  async (f) => {
    const group = await f.sources();
    for (const item of group.sources) {
      const rows = await page<OccurrenceHandle>(f, `/v1/collections/${item.source.id}/members?limit=100`, 'members');
      expect(rows).toEqual(item.occurrences.map((occurrence) => occurrence.member));
      const duplicate = item.occurrences.at(-1)!.member;
      const originals = rows.filter((row) => row.subjectId === duplicate.subjectId);
      expect(originals).toHaveLength(2);
      expect(new Set(originals.map((row) => row.id)).size).toBe(2);
      expect(new Set(originals.map((row) => row.note)).size).toBe(2);
      const read = await f.request('anonymous', 'GET', `/v1/collections/${item.source.id}/members?limit=100`);
      if (item.source.visibility === 'private') problem(read, 404, 'not_found');
      else {
        status(read, 200);
        expect(read.body.members).toEqual(rows);
      }
    }
  },
);
