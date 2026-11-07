import { expect, test } from 'bun:test';
import {
  createSubjectAnchorApplication,
  createSubjectPresentationApplication,
  createLibraryPresentationApplication,
  createBuiltinOwnerAdmission,
  createBuiltinMembersApplication,
} from '../../src/library/application/index.ts';
import {
  SubjectIdentityUnavailableError,
  type SubjectIdentityCapability,
  type SubjectIdentityObservation,
  type SubjectReferenceObservation,
  type LibraryAccountActor,
} from '../../src/library/contract/index.ts';

function fixture() {
  const mappings = new Map<string, SubjectIdentityObservation>();
  const references = new Map<string, SubjectReferenceObservation>();
  const batches: string[][] = [];
  const prepared: string[] = [];
  let active = 0,
    peak = 0;
  const identity: SubjectIdentityCapability<undefined, SubjectIdentityObservation> = {
    validId: (id) => id !== 'invalid',
    redirected: (from, to) => new Error(`redirect:${from}:${to}`),
    async readMappings(_context, ids) {
      batches.push([...ids]);
      return ids.map((id) => mappings.get(id) ?? { state: 'absent' });
    },
    async prepareReference(_context, id) {
      prepared.push(id);
      return async () => {
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        return references.get(id) ?? { state: 'absent' };
      };
    },
  };
  function mapped(id: string, terminal = id, epoch = 1n) {
    mappings.set(id, { state: 'mapped', terminal, epoch });
    references.set(id, terminal === id ? { state: 'present' } : { state: 'redirect', from: id, to: terminal });
    references.set(terminal, { state: 'present' });
  }
  return { identity, mapped, mappings, references, batches, prepared, peak: () => peak };
}

test('stored keys remain ordered and deduplicated; one mapping batch and at most four reads run', async () => {
  const f = fixture();
  const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
  ids.forEach((id) => f.mapped(id));
  f.mapped('redirected', ids[0]);
  const app = createSubjectAnchorApplication(f.identity);
  expect(await app.readable(undefined, ['invalid', ...ids, 'redirected', ids[0]!])).toEqual([...ids, 'redirected']);
  expect(f.batches).toEqual([[...ids, 'redirected']]);
  expect(f.peak()).toBe(4);
  expect(await app.resolve(undefined, 'redirected')).toEqual({ subjectId: ids[0]!, requestedSubjectId: 'redirected' });
  await expect(app.readable(undefined, Array(101).fill(ids[0]))).rejects.toThrow('at most 100');
});

test('original and terminal observations determine disclosure; pending, absent and unavailable stay distinct', async () => {
  const f = fixture();
  const app = createSubjectAnchorApplication(f.identity);
  f.mapped('original', 'terminal');
  expect(await app.resolve(undefined, 'original')).toEqual({ subjectId: 'terminal', requestedSubjectId: 'original' });
  expect(f.prepared).toEqual(['original', 'terminal']);
  f.references.set('original', { state: 'present' });
  expect(await app.resolve(undefined, 'original')).toBeNull();
  f.references.set('original', { state: 'redirect', from: 'original', to: 'wrong' });
  expect(await app.resolve(undefined, 'original')).toBeNull();
  f.references.set('original', { state: 'redirect', from: 'original', to: 'terminal' });
  f.references.set('terminal', { state: 'absent' });
  expect(await app.resolve(undefined, 'original')).toBeNull();
  f.references.set('terminal', { state: 'redirect', from: 'terminal', to: 'other' });
  await expect(app.resolve(undefined, 'original')).rejects.toThrow('redirect:terminal:other');
  f.mappings.set('original', { state: 'pending' });
  expect(await app.resolve(undefined, 'original')).toBeNull();
  f.mappings.delete('original');
  expect(await app.resolve(undefined, 'original')).toBeNull();
  for (const reason of ['bootstrap', 'missing-owner', 'moved-owner'] as const) {
    f.mappings.set('original', { state: 'unavailable', reason });
    await expect(app.resolve(undefined, 'original')).rejects.toBeInstanceOf(SubjectIdentityUnavailableError);
  }
});

test('one ordered summary batch preserves duplicate occurrences; a same-terminal epoch change is withheld or refused', async () => {
  const f = fixture();
  f.mapped('a', 'terminal');
  f.mapped('b', 'terminal');
  f.mapped('c');
  const batches: string[][] = [];
  const app = createSubjectPresentationApplication(f.identity, {
    unavailable: () => new Error('changed'),
    observe: async (ids) => {
      batches.push([...ids]);
      return { summaries: new Map(ids.map((id) => [id, { id }])), current: async () => true };
    },
  });
  const observed = await app(undefined, ['b', 'a', 'b', 'c'], true);
  expect(batches).toEqual([['terminal', 'c']]);
  f.mapped('a', 'terminal', 2n);
  await observed.current();
  expect([...observed.value]).toEqual([
    ['b', { id: 'terminal' }],
    ['a', null],
    ['c', { id: 'c' }],
  ]);
  const strict = await app(undefined, ['b'], false);
  f.mapped('b', 'terminal', 2n);
  await expect(strict.current()).rejects.toThrow('changed');
});

test('FULL checks final account and target authority after related reads; BASIC does no reads', async () => {
  let changed = false;
  const events: string[] = [];
  const full = createLibraryPresentationApplication({
    unavailable: () => new Error('changed'),
    subjects: async (ids) => ({ value: new Map(ids.map((id) => [id, { id }])), current: async () => true }),
    attributions: async () => ({
      value: new Map([['actor', { displayName: 'Deleted account' }]]),
      current: async () => true,
    }),
    account: async () => ({
      value: { id: 'actor', handle: null, displayName: 'Actor' },
      current: async () => {
        events.push('account-final');
        return !changed;
      },
    }),
    target: async (id, type) => {
      events.push('target-read');
      changed = true;
      return {
        value: { id, type, label: 'Space' },
        current: async () => {
          events.push('space-final');
          return false;
        },
      };
    },
  });
  const body = { rows: [{ accountId: 'actor', subjectId: 's', targetId: 'space', targetType: 'space' }] };
  expect(await full('BASIC', body)).toBe(body);
  expect(events).toEqual([]);
  const result = await full('FULL', body, { withholdChangedSource: true });
  expect(result.rows[0]).toEqual({
    ...body.rows[0],
    account: null,
    target: null,
    subject: { id: 's' },
    attribution: { displayName: 'Deleted account' },
  });
  expect(events).toEqual(['target-read', 'account-final', 'space-final']);
  await expect(full('FULL', body)).rejects.toThrow('changed');
});

test('built-in admission uses current native account truth and members forward one opaque native continuation', async () => {
  const actor: LibraryAccountActor = {
    kind: 'account',
    accountId: 'owner',
    clientId: 'test',
    scopes: ['collection:read'],
    requestedBy: null,
    authnEpoch: 2,
  };
  let fenced = false,
    minimumAuthnEpoch = 1n;
  const admit = createBuiltinOwnerAdmission({
    routeOf: () => 3,
    readAccount: async () => ({
      route: 3,
      accountId: 'owner',
      kind: 'actor',
      state: 'active',
      fenced,
      minimumAuthnEpoch,
    }),
  });
  expect(await admit(undefined, actor)).toBe(actor);
  fenced = true;
  expect(await admit(undefined, actor)).toBeNull();
  fenced = false;
  minimumAuthnEpoch = 3n;
  expect(await admit(undefined, actor)).toBeNull();
  expect(await admit(undefined, { kind: 'anonymous' })).toBeNull();
  let pageReads = 0,
    current = true,
    empty = false;
  const members = createBuiltinMembersApplication({
    read: async () => (current ? { builtinKind: 'everything' } : null),
    proveEmpty: async () => empty,
    sourceVersion: async () => 'native-version',
    deadline: () => 100,
    invalidRequest: () => new Error('invalid'),
    notFound: () => new Error('not found'),
    async readPage(_actor, _id, options) {
      pageReads++;
      expect(options.cursor).toBe('opaque');
      expect(options.limit).toBe(7);
      expect(await options.readSourceVersion()).toBe('native-version');
      await options.revalidateOwner();
      return { members: [{ subjectId: 'native-subject' }], next: 'native-sparse-continuation' };
    },
  });
  expect(await members(actor, 'collection', { cursor: 'opaque', limit: 7 })).toEqual({
    members: [{ subjectId: 'native-subject' }],
    next: 'native-sparse-continuation',
  });
  expect(pageReads).toBe(1);
  current = false;
  await expect(members(actor, 'collection')).rejects.toThrow('not found');
  current = true;
  empty = true;
  expect(await members(actor, 'collection')).toEqual({ members: [], next: null });
  expect(pageReads).toBe(1);
});
