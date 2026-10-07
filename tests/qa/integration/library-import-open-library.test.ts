import { expect, test } from 'bun:test';
import { randomInt, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ReaderImportBudgetExceeded, ReaderImportConflict, ReaderLibraryImportStore }
  from '../../../services/main/src/modules/library-import/reader-import.ts';
import { authorCreditFixture, nativeId } from '../fixtures/author-credit.ts';
import { LibraryFileStore, importDigest } from '../../../services/main/src/modules/library-import/file-store.ts';
import { emptyRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';

test('G428: two readers add one Open Library identity and receive one native Work', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `library-import-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read work:protect library:write source:intake source:acquire source:convert source:propose source:adopt source:correspond source:read');
  try {
    const libraryImport = new ReaderLibraryImportStore(h.pool);
    const libraryFiles = new LibraryFileStore(h.pool);
    const access = new Proxy(h.access, { get(target, property) {
      if (property === 'canReadAsBaselineMember') return async () => true;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let fetched = 0;
    let sourceStarted!: () => void, releaseSource!: () => void;
    const started = new Promise<void>(resolve => { sourceStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseSource = resolve; });
    // Open Library IDs cannot start with zero; a timestamp suffix can.
    const workId = `OL${randomInt(1, 1_000_000_000_000)}W`;
    const app = createMainApp(h.nativeFuseki, {
      account: h.account.verifier, access, environment: h.env,
      accessPolicy: new AccessPolicyOwner(h.accessPool),
      libraryImport, libraryFiles, sourceIntake: h.intake, sourceConversions: h.conversions,
      sourceGraph: h.graph, sourceProposals: h.proposals, sourceAdoptions: h.adoptions,
      openLibraryFetch: (async (url: string) => { fetched++;
        expect(url).toBe(`https://openlibrary.org/works/${workId}.json`);
        sourceStarted();
        await release;
        return Response.json({ key: `/works/${workId}`, type: { key: '/type/work' },
          title: 'Shared imported book', authors: [] });
      }) as typeof fetch,
    });
    const otherActor = nativeId();
    const uploads = new Map<string,string>();
    for (const actor of [h.actor,otherActor]) {
      const row = emptyRow('open-library-book','Shared imported book',{});
      const file = await libraryFiles.create(actor,randomUUID(),importDigest([row]),'generic-csv',[row]);
      await libraryFiles.saveMatch(actor,file.id,0,{ kind: 'not-found',work: null,target: null,truncated: false,
        candidates: [],openLibraryAvailability: 'available',openLibrary: [{ workId,title: row.title,authors: [],coverId: null }] });
      uploads.set(actor,file.id);
    }
    const adopt = (token: string, actor: string) => app.handle(new Request(
      `http://main.local/v1/me/library-imports/${uploads.get(actor)}/rows/0/adoptions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'idempotency-key': `import-${actor.slice(-36)}` },
        body: JSON.stringify({ actingSubject: actor, workId, titleLanguage: 'en' }),
      }));
    const firstPending = adopt(h.account.tokenA, h.actor);
    // A rejected request must fail here, not wait for a fetch it never reaches.
    await Promise.race([started, firstPending.then(async response => {
      throw new Error(`Import returned before acquisition: ${response.status} ${await response.clone().text()}`);
    })]);
    const secondPending = adopt(h.account.tokenB, otherActor);
    await new Promise(resolve => setTimeout(resolve, 50));
    releaseSource();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    if (first.status !== 200) console.error('first import', first.status, await first.clone().text());
    if (second.status !== 200) console.error('second import', second.status, await second.clone().text());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResult = await first.json() as { work: string; replayed: boolean };
    const secondResult = await second.json() as { work: string; replayed: boolean };
    const firstWork = firstResult.work;
    expect(secondResult.work).toBe(firstWork);
    expect([firstResult.replayed, secondResult.replayed].sort()).toEqual([false, true]);
    expect(fetched).toBe(1);
    const bindings = await h.pool.query<{ work: string }>(`
      SELECT b.work FROM source.record r JOIN source.observation o ON o.record_id = r.id
      JOIN source.native_work_proposal p ON p.observation_id = o.id
      JOIN source.native_work_binding b ON b.proposal_id = p.id
      WHERE r.provider = 'open-library' AND r.namespace = 'work' AND r.external_id = $1`, [workId]);
    expect(bindings.rows).toEqual([{ work: firstWork }]);
    await new ReaderLibraryStatusStore(h.pool).putPrivateReview({ agent: h.actor, work: firstWork,
      text: 'Private library row', language: 'en', spoiler: false, expectedVersion: 0,
      idempotencyKey: randomUUID() });
    const otherReader = await app.handle(new Request(`http://main.local/v1/works/${firstWork.slice(-36)}?actingSubject=${encodeURIComponent(otherActor)}`, {
      headers: { authorization: `Bearer ${h.account.tokenB}` } }));
    expect(otherReader.status).toBe(404);
    const search = await app.handle(new Request('http://main.local/v1/queries', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${h.account.tokenB}` },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase: 'Shared imported book', language: 'en' }) }));
    expect(search.status).toBe(200);
    const page = await search.json() as { results: { work: string }[] };
    expect(page.results.some(item => item.work === firstWork)).toBe(false);
  } finally { await h.close(); }
}, 120_000);

test('G428: source budgets are atomic per reader and reset on the next UTC day', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `library-budget-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const store = new ReaderLibraryImportStore(h.pool);
    const actor = nativeId();
    const today = new Date('2026-09-28T08:00:00Z');
    await h.pool.query(`INSERT INTO reader.library_import_daily_budget (agent, day, searches, acquisitions)
      VALUES ($1, '2026-09-28', 199, 49)`, [actor]);
    await Promise.all([store.takeBudget(actor, 'search', today), store.takeBudget(actor, 'acquisition', today)]);
    await expect(store.takeBudget(actor, 'search', today)).rejects.toBeInstanceOf(ReaderImportBudgetExceeded);
    await expect(store.takeBudget(actor, 'acquisition', today)).rejects.toBeInstanceOf(ReaderImportBudgetExceeded);
    await store.takeBudget(actor, 'search', new Date('2026-09-29T00:00:00Z'));
    await store.takeBudget(nativeId(), 'acquisition', today);
  } finally { await h.close(); }
}, 120_000);

test('G428: a reviewed batch keeps each row outcome and command plan across a store restart', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const directory = join(resolve(import.meta.dir, '../../..'), '.temp', `library-batch-${randomUUID()}`);
  const h = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const agent = nativeId(), key = `review-${randomUUID()}`, digest = 'a'.repeat(64);
    const first = new ReaderLibraryImportStore(h.pool);
    await first.beginBatch(agent, key, digest, 2);
    expect(await first.planStep(agent, key, 0, 'status', { expectedVersion: 3 }))
      .toEqual({ plan: { expectedVersion: 3 }, completed: false });
    await first.completeStep(agent, key, 0, 'status');
    await first.recordOutcome(agent, key, 0, { work: nativeId(), applied: ['status'], issues: [] });
    const resumed = new ReaderLibraryImportStore(h.pool);
    await resumed.beginBatch(agent, key, digest, 2);
    expect(await resumed.planStep(agent, key, 0, 'status', { expectedVersion: 99 }))
      .toEqual({ plan: { expectedVersion: 3 }, completed: true });
    expect([...await resumed.outcomes(agent, key)]).toMatchObject([[0, { applied: ['status'], issues: [] }]]);
    await expect(resumed.beginBatch(agent, key, 'b'.repeat(64), 2))
      .rejects.toBeInstanceOf(ReaderImportConflict);
  } finally { await h.close(); }
}, 120_000);
