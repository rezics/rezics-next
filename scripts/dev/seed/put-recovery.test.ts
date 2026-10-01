import { expect, test } from 'bun:test';
import { recoverSeedPut, seedPutConflict } from './put-recovery.ts';

const uuid = '00000000-0000-4000-a000-000000000001';
const id = `https://rezics.com/id/${uuid}`;
const head = 'https://rezics.com/id/00000000-0000-4000-a000-000000000002';
const actor = { actingSubject: id };
const label = { original: 'en', labels: { en: 'A name', 'zh-Hans': '名字' } };
const release = { profile: 'release-v1', ...actor, id, expectedHead: null,
  title: { value: 'Edition', language: 'en' }, coverage: null, evidence: null };

test('G-909: owner-specific stale/key conflicts are scoped to their PUT contract', () => {
  const owners = [
    ['agent_profile_conflict', `/v1/agents/${uuid}/profile`],
    ['agent_handle_conflict', `/v1/agents/${uuid}/handle`],
    ['library_visibility_conflict', `/v1/agents/${uuid}/library-visibility`],
    ['reader_status_conflict', `/v1/works/${uuid}/reader-status`],
    ['progress_conflict', `/v1/compositions/${uuid}/occurrences/${uuid}/progress`],
    ['review_conflict', `/v1/reviews/${uuid}/helpful`],
    ['home_conflict', '/v1/me/feed-watermarks/following'],
  ];
  for (const [code, path] of owners) {
    expect(seedPutConflict(path!, code!)).toBe(true);
    expect(seedPutConflict('/v1/not-that-owner', code!)).toBe(false);
  }
});
type Scenario = { path: string; body: Record<string, unknown>; current: Record<string, unknown>;
  basis: Record<string, unknown>; readPath: string; authenticated?: boolean };
const scenarios: Scenario[] = [
  { path: `/v1/works/${uuid}/releases/${uuid}`, body: release,
    current: { id, revision: head, title: release.title, legacyCoverage: null, coverage: [] },
    basis: { expectedHead: head }, readPath: `/v1/works/${uuid}/releases/${uuid}` },
  { path: `/v1/works/${uuid}/realizations/${uuid}`,
    body: { ...actor, profile: 'realization-v1', id, expectedHead: null, language: 'en', evidence: 'source' },
    current: { id, revision: head, language: 'en', evidence: 'source' },
    basis: { expectedHead: head }, readPath: `/v1/works/${uuid}/realizations/${uuid}` },
  { path: `/v1/works/${uuid}/metadata`, body: { ...actor, expectedHead: null,
    state: { kind: 'header', originalTitle: null, completionStatus: 'ongoing', localized: [] } },
    current: { revision: head, originalTitle: null, completionStatus: 'ongoing', localized: [] },
    basis: { expectedHead: head }, readPath: `/v1/works/${uuid}/metadata` },
  { path: `/v1/works/${uuid}/type`, body: { ...actor, expectedHead: id, types: ['Book', 'CreativeWork'] },
    current: { revision: head, types: ['CreativeWork', 'Book'] }, basis: { expectedHead: head }, readPath: `/v1/works/${uuid}` },
  { path: `/v1/agents/${uuid}/profile`, body: { expectedHead: id, displayName: 'A name', localizedName: label,
    avatarSelection: null, bio: { text: 'Bio', language: 'en' } }, current: { revision: head,
    originalDisplayName: 'A name', displayName: '名字', localizedNames: label,
    avatarSelection: null, bio: { text: 'Bio', language: 'en' } }, basis: { expectedHead: head },
    readPath: `/v1/agents/${uuid}`, authenticated: false },
  { path: `/v1/agents/${uuid}/handle`, body: { expectedHandle: null, handle: 'reader' },
    current: { handle: 'reader' }, basis: { expectedHandle: 'reader' }, readPath: `/v1/agents/${uuid}`, authenticated: false },
  { path: `/v1/agents/${uuid}/library-visibility`, body: { expectedVersion: 0, visibility: 'public' },
    current: { visibility: 'public', version: 3 }, basis: { expectedVersion: 3 }, readPath: `/v1/agents/${uuid}/library-visibility` },
  { path: `/v1/works/${uuid}/reader-status`, body: { ...actor, expectedVersion: 0, status: 'reading',
    startedOn: '2026-01-01', finishedOn: null }, current: { status: { status: 'reading',
    startedOn: '2026-01-01', finishedOn: null, version: 3 } }, basis: { expectedVersion: 3 },
    readPath: `/v1/works/${uuid}/reader-state` },
  { path: `/v1/compositions/${uuid}/occurrences/${uuid}/progress`, body: { ...actor, expectedVersion: 0,
    completed: false, position: 'paragraph:3' }, current: { version: 3, completed: false, position: 'paragraph:3' },
    basis: { expectedVersion: 3 }, readPath: `/v1/compositions/${uuid}/occurrences/${uuid}/progress` },
  { path: `/v1/collections/${uuid}/name`, body: { ...actor, expectedHead: null, name: label },
    current: { revision: head, name: label }, basis: { expectedHead: head }, readPath: `/v1/collections/${uuid}/name` },
  { path: `/v1/zones/${uuid}/configuration`, body: { ...actor, expectedHead: id, defaultRealm: id,
    presentation: { kind: 'native' } }, current: { revision: head, configuration: { defaultRealm: id,
    presentation: { kind: 'native' }, budget: { rows: 100 } } }, basis: { expectedHead: head },
    readPath: `/v1/zones/${uuid}/configuration` },
  { path: `/v1/realms/${uuid}/settings`, body: { ...actor, expectedGeneration: '1', expectedRulesRevision: null,
    reason: 'Seed rules', settings: { rules: [], selfJoin: true } }, current: { generation: '3',
    ruleBasis: { revision: '2' }, settings: { rules: [], selfJoin: true } },
    basis: { expectedGeneration: '3', expectedRulesRevision: '2' }, readPath: `/v1/realms/${uuid}/settings` },
  { path: `/v1/reviews/${uuid}/helpful`, body: { ...actor, expectedRevision: null, helpful: true },
    current: { id: uuid, viewerVoteRevision: uuid, viewerHelpful: true }, basis: { expectedRevision: uuid },
    readPath: `/v1/reviews/${uuid}` },
  { path: '/v1/me/feed-watermarks/following', body: { ...actor, scope: 'following', dataEpoch: 'epoch', sequence: '0' },
    current: { items: [{ scope: 'following', dataEpoch: 'epoch', sequence: '0' }] }, basis: {}, readPath: '/v1/me/feed-watermarks' },
];

for (const scenario of scenarios) test(`G-909: reconciles the public read contract for ${scenario.path}`, async () => {
  const original = structuredClone(scenario.body);
  const reads: string[] = [];
  const recovery = await recoverSeedPut(scenario.path, scenario.body, async (path, authenticated) => {
    const url = new URL(path, 'http://main.test');
    expect(url.pathname).toBe(scenario.readPath);
    expect(authenticated).toBe(scenario.authenticated ?? true);
    if (authenticated && scenario.body.actingSubject) expect(url.searchParams.get('actingSubject')).toBe(id);
    reads.push(path);
    return scenario.current;
  }, { code: 'stale_head' });
  expect(reads).toHaveLength(1);
  expect(recovery?.matches).toBe(true);
  expect(recovery?.body).toEqual({ ...scenario.body, ...scenario.basis });
  expect(recovery?.result.replayed).toBe(true);
  expect(scenario.body).toEqual(original);
});

test('G-909: release-v2 compares coverage facts without read-only Work and language fields', async () => {
  const coverage = [{ realization: id, revision: head, completeness: 'complete' }];
  const result = await recoverSeedPut(`/v1/works/${uuid}/releases/${uuid}`, {
    ...release, profile: 'release-v2', coverage }, async () => ({ id, revision: head,
    title: release.title, coverage: coverage.map(row => ({ ...row, work: id, mainVersion: id, language: 'en' })) }), {});
  expect(result?.matches).toBe(true);
  expect(result?.result.release).toBe(id);
});

test('G-909: a partial or different state is never certified as matching', async () => {
  const path = `/v1/works/${uuid}/reader-status`;
  const body = { ...actor, expectedVersion: 0, status: 'reading', startedOn: '2026-01-01', finishedOn: null };
  for (const status of [{ status: 'reading', startedOn: null, finishedOn: null, version: 3 },
    { status: 'reading', version: 3 }]) {
    const recovery = await recoverSeedPut(path, body, async () => ({ status }), {});
    expect(recovery?.matches).toBe(false);
    expect(recovery?.body.expectedVersion).toBe(3);
  }
});

test('G-909: progress refresh retains its selected revision and position', async () => {
  const path = `/v1/compositions/${uuid}/occurrences/${uuid}/progress`;
  const selectedRevision = `urn:rezics:content:revision:${uuid}`;
  const body = { ...actor, selectedRevision, completed: true, position: 'paragraph:8', expectedVersion: 0 };
  const recovery = await recoverSeedPut(path, body, async route => {
    expect(new URL(route, 'http://main.test').searchParams.get('selectedRevision')).toBe(selectedRevision);
    return { selectedRevision, completed: false, position: 'paragraph:1', version: 4 };
  }, {});
  expect(recovery?.matches).toBe(false);
  expect(recovery?.body).toEqual({ ...body, expectedVersion: 4 });
});

test('G-909: Realm profile reconciliation checks every language and rule body', async () => {
  const publication = { name: label, description: label, rules: [{ id: 'welcome', title: label,
    body: label, governanceRule: null }], count: { kind: 'exact', value: null }, moderators: [id],
    iconSelection: null, bannerSelection: null };
  const body = { ...actor, profile: 'realm-public-profile-v2', expectedHead: null, publication };
  const read = async (route: string) => {
    const language = new URL(route, 'http://main.test').searchParams.get('language') ?? 'en';
    const selected = { value: label.labels[language as keyof typeof label.labels], language };
    return { id, profileRevision: head, profileContract: 'realm-public-profile-v2',
      originalName: { value: label.labels.en, language: 'en' },
      moderators: { items: [id] }, membership: { count: { kind: 'exact', value: 30 } },
      icon: { kind: 'fallback' }, banner: null, name: selected, description: selected,
      rules: [{ id: 'welcome', title: selected, body: selected, governanceRule: null }] };
  };
  const path = `/v1/realms/${uuid}/profile`;
  expect((await recoverSeedPut(path, body, read, {}))?.matches).toBe(true);
  const changed = structuredClone(body);
  changed.publication.rules[0]!.body.labels['zh-Hans'] = '新规则';
  expect((await recoverSeedPut(path, changed, read, {}))?.matches).toBe(false);
  expect((await recoverSeedPut(path, body, async route => ({ ...await read(route),
    profileContract: 'realm-public-profile-v1' }), {}))?.matches).toBe(false);
});

test('G-909: moderator absence needs the actual choice head before retry', async () => {
  const path = `/v1/realms/${uuid}/moderators/${uuid}/public-choice`;
  const body = { ...actor, expectedHead: null, public: true };
  const read = async () => ({ id, moderators: { items: [] } });
  expect(await recoverSeedPut(path, body, read, {})).toBeNull();
  const recovery = await recoverSeedPut(path, body, read, { currentHead: head });
  expect(recovery?.matches).toBe(false);
  expect(recovery?.body.expectedHead).toBe(head);
  expect((await recoverSeedPut(path, body, async () => ({ id, moderators: { items: [id] } }), {}))?.matches).toBe(true);
});
