import { expect, test } from 'bun:test';
import type { Release } from '@rezics/definitions';
import release from '../../../../packages/definitions/release/rezics.json';
import subjectsMapping from '../../db/search/indices/subjects.json';
import {
  discoveryBulkBody,
  discoveryDocumentActions,
  discoveryDocumentId,
  discoveryIndexDefinition,
  parseDiscoveryDocumentId,
  parseDiscoveryHitIdentity,
  validateDiscoveryDocument,
} from '../../src/search/discovery-documents.ts';
import {
  createDiscoveryRegistry,
  discoveryFilterApplicability,
  discoveryDomain,
  evaluateDiscoveryCondition,
  validateKindCountEvidence,
} from '../../src/search/discovery-registry.ts';
import type {
  DiscoveryCondition,
  DiscoveryKey,
  DiscoveryRegistryOptions,
  IndexedAccount,
} from '../../src/search/discovery.ts';
import { documentActions } from '../../src/search/document.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const nativeId = '018f0000-0000-7000-8000-00a000000001';
const partition = 10;
const route = 160;
const position = 9_007_199_254_740_997n;
const revision = 9_007_199_254_740_995n;
const noRead = async (): Promise<never> => {
  throw new Error('Document construction must not call a source or hydrate profiles');
};
const options: DiscoveryRegistryOptions = {
  release: release as Release,
  semantic: {
    source: { read: noRead, count: noRead },
    hydrate: noRead,
    icons: Object.fromEntries(Object.keys(release.types).map((kind) => [kind, 'catalogue'])),
  },
  accounts: {
    source: { read: noRead, count: noRead, page: noRead },
    hydrate: noRead,
    labels: { en: 'Accounts' },
    icon: 'account',
  },
};
const registry = createDiscoveryRegistry(options);
const registryWithCollection = createDiscoveryRegistry({
  ...options,
  ownerAdapters: {
    collection: {
      readiness: 'ready',
      adapter: {
        owner: 'commerce',
        kind: 'collection',
        metadata: { id: 'collection', labels: { en: 'Collection' }, icon: 'collection' },
        readCurrent: noRead,
      },
    },
    review: { readiness: 'unavailable' },
    space: { readiness: 'unavailable' },
  },
});
const accountKey: DiscoveryKey = { owner: 'accounts', kind: 'account', route, id: nativeId };
const personKey: DiscoveryKey = { owner: 'semantic', kind: 'schema:Person', route, id: nativeId };
const account = (handle: string | null): IndexedAccount => ({
  id: nativeId,
  accountKind: 'actor',
  handle,
  displayName: '静かな Reader',
  revision,
});
const subject: IndexedSubject = {
  id: nativeId,
  type: 'schema:Person',
  visibility: 'visible',
  redirect: null,
  securityRevision: 3,
  labels: [{ language: 'en', value: 'Current Person' }],
  aliases: [{ language: 'ja', value: '別名' }],
  descriptions: [{ language: 'en', value: 'Public description' }],
  statements: [{ property: 'schema:inLanguage', value: 'en', facet: { kind: 'code' } }],
};

test('refinement applicability comes from registered domains for the selected population', () => {
  expect(discoveryFilterApplicability(registry, ['schema:Person'])).toEqual({ type: 'all', statement: 'all' });
  expect(discoveryFilterApplicability(registryWithCollection, ['collection'])).toEqual({
    type: 'none',
    statement: 'none',
  });
  expect(discoveryFilterApplicability(registryWithCollection, ['collection', 'schema:Person'])).toEqual({
    type: 'partial',
    statement: 'partial',
  });
  expect(discoveryFilterApplicability(registry)).toEqual({ type: 'partial', statement: 'partial' });
  expect(discoveryFilterApplicability(registry, null)).toEqual({ type: 'unknown', statement: 'unknown' });
});

// These tests exercise the real registry and pure document boundary; they do not certify a native mixed population.
test('released catalogue kinds and Account have independent tagged identities and closed owner/route dispatch', () => {
  expect(registry.entries.map((entry) => entry.kind)).toEqual([...Object.keys(release.types), 'account']);
  expect(registry.get('schema:Person')).toMatchObject({ owner: 'semantic', summary: 'subject' });
  expect(registry.get('account')).toMatchObject({ owner: 'accounts', summary: 'account', domains: ['text', 'kind'] });
  expect(registry.get('schema:Person').metadata.labels).toEqual(release.types['schema:Person'].labels);
  expect(Object.isFrozen(registry.entries)).toBe(true);
  expect(Object.isFrozen(registry.get('account').metadata.labels)).toBe(true);
  const accountId = discoveryDocumentId(registry, accountKey);
  const personId = discoveryDocumentId(registry, personKey);
  expect(accountId).not.toBe(personId);
  expect(parseDiscoveryDocumentId(registry, accountId)).toEqual(accountKey);
  expect(parseDiscoveryDocumentId(registry, personId)).toEqual(personKey);
  expect(() => parseDiscoveryDocumentId(registry, nativeId)).toThrow();
  expect(() => parseDiscoveryDocumentId(registry, personId.replace('%3A', '%3a'))).toThrow();
  expect(() => registry.get('unregistered')).toThrow();
  expect(() => registry.key({ ...accountKey, route: route + 1 })).toThrow();
  expect(() => registry.key({ ...personKey, owner: 'accounts', kind: 'account', route: 0 })).toThrow();
  expect(() => registry.key({ ...personKey, kind: 'account' })).toThrow();
  expect(() =>
    createDiscoveryRegistry({
      ...options,
      release: { ...options.release, types: { account: options.release.types['schema:Person']! } },
    }),
  ).toThrow();
  const removed = discoveryDocumentActions(
    registry,
    {
      owner: 'accounts',
      snapshot: { partition, position, accounts: [] },
    },
    [accountKey],
  );
  expect(removed).toEqual([{ op: 'delete', id: accountId, version: position }]);
  expect(removed[0]!.id).not.toBe(personId);
  expect(() =>
    discoveryDocumentActions(
      registry,
      {
        owner: 'accounts',
        snapshot: { partition, position, accounts: [] },
      },
      [personKey],
    ),
  ).toThrow();
});

test('Account handled and handleless projections exclude every private/profile field and preserve exact native versions', () => {
  for (const handle of ['reader', null]) {
    // An invalid native claim is projected by its owner as null. The registry does not re-verify claims.
    const native = {
      ...account(handle),
      biography: 'private biography',
      oldHandles: ['former'],
      email: 'private@example.test',
      operatorId: nativeId,
      profile: { public: false },
      avatar: { media: nativeId },
      verifiedAgent: subject,
      authnFenceReason: 'secret reason',
      automated: true,
    };
    const [action] = discoveryDocumentActions(
      registry,
      {
        owner: 'accounts',
        snapshot: { partition, position, accounts: [native] },
      },
      [accountKey, accountKey],
    );
    if (action?.op !== 'index') throw new Error('Expected an Account document');
    expect(action.document).toEqual({
      document_format: 1,
      owner: 'accounts',
      kind: 'account',
      route,
      partition,
      id: nativeId,
      source_position: position.toString(),
      account_kind: 'actor',
      handle,
      display_name: '静かな Reader',
      revision: revision.toString(),
    });
    expect(action.version).toBe(position);
    expect(parseDiscoveryHitIdentity(registry, { _id: action.id, _source: action.document })).toEqual(accountKey);
    expect(() =>
      parseDiscoveryHitIdentity(registry, {
        _id: discoveryDocumentId(registry, personKey),
        _source: action.document,
      }),
    ).toThrow();
    for (const field of [
      'biography',
      'oldHandles',
      'email',
      'operatorId',
      'profile',
      'avatar',
      'verifiedAgent',
      'authnFenceReason',
      'names',
    ]) {
      expect(() => validateDiscoveryDocument(registry, { ...action.document, [field]: 'forbidden' })).toThrow();
    }
    const body = discoveryBulkBody(registry, 'test-discovery-g1', [action]);
    expect(body).toContain(`"version":${position.toString()}`);
    expect(body).toContain(`"revision":"${revision.toString()}"`);
    expect(body).not.toContain('private');
    expect(body.split('\n')).toHaveLength(3);
  }
  expect(() =>
    discoveryDocumentActions(
      registry,
      {
        owner: 'accounts',
        snapshot: { partition: partition + 1, position, accounts: [account(null)] },
      },
      [accountKey],
    ),
  ).toThrow();
  expect(() =>
    discoveryDocumentActions(
      registry,
      {
        owner: 'accounts',
        snapshot: { partition, position, accounts: [account(null), account(null)] },
      },
      [accountKey],
    ),
  ).toThrow();
  expect(() =>
    discoveryDocumentActions(
      registry,
      {
        owner: 'accounts',
        snapshot: {
          partition,
          position,
          accounts: [{ ...account(null), revision: Number(revision) as unknown as bigint }],
        },
      },
      [accountKey],
    ),
  ).toThrow();
});

test('Account-domain negation preserves not-applicable and incomplete evidence; Subject domains keep their truth', () => {
  for (const domain of ['type', 'statement', 'owner', 'collection', 'zone', 'realm'] as const) {
    const condition: DiscoveryCondition = { not: { domain, value: { in: ['anything'] } } };
    expect(discoveryDomain(registry, 'account', domain)).toBe('not_applicable');
    expect(
      evaluateDiscoveryCondition(registry, 'account', condition, () => {
        throw new Error('Unsupported owner domain was evaluated');
      }),
    ).toBe('not_applicable');
    expect(evaluateDiscoveryCondition(registry, 'schema:Person', condition, () => false)).toBe(true);
    expect(evaluateDiscoveryCondition(registry, 'account', { not: condition }, () => false)).toBe('not_applicable');
  }
  expect(
    evaluateDiscoveryCondition(registry, 'account', { not: { domain: 'text', value: 'reader' } }, () => 'not_proven'),
  ).toBe('not_proven');
  expect(
    evaluateDiscoveryCondition(
      registry,
      'account',
      {
        and: [{ domain: 'kind', value: ['account'] }, { not: { domain: 'statement', value: {} } }],
      },
      () => true,
    ),
  ).toBe('not_applicable');
  expect(() =>
    evaluateDiscoveryCondition(
      registry,
      'account',
      {
        or: [
          { domain: 'text', value: 'reader' },
          { domain: 'email' as never, value: 'secret' },
        ],
      },
      () => true,
    ),
  ).toThrow();
  expect(validateKindCountEvidence(registry, { kind: 'account', value: 0, exact: true })).toEqual({
    kind: 'account',
    value: 0,
    exact: true,
  });
  expect(validateKindCountEvidence(registry, { kind: 'account', unavailable: true })).toEqual({
    kind: 'account',
    unavailable: true,
  });
  expect(validateKindCountEvidence(registry, { kind: 'account', value: 2, exact: false })).toEqual({
    kind: 'account',
    value: 2,
    exact: false,
  });
  expect(() => validateKindCountEvidence(registry, { kind: 'account', value: 0, exact: false })).toThrow();
});

test('Subject construction keeps legacy fields and callers while one strict mixed mapping uses the adopted analyzer', () => {
  const snapshot = { partition, position, subjects: [subject] };
  const counts = new Map([[nativeId, 4]]);
  const [legacy] = documentActions(snapshot, [nativeId], counts);
  const [mixed] = discoveryDocumentActions(registry, { owner: 'semantic', snapshot }, [personKey], counts);
  if (legacy?.op !== 'index' || mixed?.op !== 'index') throw new Error('Expected Subject documents');
  expect(mixed.document).toEqual({
    ...legacy.document,
    document_format: 1,
    owner: 'semantic',
    kind: subject.type,
    route,
    source_position: position.toString(),
  });
  expect(legacy.id).toBe(nativeId);
  expect(mixed.id).toBe(discoveryDocumentId(registry, personKey));
  expect(parseDiscoveryHitIdentity(registry, { _id: mixed.id, _source: mixed.document })).toEqual(personKey);
  for (const hidden of [
    { ...subject, visibility: 'hidden' as const },
    { ...subject, redirect: nativeId },
  ]) {
    expect(
      discoveryDocumentActions(
        registry,
        {
          owner: 'semantic',
          snapshot: { partition, position, subjects: [hidden] },
        },
        [personKey],
      ),
    ).toEqual([{ op: 'delete', id: mixed.id, version: position }]);
  }
  const mapping = discoveryIndexDefinition();
  expect(mapping.settings).toEqual(subjectsMapping.settings);
  expect(mapping.mappings.dynamic).toBe('strict');
  expect(mapping.mappings._meta.discovery_document_format).toBe(1);
  expect(mapping.mappings.properties.handle).toEqual(subjectsMapping.mappings.properties.names);
  expect(mapping.mappings.properties.display_name).toEqual(subjectsMapping.mappings.properties.names);
  expect(mapping.mappings.properties.revision).toEqual({ type: 'keyword' });
  expect(mapping.mappings.properties.source_position).toEqual({ type: 'keyword' });
  for (const field of ['biography', 'email', 'old_handles', 'operator', 'avatar', 'verification', 'authn_fence_reason'])
    expect(mapping.mappings.properties).not.toHaveProperty(field);
});
