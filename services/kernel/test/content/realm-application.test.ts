import { expect, test } from 'bun:test';
import { createContentRealmApplication } from '../../src/content/application/index.ts';
import type {
  RealmCommunityBoard,
  RealmCommunityPorts,
  RealmCommunitySelection,
  RealmCommunityThread,
  RealmDisclosurePorts,
  RealmObservation,
  RealmSearchDisclosure,
  RealmSearchPorts,
} from '../../src/content/contract/index.ts';

type Context = {
  actor: { id: string };
  deadline: number;
  work: { deadline: number; unavailable(message: string): never };
};
type Reader = { actor?: Context['actor']; deadline: number };
type Anchor = { epoch: number; position: number };
type Selection = RealmCommunitySelection;
const unavailable = new Error('native authority unavailable');
function fixture() {
  let now = 0;
  const actor = { id: 'original-principal' };
  const context: Context = {
    actor,
    deadline: 5000,
    work: {
      deadline: 4000,
      unavailable() {
        throw unavailable;
      },
    },
  };
  const parent: RealmObservation<Anchor> = { signature: 'realm-space-binding', anchors: [{ epoch: 1, position: 2 }] };
  const subject: RealmObservation<Anchor> = { signature: 'exact-terminal', anchors: [{ epoch: 3, position: 4 }] };
  const calls: { realm: string; subject: string; deadline: number; actor: Context['actor'] }[] = [];
  let parentAfter = parent;
  let subjectAfter = subject;
  let fail = false;
  let threadState: 'positive' | 'absent' = 'positive';
  const disclosure: RealmDisclosurePorts<string, Context, Anchor> = {
    now: () => now,
    hash: JSON.stringify,
    principal: (native) => native.actor.id,
    deadline(deadline) {
      if (now >= deadline) throw unavailable;
    },
    validate: (input) => input,
    failure(error) {
      if (error === unavailable) return 'unknown';
      throw error;
    },
    async parent(_deps, realm) {
      if (fail) throw unavailable;
      expect(realm).toBe('realm');
      return parentAfter;
    },
    async subject(_deps, id) {
      expect(id).toBe('terminal');
      return subjectAfter;
    },
    async thread(_deps, candidate, realm, native) {
      calls.push({ realm, subject: candidate.subjectId, deadline: native.deadline, actor: native.actor });
      return {
        state: threadState,
        signature: 'native-opening',
        final: async () => ({ signature: 'native-opening', anchors: [] }),
      };
    },
    sameHome: (before, after) =>
      before.anchors.every((old) =>
        after.anchors.some((next) => old.epoch === next.epoch && next.position >= old.position),
      ),
  };
  const search: RealmSearchPorts<string, Reader, object, string, Context, RealmSearchDisclosure<Reader, object>> = {
    reader: (pool, reader) => (reader.actor ? pool : undefined),
    withWork: async (_reader, _work, _bound, run) => run(context),
    dependency: (realm, signature, ordinal) => `${realm}:${signature}:${ordinal}`,
    failure: (error) => (error === unavailable ? 'unavailable' : undefined),
    source: (_pool, exact) => exact,
  };
  const board: RealmCommunityBoard = {
    id: 'board',
    realmId: 'realm',
    securityRevision: 'board-revision',
    availability: 'available',
  };
  const thread: RealmCommunityThread = { id: 'thread', boardId: 'board', securityRevision: 'thread-revision' };
  let confirmed: readonly Selection[] = [];
  const community: RealmCommunityPorts<
    string,
    Context,
    RealmCommunityBoard,
    RealmCommunityThread,
    { state: 'unavailable' },
    Selection
  > = {
    recent: async () => ({ threads: [thread], complete: true, current: async () => true }),
    activity: () => ({ select: async () => [], confirm: async () => confirmed }),
    comments: () => new Map([['thread', { state: 'unavailable' }]]),
    same: (before, after) => JSON.stringify([...before]) === JSON.stringify([...after]),
    unavailable() {
      throw unavailable;
    },
  };
  const application = createContentRealmApplication({ disclosure, search, community });
  return {
    application,
    context,
    board,
    calls,
    advance(value: number) {
      now = value;
    },
    moveParent() {
      parentAfter = { ...parent, signature: 'replacement-space' };
    },
    redirectSubject() {
      subjectAfter = { ...subject, signature: 'redirected-subject' };
    },
    fail() {
      fail = true;
    },
    absent() {
      threadState = 'absent';
    },
    stale() {
      confirmed = [{ status: 'withheld', reason: 'stale' }];
    },
  };
}
const input = {
  realmId: 'realm',
  candidates: [{ threadId: 'thread', openingPostId: 'opening', subjectId: 'terminal' }],
};

test('Realm evidence keeps exact identities, principal, original deadline and one final observation', async () => {
  const f = fixture();
  const prepared = await f.application.disclosure.prepare('pool', input, f.context);
  const evidence = await prepared.finish();
  expect(evidence[0]?.state).toBe('positive');
  expect(await prepared.finish()).toBe(evidence);
  expect(f.calls).toEqual([{ realm: 'realm', subject: 'terminal', actor: f.context.actor, deadline: 1000 }]);
  expect(f.calls[0]!.actor).toBe(f.context.actor);
  f.advance(1000);
  expect(await prepared.finish()).toEqual([{ state: 'unknown' }]);
});

test('replacement parent, redirected exact Subject and changed principal never reuse positive evidence', async () => {
  for (const change of ['moveParent', 'redirectSubject'] as const) {
    const f = fixture();
    const prepared = await f.application.disclosure.prepare('pool', input, f.context);
    f[change]();
    expect(await prepared.finish()).toEqual([{ state: 'withheld' }]);
  }
  const f = fixture();
  const prepared = await f.application.disclosure.prepare('pool', input, f.context);
  f.context.actor.id = 'replacement-principal';
  expect(await prepared.finish()).toEqual([{ state: 'unknown' }]);
});

test('installed Realm search port retains terminal association and keeps missing authority unavailable', async () => {
  const f = fixture();
  const reader = { actor: f.context.actor, deadline: f.context.deadline };
  expect(f.application.search.source({ pool: 'pool', reader: { deadline: 5000 } })).toBeUndefined();
  const source = f.application.search.source({ pool: 'pool', reader })!;
  const context = { reader, work: {} };
  const resolution = await source.resolve('realm', context);
  expect(resolution.state).toBe('ready');
  if (resolution.state !== 'ready') throw new Error('Expected Realm authority');
  expect(
    await source.candidates(
      [{ thread: 'thread', opening: 'opening', terminal: 'terminal' }],
      resolution.dependency,
      context,
    ),
  ).toEqual(['discussed']);
  expect(f.calls[0]?.subject).toBe('terminal');
  f.absent();
  expect(
    await source.candidate(
      { thread: 'thread', opening: 'opening', terminal: 'terminal' },
      resolution.dependency,
      context,
    ),
  ).toBe('not_published');
  expect(await source.current('zone', resolution.dependency, context)).toBe('changed');
  f.fail();
  expect(await source.resolve('realm', context)).toEqual({ state: 'unavailable' });
  expect(await source.current('realm', resolution.dependency, context)).toBe('unavailable');
});

test('Realm recent cards keep unavailable activity and reject stale final disclosure', async () => {
  const f = fixture();
  const observation = await f.application.community.observe('pool', [f.board], f.context);
  expect(observation.recent.get('board')).toEqual({
    state: 'current',
    complete: true,
    threads: [
      {
        thread: { id: 'thread', boardId: 'board', securityRevision: 'thread-revision' },
        target: { kind: 'thread', id: 'thread', boardId: 'board' },
        comments: { state: 'unavailable' },
      },
    ],
  });
  expect(await observation.current()).toBe(true);
  f.stale();
  expect(await observation.current()).toBe(false);
});
