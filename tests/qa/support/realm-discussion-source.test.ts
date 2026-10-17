import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureWorkBudget } from '../../../scripts/fixture/budget.ts';
import { sha256, stable } from '../../../scripts/fixture/corpus.ts';
import { RetainedSources, sourceKey } from '../../../scripts/qa/retained-source.ts';
import type { PersonaSession, RetainedPersonaRealm } from './personas.ts';
import { buildRealmDiscussionCorpus, realmDiscussionSourceAdapter, realmDiscussionSourceSpecification,
  realmSourceBuildDeadlineMs, realmSourceMeasurements, realmSourcePopulation, realmSourceRankingAt, realmSourceRoles, validateRealmSourceMetadata, verifyRealmDiscussionCorpus,
  type RealmSourceReply, type RealmSourceRequest, type RealmSourceRuntime, type RealmSourceSessions } from './realm-discussion-source.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
function fixture(options: { retryIdentity?: boolean; denyIdentity?: boolean } = {}) {
  const replies = new Map<string, RealmSourceReply>(), works = new Map<string, { work: string; workRevision: string }>();
  const placements = new Map<string, string[]>(), sessions = {} as RealmSourceSessions;
  const requests: { path: string; body: Record<string, unknown>; key: string | undefined }[] = [];
  let episode = 'old', history = 'all', closed = 0, builds = 0, restores = 0, identityAttempt = 0, cuts = 0;
  const oldPrivate = new Set<string>();
  for (const [name, visibility] of [['rankingPublic', 'public'], ['rankingPrivate', 'private'],
    ['discussionPublic', 'public'], ['discussionPrivate', 'private']] as const) {
    const realm = id(), space = id(), zone = id();
    const people = Object.fromEntries(realmSourceRoles.map(role => {
      const actor = role === 'visitor' ? null : id(), accountId = role === 'visitor' ? null : randomUUID();
      const person: PersonaSession = { actingSubject: actor, accountId,
        snapshot: () => ({ expiresAt: null, main: person.main }),
        account: async () => Response.json({ user: { id: accountId }, session: { userId: accountId } }),
        main: async (method, path, input, key) => {
          const url = new URL(path, 'http://fixture.test'), body = input as Record<string, unknown>;
          if (method !== 'GET') requests.push({ path: url.pathname, body, key });
          if (url.pathname === '/v1/spaces' && method === 'POST') return Response.json({ realm: id() }, { status: 201 });
          if (url.pathname.endsWith('/role-impact')) return Response.json({ digest: sha256('role') });
          if (url.pathname.endsWith('/role-changes')) return Response.json({}, { status: 201 });
          if (url.pathname.endsWith('/progress')) return Response.json({});
          if (url.pathname.endsWith('/agent-credits')) return Response.json({
            items: [{ id: id(), agent: actor, role: 'author' }], nextCursor: null });
          if (url.pathname === '/v1/works' && method === 'POST') {
            const work = { work: id(), workRevision: id(), mainVersion: id() }; works.set(work.work, work); return Response.json(work, { status: 201 });
          }
          if (url.pathname === '/v1/contributions') return Response.json({ contribution: id(), draftRevision: id() }, { status: 201 });
          if (url.pathname === '/v1/contribution-publications') return Response.json({ publicationDecision: id() }, { status: 201 });
          if (url.pathname === '/v1/publication-selections') return Response.json({}, { status: 201 });
          if (/^\/v1\/works\//.test(url.pathname)) {
            const work = works.get(`https://rezics.com/id/${url.pathname.split('/').at(-1)}`)!;
            return Response.json({ id: work.work, revision: work.workRevision });
          }
          if (url.pathname.startsWith('/v1/revisions/')) return Response.json({});
          if (url.pathname === '/v1/me/session-agent') return Response.json({ sessionAgent: { actingSubject: actor, eligible: true } });
          if (url.pathname === '/v1/me/agents') return Response.json({ items: [{ actingSubject: actor, kind: 'person' }] });
          if (url.pathname === '/v1/member-reply-drafts') {
            const reply: RealmSourceReply = { reply: String(body.reply), variantId: String(body.variantId),
              revisionId: randomUUID(), revisionDigest: sha256(String(body.body)), author: actor!, rootTarget: String(body.rootTarget),
              rootRevision: String(body.rootRevision), parentReply: null, parentRevision: null, contextRevision: null,
              placement: '', body: String(body.body) };
            replies.set(reply.reply, reply); return Response.json({ ...reply, replayed: false }, { status: 201 });
          }
          if (url.pathname === '/v1/realm-replies') {
            identityAttempt++;
            if (options.denyIdentity) return Response.json({ code: 'realm_reply_denied' }, { status: 403 });
            if (options.retryIdentity && identityAttempt === 1)
              return Response.json({ code: 'read_basis_changed' }, { status: 409 });
            Object.assign(replies.get(String(body.reply))!, { parentReply: body.parentReply, parentRevision: body.parentRevision });
            return Response.json({ ...body, replayed: false }, { status: 201 });
          }
          if (url.pathname === '/v1/realm-reply-placements') {
            const reply = replies.get(String(body.reply))!, placement = id(); reply.placement = placement;
            const placementRealm = String(body.realm);
            placements.set(placementRealm, [...placements.get(placementRealm) ?? [], reply.reply]);
            if (name === 'rankingPrivate' && episode === 'old') oldPrivate.add(reply.reply);
            return Response.json({ placement, replayed: false }, { status: 201 });
          }
          if (url.pathname.startsWith('/v1/member-replies/'))
            return Response.json(replies.get(`https://rezics.com/id/${url.pathname.split('/').at(-1)}`));
          if (url.pathname.endsWith('/settings')) {
            if (method === 'PUT') history = 'from-admission';
            return Response.json({ generation: '1', settings: { history, visibility: 'private', admission: 'invitation' } }, { status: method === 'PUT' ? 201 : 200 });
          }
          if (url.pathname.endsWith('/roles')) return Response.json({ generation: '1', roles: ['moderate'] });
          if (url.pathname.endsWith('/members')) return Response.json({ generation: episode, items: [{ member: sessions[name]?.member.actingSubject,
            membershipGeneration: episode }] }, { status: method === 'POST' ? 201 : 200 });
          if (url.pathname.endsWith('/invitations')) return Response.json({ invitation: { id: randomUUID() } });
          if (url.pathname.endsWith('/response')) { episode = 'current'; return Response.json({}); }
          const selectedRealm = Object.values(sessions).find(session => url.pathname.includes(session.realm.slice(-36)));
          const denied = (selectedRealm?.visibility ?? visibility) === 'private' && ['visitor', 'stranger', 'operator'].includes(role);
          if (denied) return Response.json({ code: 'unavailable' }, { status: 404 });
          if (url.pathname.endsWith('/threads')) {
            const items = (placements.get(realm) ?? []).filter(reply => !replies.get(reply)!.parentReply &&
              !(name === 'rankingPrivate' && role === 'member' && oldPrivate.has(reply))).map(reply => ({ reply }));
            return Response.json({ items, nextCursor: null, count: { value: items.length, kind: 'exact-page', total: null } });
          }
          if (url.pathname.includes('/threads/') && name === 'rankingPrivate' && role === 'member' &&
            oldPrivate.has(`https://rezics.com/id/${url.pathname.split('/').at(-1)}`)) return Response.json({}, { status: 404 });
          if (url.pathname.includes('/threads/')) {
            const item = replies.get(`https://rezics.com/id/${url.pathname.split('/').at(-1)}`)!;
            return Response.json({ rootRevision: item.rootRevision,
              items: [{ reply: item.reply, parent: item.parentReply, revisionId: item.revisionId }] });
          }
          if (url.pathname.includes('/replies/')) {
            const coordinates = url.pathname.split('/');
            expect(decodeURIComponent(coordinates[3]!)).toBe(realm);
            const item = replies.get(decodeURIComponent(coordinates.at(-1)!))!;
            return Response.json({ ...item, realm });
          }
          return Response.json({});
        },
      };
      return [role, person];
    })) as Record<typeof realmSourceRoles[number], PersonaSession>;
    sessions[name] = { ...people, realm, space, zone, visibility, elapsedSeconds: 0, close: async () => { closed++; } };
  }
  // A single deployed first administrator backs all four Realms.
  for (const realm of Object.values(sessions)) realm.operator = sessions.rankingPublic.operator;
  const runtime: RealmSourceRuntime = { revision: 'unit', qaIdentity: 'unit',
    async bootstrap() { builds++; return sessions; },
    retain(realm) { return { realm: realm.realm, space: realm.space, zone: realm.zone, visibility: realm.visibility,
      auth: { accountOrigin: 'http://account.test', clientId: 'client', redirectUris: ['http://callback.test'], scope: 'read',
        mainClientId: 'main', mainClientSecret: 'private-unit-fixture' },
      identities: Object.fromEntries(realmSourceRoles.filter(role => role !== 'visitor').map(role => [role,
        { email: `${role}@example.test`, password: 'private-unit-fixture', accountId: realm[role].accountId!, actingSubject: realm[role].actingSubject! }])) as RetainedPersonaRealm['identities'] }; },
    async cut(context, metadata) { cuts++; writeFileSync(join(context.backup, 'physical'), 'unit physical bytes');
      return { rdfDigest: sha256('unit rdf'), ownerState: { corpus: metadata } }; },
    async verify() { return []; },
    async restore(context, metadata) {
      restores++;
      const directory = join(context.directory, `copy-${restores}`); cpSync(context.backup, directory, { recursive: true });
      return { sessions, metadata: structuredClone(metadata), runId: `copy-${restores}`,
        preparation: { restoreMs: 0, startupMs: 0, readinessMs: 0, totalMs: 0, admissionWaitMs: 0 },
        async close() { rmSync(directory, { recursive: true, force: true }); } };
    },
    async remove() {},
  };
  return { runtime, requests, replies, sessions, counts: () => ({ builds, restores, closed, cuts }) };
}

test('keys bind actual producer/helper/schema bytes, complete populations and native compatibility', () => {
  const spec = realmDiscussionSourceSpecification({ producer: sha256('producer'), schema: sha256('schema') }, { native: 'one' });
  expect(sourceKey(spec)).not.toBe(sourceKey({ ...spec, files: { ...spec.files, producer: sha256('changed producer') } }));
  expect(sourceKey(spec)).not.toBe(sourceKey({ ...spec, files: { ...spec.files, schema: sha256('changed schema') } }));
  expect(sourceKey(spec)).not.toBe(sourceKey({ ...spec, compatibility: { native: 'two' } }));
  expect(sourceKey(spec)).not.toBe(sourceKey({ ...spec, inputs: { ...spec.inputs, population: { ...realmSourcePopulation, siblings: 192 } } }));
});

// Cold subprocess imports traverse Main and Account; allow host contention while retaining a bounded exit check.
test('the explicit preparation entry imports outside the Bun test runner without starting an application', async () => {
  const child = Bun.spawn(['bun', '-e', "import('./tests/qa/support/realm-discussion-source-runtime.ts').then(m => { if (typeof m.realmSourceRuntime !== 'function') process.exit(2); })"],
    { cwd: join(import.meta.dir, '../../..'), env: { ...process.env, REZICS_REALM_SOURCE_PREPARATION: undefined }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
}, 30_000);

test('confirmation checkouts retain Realm backups locally even when retained inputs belong to another checkout', async () => {
  const script = String.raw`
    const { root } = await import('./scripts/fixture/stack.ts');
    const { join } = await import('node:path');
    const { realmSourceDirectory } = await import('./tests/qa/support/realm-discussion-source-runtime.ts');
    const { retainStoppedOwnerBackup } = await import('./scripts/load/catalogue-backup.ts');
    if (realmSourceDirectory() !== join(root, '.temp', 'realm-discussion-sources'))
      throw new Error('Realm backup publication escaped the running checkout');
    try {
      await retainStoppedOwnerBackup('confirmation-proof', 'cut',
        join(process.env.REZICS_QA_RETAINED_ROOT, '.temp', 'realm-discussion-sources', 'backup'), Date.now());
      throw new Error('An outside backup was accepted');
    } catch (error) {
      if (error.message !== 'Catalogue backups must stay in this checkout .temp') throw error;
    }
  `;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: join(import.meta.dir, '../../..'),
    env: { ...process.env, REZICS_QA_RETAINED_ROOT: '/tmp/realm-confirmation-origin' },
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(20_000),
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
}, 30_000);

test('the source cost contract imports in the QA planner without registering persona hooks', async () => {
  const child = Bun.spawn(['bun', '-e', "import('./tests/qa/support/realm-discussion-source.ts')"], {
    cwd: join(import.meta.dir, '../../..'),
    env: { ...process.env, REZICS_REALM_SOURCE_PREPARATION: undefined },
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(20_000),
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
}, 30_000);

test('importing the shared Realm fixture installs no test hooks outside the runner', async () => {
  const child = Bun.spawn(['bun', '-e', "await import('./tests/qa/support/personas.ts'); await import('./scripts/qa/bootstrap.ts')"], {
    cwd: join(import.meta.dir, '../../..'),
    env: { ...process.env, REZICS_REALM_SOURCE_PREPARATION: undefined },
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(20_000),
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
}, 30_000);

test('the preparation entry reaches admission without awaiting its own dynamic import', async () => {
  const child = Bun.spawn(['bun', 'tests/qa/support/realm-discussion-source-runtime.ts', '--prepare'], {
    cwd: join(import.meta.dir, '../../..'),
    env: { ...process.env, REZICS_REALM_SOURCE_PREPARATION: undefined, REZICS_QA_RUN_ID: undefined },
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(20_000),
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(stderr).toContain('Realm source requires an admitted integration QA environment');
}, 30_000);

test('Account diagnostics omit verification credentials without changing the actual public request', async () => {
  const script = String.raw`
    const { personaSession } = await import('./tests/qa/support/personas.ts');
    let sent, event;
    globalThis.fetch = async input => { sent = String(input); return Response.json({}); };
    const person = personaSession('http://main.test', 'http://account.test', 'fixture-account',
      undefined, undefined, undefined, undefined, undefined, async answer => { event = answer; });
    await person.account('GET', '/api/auth/verify-email?token=fixture-verification-secret');
    if (!sent.includes('token=fixture-verification-secret')) throw new Error('Verification request was changed');
    if (JSON.stringify(event).includes('fixture-verification-secret')) throw new Error('Credential entered diagnostics');
    if (event.request.path !== '/api/auth/verify-email' || event.request.body !== null || event.response.body !== '')
      throw new Error('Account diagnostics must contain timing and identity only');
  `;
  const child = Bun.spawn(['bun', '-e', script], { cwd: join(import.meta.dir, '../../..'),
    env: { ...process.env, REZICS_REALM_SOURCE_PREPARATION: undefined }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
}, 30_000);

test('complete builder uses 552 public draft/identity/placement commands with exact nested and episode bindings', async () => {
  const f = fixture(), directory = mkdtempSync(join(import.meta.dir, '../../../.temp/realm-corpus-unit-'));
  let graphPublications = 0, maximumGraphPublications = 0, identityPublications = 0;
  let exactReads = 0, activeExactReads = 0, maximumExactReads = 0;
  for (const person of new Set(Object.values(f.sessions).flatMap(realm => Object.values(realm)
    .filter((value): value is PersonaSession => typeof value === 'object' && value !== null && 'main' in value)))) {
    const call = person.main;
    person.main = async (...args) => {
      if (args[0] === 'GET' && /^\/v1\/(?:member-replies\/|realms\/[^/]+\/(?:replies|threads)\/)/.test(args[1])) {
        exactReads++;
        maximumExactReads = Math.max(maximumExactReads, ++activeExactReads);
        try { await Promise.resolve(); return await call(...args); }
        finally { activeExactReads--; }
      }
      if (!['/v1/realm-replies', '/v1/realm-reply-placements'].includes(args[1])) return call(...args);
      const identity = args[1] === '/v1/realm-replies';
      if (identity) expect(graphPublications).toBe(0);
      else expect(identityPublications).toBe(0);
      if (identity) identityPublications++;
      maximumGraphPublications = Math.max(maximumGraphPublications, ++graphPublications);
      try { await Promise.resolve(); return await call(...args); }
      finally { graphPublications--; if (identity) identityPublications--; }
    };
  }
  mkdirSync(join(directory, 'backup'));
  try {
    const result = await buildRealmDiscussionCorpus(f.runtime, { key: 'unit', directory, backup: join(directory, 'backup'), budget: new FixtureWorkBudget(1_800_000) });
    validateRealmSourceMetadata(result.metadata);
    expect(result.metadata.rankingAt).toBe(realmSourceRankingAt);
    const wrongBucketTime = structuredClone(result.metadata); wrongBucketTime.rankingAt = '2024-04-01T00:00:00.000Z';
    expect(() => validateRealmSourceMetadata(wrongBucketTime)).toThrow('ranking bucket time differs');
    expect(maximumGraphPublications).toBe(2);
    expect(exactReads).toBeGreaterThanOrEqual(552 * 3);
    expect(maximumExactReads).toBeLessThanOrEqual(6);
    expect(f.requests.filter(request => request.path === '/v1/member-reply-drafts')).toHaveLength(552 + 21);
    expect(f.requests.filter(request => request.path === '/v1/realm-replies')).toHaveLength(552 + 21);
    expect(f.requests.filter(request => request.path === '/v1/realm-reply-placements')).toHaveLength(552 + 21);
    expect(f.requests.filter(request => request.path === '/v1/publication-selections')).toHaveLength(5 + 1 + 24);
    expect(f.requests.filter(request => request.path === '/v1/contribution-publications')
      .every(request => request.body.disclosure === 'public')).toBe(true);
    expect(f.requests.filter(request => request.path === '/v1/realm-replies').every(request => Boolean(request.key))).toBe(true);
    const assignments = f.requests.filter(request => request.path.endsWith('/role-changes'))
      .map(request => request.body.change as { kind: string; validUntil?: string })
      .filter(change => change.kind === 'assignment');
    expect(assignments).toHaveLength(1);
    expect(Date.parse(assignments[0]!.validUntil!)).toBeGreaterThanOrEqual(result.metadata.startingStatesValidUntil);
    const corrupted = structuredClone(result.metadata);
    corrupted.discussion.nested[20]!.parentRevision = randomUUID();
    expect(() => validateRealmSourceMetadata(corrupted)).toThrow('nested chain');
    const incomplete = structuredClone(result.metadata); incomplete.ranking.public.pop();
    expect(() => validateRealmSourceMetadata(incomplete)).toThrow('incomplete');
    const changedAuthor = structuredClone(result.metadata); changedAuthor.ranking.current[0]!.author = id();
    expect(() => validateRealmSourceMetadata(changedAuthor)).toThrow('original author');
    expect(() => validateRealmSourceMetadata(result.metadata, result.metadata.startingStatesValidUntil)).toThrow('expired');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('existing lifecycle retains once, isolates descriptor copies, and refuses corrupt custody without another build', async () => {
  const f = fixture(), directory = mkdtempSync(join(import.meta.dir, '../../../.temp/realm-source-unit-'));
  try {
    const store = new RetainedSources(directory);
    const adapter = realmDiscussionSourceAdapter(realmDiscussionSourceSpecification({ producer: sha256('fixture') }, { native: 'fixture' }), f.runtime);
    const prepared = await store.prepare(adapter);
    expect(prepared.producerBuild?.deadlineMs).toBe(realmSourceBuildDeadlineMs);
    expect(prepared.manifest.provenance.producerBuild?.evidence).toContain('189 serial identities');
    expect((await store.prepare(adapter)).built).toBe(false);
    const first = await store.restore(adapter);
    const original = first.candidate.metadata.discussion.roots[0]!.body;
    first.candidate.metadata.discussion.roots[0]!.body = 'changed first descriptor';
    const firstPhysical = join(directory, prepared.manifest.key, 'copy-1', 'physical');
    writeFileSync(firstPhysical, 'first copy changed');
    const second = await store.restore(adapter);
    expect(second.candidate.metadata.discussion.roots[0]!.body).toBe(original);
    expect(second.candidate.runId).not.toBe(first.candidate.runId);
    expect(readFileSync(join(directory, prepared.manifest.key, 'copy-2', 'physical'), 'utf8')).toBe('unit physical bytes');
    await first.dispose(); await second.dispose();
    expect(f.counts().builds).toBe(1);
    writeFileSync(join(prepared.manifest.provenance.backupPath, 'physical'), 'corrupt');
    await expect(store.restore(adapter)).rejects.toThrow('retained backup file changed');
    expect(f.counts().builds).toBe(1);
    expect(f.counts().restores).toBe(2);
    expect(readFileSync(join(prepared.manifest.provenance.manifestPath), 'utf8')).toContain('realm-discussion-source-v1');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restore failure names the Realm, every changed authority answer and bounded JSON paths with both values', async () => {
  const f = fixture(), directory = mkdtempSync(join(import.meta.dir, '../../../.temp/realm-authority-unit-'));
  mkdirSync(join(directory, 'backup'));
  try {
    const { metadata } = await buildRealmDiscussionCorpus(f.runtime, { key: 'unit', directory,
      backup: join(directory, 'backup'), budget: new FixtureWorkBudget(1_800_000) });
    const owner = f.sessions.rankingPrivate.owner, main = owner.main;
    owner.main = async (...args) => {
      const response = await main(...args);
      if (args[0] !== 'GET') return response;
      const body = await response.json();
      if (args[1].includes('/members?')) {
        body.items[0].membershipGeneration = 'changed-episode';
        body.removed = null;
      }
      if (args[1].includes('/roles?')) body.roles[0] = 'changed-permission';
      if (args[1].includes('/settings?')) body.settings.visibility = 'public';
      return Response.json(body);
    };
    let failure = '';
    try { await verifyRealmDiscussionCorpus(f.sessions, metadata, 'ranking'); }
    catch (error) { failure = (error as Error).message; }
    expect(failure).toContain(`Realm rankingPrivate (${f.sessions.rankingPrivate.realm})`);
    expect(failure).toContain('members answer');
    expect(failure).toContain('$.items[0].membershipGeneration: expected "current", actual "changed-episode"');
    expect(failure).toContain('$.removed: expected <missing>, actual null');
    expect(failure).toContain('roles answer');
    expect(failure).toContain('$.roles[0]: expected "moderate", actual "changed-permission"');
    expect(failure).toContain('settings answer');
    expect(failure).toContain('$.settings.visibility: expected "private", actual "public"');

    // A missing inventory is different from an empty one; report only the first
    // eight paths when a response has many changes.
    owner.main = main;
    const members = metadata.authoritySnapshots.rankingPrivate.members;
    members.items = [];
    for (let index = 0; index < 12; index++) members[`field${index}`] = index;
    await expect(verifyRealmDiscussionCorpus(f.sessions, metadata, 'ranking')).rejects.toThrow('members answer (first 8 differing JSON paths)');
    members.items = null;
    for (let index = 0; index < 12; index++) delete members[`field${index}`];
    await expect(verifyRealmDiscussionCorpus(f.sessions, metadata, 'ranking')).rejects.toThrow('$.items: expected null, actual [{');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('lawful read-basis retry retains the logical command key, body, author and exact intended root revision', async () => {
  const f = fixture({ retryIdentity: true }), directory = mkdtempSync(join(import.meta.dir, '../../../.temp/realm-retry-unit-'));
  mkdirSync(join(directory, 'backup'));
  try {
    await buildRealmDiscussionCorpus(f.runtime, { key: 'unit', directory, backup: join(directory, 'backup'), budget: new FixtureWorkBudget(1_800_000) });
    const identities = f.requests.filter(request => request.path === '/v1/realm-replies');
    expect(identities).toHaveLength(553 + 21);
    expect(identities[1]!.key).toBe(identities[0]!.key);
    expect(identities[1]!.body).toEqual(identities[0]!.body);
    expect(identities[1]!.body.author).toBe(f.sessions.rankingPublic.owner.actingSubject!);
    expect(identities[1]!.body.rootRevision).toBeString();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a terminal public command refusal closes the producer and never cuts or publishes partial custody', async () => {
  const f = fixture({ denyIdentity: true }), directory = mkdtempSync(join(import.meta.dir, '../../../.temp/realm-denial-unit-'));
  try {
    const store = new RetainedSources(directory), adapter = realmDiscussionSourceAdapter(
      realmDiscussionSourceSpecification({ producer: sha256('denial fixture') }, { native: 'fixture' }), f.runtime);
    await expect(store.prepare(adapter)).rejects.toThrow('got 403');
    expect(f.counts().cuts).toBe(0); expect(f.counts().closed).toBe(1);
    await expect(store.select(adapter)).rejects.toThrow('complete manifest');
    expect(f.counts().builds).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the producer checks its declared active budget between requests inside a long population phase', async () => {
  const f = fixture(), directory = mkdtempSync(join(import.meta.dir, '../../../.temp/realm-deadline-unit-'));
  let clock = 0;
  const owner = f.sessions.rankingPublic.owner, main = owner.main;
  owner.main = async (...args) => { const response = await main(...args); clock += 900_000; return response; };
  try {
    const store = new RetainedSources(directory, () => clock), adapter = realmDiscussionSourceAdapter(
      realmDiscussionSourceSpecification({ producer: sha256('deadline fixture') }, { native: 'fixture' }), f.runtime);
    await expect(store.prepare(adapter)).rejects.toThrow('producer build exceeded');
    expect(f.counts().cuts).toBe(0);
    expect(f.requests.filter(request => request.path === '/v1/realm-replies')).toHaveLength(0);
    expect(f.counts().closed).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('distributions keep actual retries, phase overlap and waits distinct and reject changed retry bodies', () => {
  const request = (start: number, finish: number, key: string): RealmSourceRequest => ({ phase: 'identities', service: 'Main',
    caller: { accountId: 'account', actingSubject: 'author' }, method: 'POST', path: '/v1/realm-replies', key,
    body: { rootRevision: 'exact' }, startedAt: start, finishedAt: finish, status: 201, answer: null });
  const events = [request(0, 10, 'one'), request(5, 25, 'two'), request(30, 60, 'one')];
  const report = realmSourceMeasurements(events, { identities: { startedAt: 0, finishedAt: 70 } });
  expect(report.requests).toBe(3); expect(report.retries).toBe(1); expect(report.retryGapMs).toBe(20);
  expect(report.classes['Main POST /v1/realm-replies']).toEqual({ count: 3, medianMs: 20, p95Ms: 30, totalMs: 60 });
  expect(report.phases.identities!.wallMs).toBe(70); expect(report.phases.identities!.overlapMs).toBe(5);
  expect(realmSourceMeasurements(events.slice(0, 2), {}).classes['Main POST /v1/realm-replies']!.medianMs).toBe(15);
  const changed = { ...events[2]!, body: { rootRevision: 'different' } };
  expect(() => realmSourceMeasurements([events[0]!, changed], {})).toThrow('changed command intent');
  expect(stable(report)).not.toContain('password');
});
