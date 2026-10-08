import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryFileStore, importDigest } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { LibraryBundleExporter } from '../../../services/main/src/modules/library-export/bundle.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { emptyRow, type CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startHomeStack } from './feed-read-support.ts';
import { pollLibraryImportApply } from './library-import-apply-support.ts';
import { loadVndbSlice, seededReleasePlan } from '../../fixtures/vndb/load.ts';

type Page = { profile: 'rezics-library-export-v1'; rows: CanonicalRow[]; nextCursor: string | null; snapshot: string };
type ImportPage = { rows: Array<{ index: number; source: CanonicalRow; match: { kind: string; work: string | null };
  version: number; outcome: { issues: string[] } | null }>; nextCursor: number | null };
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/library-exports/${name}`,import.meta.url),'utf8');
async function checked<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G-854: API review, own-person denial, private retention, interrupted apply and resumable complete bundle re-import', async () => {
  const began = Date.now(), home = await startHomeStack('g-854-bundle');
  try {
    const { stack } = home;
    const agent = await home.provision('Import reader',home.reader.token);
    const other = await home.provision('Fresh import reader',home.author.token);
    const files = new LibraryFileStore(stack.contentPool), imports = new ReaderLibraryImportStore(stack.contentPool);
    // Review retains a match only when the caller's login includes library write.
    // Each person who imports carries that consent; no other principal does.
    for (const token of [home.reader.token,home.author.token]) {
      const login = await home.deps.account.verify(new Request('http://main.local/login',{
        headers: { authorization: `Bearer ${token}` } }));
      const principal = await login.currentAssertion?.();
      if (!principal) throw new Error('Import reader has no login principal');
      Object.assign(principal,{ accountScopes: ['work:read','library:write'] });
    }
    const app = createMainApp(stack.fuseki,{ ...home.deps,libraryFiles: files,libraryImport: imports,
      mcp: { issuer: 'https://account.test/api/auth',resource: 'http://main.local' },
      accessPolicy: new AccessPolicyOwner(stack.accessPool),
      libraryBundle: new LibraryBundleExporter(stack.contentPool,stack.accessPool),
      libraryRatings: new ReaderLibraryRatings(stack.accessPool),
      sessions: new ConsumptionSessionStore(stack.contentPool,home.deps.libraryStatus) });
    imports.setDispatch(request => app.handle(request));
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = home.reader.token) => app.handle(
      new Request(`http://main.local${path}`,{ method,headers: { authorization: `Bearer ${token}`,'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },...(body ? { body: JSON.stringify(body) } : {}) }));
    const create = (format: string,file: string,mapping?: object,key = randomUUID(),actor = agent,token = home.reader.token) =>
      call('POST','/v1/me/library-imports',{ actingSubject: actor,format,file,...(mapping ? { mapping } : {}) },key,token);
    const createViaMcp = async (format: string,file: string) => {
      const key = randomUUID();
      const response = await app.handle(new Request('http://main.local/mcp',{ method: 'POST',headers: {
        authorization: `Bearer ${home.reader.token}`,'content-type': 'application/json',accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28','mcp-method': 'tools/call','mcp-name': 'library_import_create' },body: JSON.stringify({
        jsonrpc: '2.0',id: 1,method: 'tools/call',params: { name: 'library_import_create',arguments: {
          headers: { 'Idempotency-Key': key },body: { actingSubject: agent,format,file } },_meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'g854',version: '1' },'io.modelcontextprotocol/clientCapabilities': {} } } }) }));
      const value = await checked<{ result: { structuredContent: { status: number; body: { id: string; total: number } } } }>(response);
      expect(value.result.structuredContent.status).toBe(201);
      return value.result.structuredContent.body;
    };
    const rows = (id: string,cursor = -1,actor = agent,token = home.reader.token) =>
      call('GET',`/v1/me/library-imports/${id}/rows?actingSubject=${encodeURIComponent(actor)}&cursor=${cursor}`,undefined,randomUUID(),token);
    const resolve = (id: string,index: number,version: number,choice: object,actor = agent,token = home.reader.token,key = randomUUID()) =>
      call('PUT',`/v1/me/library-imports/${id}/rows/${index}`,{ actingSubject: actor,expectedVersion: version,...choice },key,token);
    let ratingContext: string | null = null;
    const apply = (id: string,actor = agent,token = home.reader.token,key = randomUUID()) =>
      call('POST',`/v1/me/library-imports/${id}/apply`,{ actingSubject: actor,context: ratingContext,language: 'en' },key,token);
    const applyStatus = (id: string,actor = agent,token = home.reader.token) =>
      call('GET',`/v1/me/library-imports/${id}/apply?actingSubject=${encodeURIComponent(actor)}`,undefined,randomUUID(),token);
    const settled = (id: string,actor = agent,token = home.reader.token,deadlineMs?: number) =>
      pollLibraryImportApply(() => applyStatus(id,actor,token),{ started: apply(id,actor,token),...(deadlineMs ? { deadlineMs } : {}) });
    const exported = (actor = agent,token = home.reader.token,cursor?: string | null,snapshot?: string,limit = 20) => {
      const q = new URLSearchParams({ actingSubject: actor,limit: String(limit),...(cursor ? { cursor } : {}),...(snapshot ? { snapshot } : {}) });
      return call('GET',`/v1/me/library-export?${q}`,undefined,randomUUID(),token);
    };
    const first = await stack.publicWork(agent,['en'],'Shared Moon');
    const dropped = await stack.publicWork(agent,['en'],'Dropped Moon');
    await stack.publicWork(agent,['en'],'Shared Moon');
    const ambiguous = await checked<{ id: string }>(await create('generic-csv','Title,Note\nShared Moon,Chosen\nShared Moon,Private',
      { title: 'Title',statuses: {} }),201);
    const ambiguousRows = await checked<ImportPage>(await rows(ambiguous.id));
    expect(ambiguousRows.rows.map(r => r.match.kind)).toEqual(['ambiguous','ambiguous']);
    await checked(await resolve(ambiguous.id,0,ambiguousRows.rows[0]!.version,{ choice: 'apply',work: first.work }));
    await checked(await resolve(ambiguous.id,1,ambiguousRows.rows[1]!.version,{ choice: 'private' }));
    expect(await settled(ambiguous.id)).toMatchObject({ completed: 2,issues: 0 });
    const mapping = { title: 'Title',author: 'Author',status: 'Status',progress: 'Progress',startedOn: 'Started',finishedOn: 'Finished',
      statuses: { Reading: 'reading',Dropped: 'dnf' } };
    const before = (await stack.contentPool.query('SELECT count(*)::integer AS n FROM reader.library_import_file')).rows[0].n;
    expect((await create('mal','<myanimelist/>')).status).toBe(400);
    expect((await create('vndb','<vndb-export version="1.0"><vn></vndb-export>')).status).toBe(400);
    expect(await checked<{ headers: string[] }>(await create('generic-csv',fixture('novelupdates.csv')))).toHaveProperty('headers');
    expect((await stack.contentPool.query('SELECT count(*)::integer AS n FROM reader.library_import_file')).rows[0].n).toBe(before);
    const createKey = randomUUID();
    const file = await checked<{ id: string; total: number }>(await create('generic-csv',fixture('novelupdates.csv'),mapping,createKey),201);
    expect(await checked(await create('generic-csv',fixture('novelupdates.csv'),mapping,createKey),201)).toEqual(file);
    expect((await create('generic-csv',fixture('novelupdates.csv')+'\nExtra Moon,,,,,,',mapping,createKey)).status).toBe(409);
    expect((await rows(file.id,-1,agent,home.author.token)).status).toBe(403);
    expect((await resolve(file.id,0,1,{ choice: 'apply',work: first.work,target: dropped.work })).status).toBe(400);
    await checked(await call('PUT',`/v1/works/${first.work.slice(-36)}/reader-status`,{ actingSubject: agent,
      expectedVersion: 0,status: 'read',startedOn: '2025-01-01',finishedOn: '2025-03-01' }));
    // Explicit reader review works even when the public search index is rebuilding.
    await checked(await resolve(file.id,0,1,{ choice: 'apply',work: first.work,conflictChoice: 'replace' }));
    await checked(await resolve(file.id,1,1,{ choice: 'apply',work: dropped.work }));
    expect((await resolve(file.id,0,1,{ choice: 'private' })).status).toBe(409);
    expect(await settled(file.id)).toMatchObject({ pending: false,completed: 2,issues: 0 });
    expect(await settled(file.id)).toMatchObject({ pending: false,completed: 2 });
    expect((await resolve(file.id,0,2,{ choice: 'private' })).status).toBe(409);
    const source = (await stack.contentPool.query(`SELECT s.source FROM reader.library_import_source_row r JOIN reader.library_import_source s ON s.agent=r.agent AND s.digest=r.source_digest WHERE r.agent=$1 AND r.file_id=$2 ORDER BY r.row_number`,[agent,file.id])).rows;
    expect(source[0].source.raw).toMatchObject({ Progress: 'c123',Translator: 'Private fan group' });
    let sessions = (await stack.contentPool.query(`SELECT state FROM reader.consumption_session WHERE agent=$1 ORDER BY attempt_order`,[agent])).rows.map(r => r.state);
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({ state: 'finished',startedOn: '2025-01-01',finishedOn: '2025-03-01' });
    expect(sessions[1]).toMatchObject({ state: 'active',startedOn: '2026-09-01',locators: [] });
    expect(sessions[2]).toMatchObject({ state: 'dnf',startedOn: '2026-08',finishedOn: '2026-09',locators: [] });
    expect((await home.deps.libraryStatus.batch(agent,[first.work]))[0]).toMatchObject({ status: 'reading',startedOn: '2026-09-01' });

    const mal = await checked<{ id: string; total: number }>(await create('mal',fixture('mal-manga.xml')),201);
    expect(mal.total).toBe(5);
    const malRows = await checked<ImportPage>(await rows(mal.id));
    expect(malRows.rows.filter(r => r.source.kind === 'source').map(r => r.match.kind)).toEqual(['ambiguous','ambiguous','matched']);
    await checked(await resolve(mal.id,1,malRows.rows[1]!.version,{ choice: 'apply',work: first.work,conflictChoice: 'replace' }));
    await checked(await resolve(mal.id,2,malRows.rows[2]!.version,{ choice: 'private' }));
    await checked(await resolve(mal.id,3,malRows.rows[3]!.version,{ choice: 'apply',work: dropped.work }));
    expect(await settled(mal.id)).toMatchObject({ completed: 5,issues: 0,pending: false });
    const malSessions = (await stack.contentPool.query('SELECT state FROM reader.consumption_session WHERE agent=$1 ORDER BY attempt_order',[agent])).rows.map(r => r.state);
    expect(malSessions).toHaveLength(5);
    expect(malSessions.at(-2)).toMatchObject({ state: 'paused',startedOn: '2026-08',finishedOn: null,locators: [] });
    expect(malSessions.at(-1)).toMatchObject({ state: 'dnf',startedOn: '2026-07',finishedOn: '2026-08',locators: [] });
    expect((await home.deps.libraryStatus.privateReviews(agent,[first.work]))[0]).toMatchObject({ text: 'Remember the chapter & translator' });
    expect((await stack.accessPool.query('SELECT count(*)::integer AS n FROM access.rating_aggregate_head')).rows[0].n).toBe(0);

    // Anime shares the adapter but has no chapter/page correspondence. Keeping
    // its unmatched source private does not fabricate an attempt or catalogue.
    const anime = await checked<{ id: string }>(await create('mal',fixture('mal-anime.xml')),201);
    const animeRows = await checked<ImportPage>(await rows(anime.id));
    for (const r of animeRows.rows.filter(r => r.source.kind === 'source')) {
      await checked(await resolve(anime.id,r.index,r.version,{ choice: 'private' }));
    }
    expect(await settled(anime.id)).toMatchObject({ completed: 4,issues: 0,pending: false });
    expect((await stack.contentPool.query('SELECT count(*)::integer AS n FROM reader.consumption_session WHERE agent=$1',[agent])).rows[0].n).toBe(5);

    const grant = async (scope: string,action: string,actor: string,principalId: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING',[scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now()+interval '1 hour')`,[randomUUID(),principalId,actor,action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now()+interval '1 hour')`,[randomUUID(),actor,scope,action]);
    };
    await grant(GLOBAL_CONTEXT_SCOPE,'rating.context.create',agent,home.reader.principalId);
    ratingContext = (await checked<{ context: string }>(await call('POST','/v1/global-rating-contexts',{
      profile: 'global-rating-standing-context-v1',question: 'Library quality',actingSubject: agent }),201)).context;
    await grant(`rating:observe:${ratingContext}`,'rating.observation.set',agent,home.reader.principalId);
    await grant(`rating:observe:${ratingContext}`,'rating.observation.set',other,home.author.principalId);

    // The same recorded VN/release identifier pairs used by G-852's pinned
    // slice, installed through catalogue APIs before any personal import.
    const releasePlan = seededReleasePlan(loadVndbSlice());
    for (const [vn,work] of [['v17',first.work],['v24',dropped.work]] as const) {
      await grant(`work:edit:${work}`,'work.edit',agent,home.reader.principalId);
      const planned = releasePlan.releases.find(r => r.vn === vn)!;
      expect(planned).toBeDefined();
      const realization = `https://rezics.com/id/${randomUUID()}`;
      const saved = await checked<{ revision: string }>(await call('PUT',`/v1/works/${work.slice(-36)}/realizations/${realization.slice(-36)}`,{
        profile: 'realization-v1',expectedHead: null,actingSubject: agent,id: realization,language: planned.coverage[0]!.language,
        kind: 'original',translators: [],publishers: [agent],source: { kind: 'unresolved',work },
        status: 'official',verification: 'verified',evidence: `https://vndb.org/${vn}` }));
      for (const isbn13 of vn === 'v17' ? ['9780306406157','9780140328721'] : [null]) {
        const release = `https://rezics.com/id/${randomUUID()}`;
        await checked(await call('PUT',`/v1/works/${work.slice(-36)}/releases/${release.slice(-36)}`,{
          profile: 'release-v2',expectedHead: null,actingSubject: agent,id: release,kind: 'formal',
          status: planned.official ? 'official' : 'unofficial',title: planned.title,titleLanguage: planned.title.language,
          tracklistLanguage: null,editionStatement: null,publisher: null,publicationYear: planned.publicationYear,
          isbn13,originalUrl: null,fixedRelease: null,evidence: null,platform: planned.platform,territory: null,
          identifiers: [{ provider: 'https://vndb.org/vn',value: vn },{ provider: 'https://vndb.org/release',value: planned.id }],
          coverage: [{ realization,revision: saved.revision,completeness: planned.coverage[0]!.completeness }] }));
      }
    }

    const goodreads = await checked<{ id: string }>(await create('goodreads',fixture('goodreads.csv')),201);
    const matchedBooks = await checked<ImportPage>(await rows(goodreads.id));
    expect(matchedBooks.rows[0]!.match).toMatchObject({ kind: 'matched',work: first.work });
    expect(matchedBooks.rows[2]!.match).toMatchObject({ kind: 'matched',work: first.work });
    const reviewKey = randomUUID();
    await checked(await resolve(goodreads.id,0,2,{ choice: 'apply',work: first.work,conflictChoice: 'replace' },agent,home.reader.token,reviewKey));
    await checked(await resolve(goodreads.id,0,2,{ choice: 'apply',work: first.work,conflictChoice: 'replace' },agent,home.reader.token,reviewKey));
    expect((await resolve(goodreads.id,0,2,{ choice: 'private' },agent,home.reader.token,reviewKey)).status).toBe(409);
    await checked(await resolve(goodreads.id,1,2,{ choice: 'apply',work: dropped.work }));
    await checked(await resolve(goodreads.id,2,2,{ choice: 'apply',work: first.work,conflictChoice: 'keep' }));
    expect(await settled(goodreads.id)).toMatchObject({ issues: 0,pending: false });
    const reviewed = await home.deps.libraryStatus.privateReviews(agent,[first.work]);
    expect(reviewed[0]).toMatchObject({ text: 'Remember this',language: 'en',spoiler: false });
    const storygraph = await checked<{ id: string }>(await create('storygraph',fixture('storygraph.csv')),201);
    await checked(await resolve(storygraph.id,0,1,{ choice: 'apply',work: first.work,conflictChoice: 'replace' }));
    expect(await settled(storygraph.id)).toMatchObject({ issues: 0 });
    const quarterStars = (await stack.contentPool.query('SELECT s.source FROM reader.library_import_source_row r JOIN reader.library_import_source s ON s.agent=r.agent AND s.digest=r.source_digest WHERE r.agent=$1 AND r.file_id=$2',[agent,storygraph.id])).rows[0].source;
    expect(quarterStars.score).toEqual({ value: 3.5,min: 0.25,max: 5,step: 0.25 });
    expect((await stack.accessPool.query('SELECT count(*)::integer AS n FROM access.rating_aggregate_head')).rows[0].n).toBe(1);
    const vndb = await checked<{ id: string }>(await create('vndb',fixture('vndb.xml')),201);
    const matchedVns = await checked<ImportPage>(await rows(vndb.id));
    expect(matchedVns.rows[0]!.match).toMatchObject({ kind: 'matched',work: first.work,target: null });
    expect(matchedVns.rows[1]!.match).toMatchObject({ kind: 'matched',work: dropped.work,target: null });
    await checked(await resolve(vndb.id,0,2,{ choice: 'apply',work: first.work,conflictChoice: 'replace' }));
    await checked(await resolve(vndb.id,1,2,{ choice: 'apply',work: dropped.work }));
    await checked(await resolve(vndb.id,5,2,{ choice: 'apply',work: first.work,conflictChoice: 'replace' }));
    await checked(await rows(vndb.id));
    expect(await settled(vndb.id)).toMatchObject({ issues: 0,pending: false });
    expect((await home.deps.libraryStatus.privateReviews(agent,[first.work]))[0]).toMatchObject({ text: 'Private imported review',spoiler: true });
    sessions = (await stack.contentPool.query('SELECT state FROM reader.consumption_session WHERE agent=$1 ORDER BY attempt_order',[agent])).rows.map(r => r.state);
    expect(sessions.filter(s => s.state === 'finished')).toHaveLength(2);
    expect(sessions.at(-1)).toMatchObject({ state: 'paused',startedOn: '2026-09-01' });
    const extension = { ...emptyRow('native-private-extra','',{ privateJournal: { chapter: 'c123',note: 'Retain this' } }),
      kind: 'session' as const,work: first.work,session: { target: first.work,state: 'planned' as const,
        startedOn: null,finishedOn: null,selections: [{ target: first.work }],locators: [] } };
    const extra = await checked<{ id: string }>(await create('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [extension] })),201);
    await checked(await rows(extra.id));
    expect(await settled(extra.id)).toMatchObject({ issues: 0,pending: false });
    sessions = (await stack.contentPool.query('SELECT state FROM reader.consumption_session WHERE agent=$1 ORDER BY attempt_order',[agent])).rows.map(r => r.state);
    const firstState = (await home.deps.libraryStatus.batch(agent,[first.work]))[0]!;
    await checked(await call('PUT',`/v1/works/${first.work.slice(-36)}/reader-status`,{ actingSubject: agent,
      expectedVersion: firstState.version,status: 'want-to-read',startedOn: firstState.startedOn,finishedOn: firstState.finishedOn }));
    const observation = { profile: 'global-rating-standing-observation-v1',context: ratingContext,work: dropped.work,
      mainVersion: dropped.mainVersion,actingSubject: agent };
    const prior = await checked<{ observationRevision: string }>(await call('POST','/v1/global-rating-observations',{
      ...observation,expectedRevisionHead: null,value: 3 }),201);
    await checked(await call('POST','/v1/global-rating-observations',{
      ...observation,expectedRevisionHead: prior.observationRevision,value: null }),201);
    const sourceCount = (await stack.contentPool.query('SELECT count(*)::integer AS n FROM reader.library_import_source_row WHERE agent=$1',[agent])).rows[0].n;

    // More source entries than every page bound, including private unmatched ones.
    const retained = Array.from({ length: 1200 },(_,i) => ({ ...emptyRow(`unmatched-${i}`,`Private title ${i}`,{ progress: `c${i}`,extra: `private-${i}` }),kind: 'retained' as const }));
    const large = await checked<{ id: string }>(await create('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: retained })),201);
    let cursor = -1;
    do { const page = await checked<ImportPage>(await rows(large.id,cursor)); cursor = page.nextCursor ?? -1; } while (cursor !== -1);
    const applyKey = randomUUID();
    const acceptedResponse = await apply(large.id,agent,home.reader.token,applyKey);
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json();
    expect(accepted).toMatchObject({ pending: true });
    // Lost response + concurrent retries replay the acceptance receipt and apply each row once.
    const replies = await Promise.all([apply(large.id,agent,home.reader.token,applyKey),apply(large.id,agent,home.reader.token,applyKey)]);
    expect(await Promise.all(replies.map(async reply => {
      expect(reply.status).toBe(202);
      return reply.json();
    }))).toEqual([accepted,accepted]);
    // Retained rows advance one page per worker tick, and each tick waits a second.
    const progress = await pollLibraryImportApply(() => applyStatus(large.id),{ deadlineMs: 300_000 });
    expect(progress).toMatchObject({ pending: false,issues: 0 });
    expect((await stack.contentPool.query(`SELECT count(*)::integer AS n FROM reader.consumption_session WHERE agent=$1`,[agent])).rows[0].n).toBe(sessions.length);
    expect(Date.now()-began).toBeLessThan(600_000);

    // A valid large private record must download and import without lowering the
    // requested row count manually. Three records force the byte page boundary.
    for (let index = 0; index < 3; index++) {
      const row = { ...emptyRow(`wide-${index}`,'', { evidence: 'x'.repeat(index === 0 ? 1_100_000 : 700_000) }),kind: 'retained' as const };
      const bundle = JSON.stringify({ profile: 'rezics-library-export-v1',rows: [row] });
      const wide = index === 0 ? await createViaMcp('rezics',bundle)
        : await checked<{ id: string }>(await create('rezics',bundle),201);
      await checked(await rows(wide.id));
      expect(await settled(wide.id)).toMatchObject({ issues: 0,pending: false });
    }

    // Put the explicit Library statement in a later uploaded page than sessions.
    const firstPage = await checked<Page>(await exported(agent,home.reader.token,undefined,undefined,2));
    expect(firstPage.nextCursor).not.toBeNull();
    const resumed = await checked<Page>(await exported(agent,home.reader.token,firstPage.nextCursor,firstPage.snapshot));
    expect(resumed.rows).toEqual((await checked<Page>(await exported(agent,home.reader.token,firstPage.nextCursor,firstPage.snapshot))).rows);
    expect(resumed.snapshot).toBe(firstPage.snapshot);
    expect((await exported(other,home.author.token,firstPage.nextCursor,firstPage.snapshot)).status).toBe(400);
    const pages = [firstPage],all = [...firstPage.rows]; let next = firstPage.nextCursor;
    while (next) { const page = await checked<Page>(await exported(agent,home.reader.token,next,firstPage.snapshot));
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2*1024*1024);
      pages.push(page); all.push(...page.rows); next = page.nextCursor; }
    expect(all.filter(r => r.kind === 'retained')).toHaveLength(1200+sourceCount+4);
    expect(all.find(r => r.sourceId.startsWith('rating:') && r.kind === 'retained')?.raw.ratingAvailability).toBe('withdrawn');
    expect(all.find(r => r.raw.sourceId === 'native-private-extra')?.raw.fields).toEqual(extension.raw);
    expect(all.filter(r => r.kind === 'session')).toHaveLength(sessions.length);
    for (const page of pages) {
      const restored = await checked<{ id: string }>(await create('rezics',JSON.stringify(page),undefined,randomUUID(),other,home.author.token),201);
      cursor = -1;
      do { const review = await checked<ImportPage>(await rows(restored.id,cursor,other,home.author.token)); cursor = review.nextCursor ?? -1; } while (cursor !== -1);
      const progress = await settled(restored.id,other,home.author.token);
      expect(progress.issues).toBe(0);
    }
    const normalize = (state: { state: string; startedOn: string | null; finishedOn: string | null; locators: unknown[] }) =>
      [state.state,state.startedOn,state.finishedOn,state.locators];
    const restoredSessions = (await stack.contentPool.query('SELECT state FROM reader.consumption_session WHERE agent=$1 ORDER BY attempt_order',[other])).rows.map(r => r.state);
    expect(restoredSessions.map(normalize)).toEqual(sessions.map(normalize));
    const originalStatuses = (await home.deps.libraryStatus.batch(agent,[first.work,dropped.work])).map(s => [s.work,s.status,s.startedOn,s.finishedOn]);
    expect((await home.deps.libraryStatus.batch(other,[first.work,dropped.work])).map(s => [s.work,s.status,s.startedOn,s.finishedOn])).toEqual(originalStatuses);
    const copiedReview = (await home.deps.libraryStatus.privateReviews(other,[first.work]))[0];
    expect(copiedReview).toMatchObject({ text: 'Private imported review',language: 'en',spoiler: true });
    expect((await stack.accessPool.query('SELECT count(*)::integer AS n FROM access.rating_aggregate_head')).rows[0].n).toBe(3);
    const shelvesOf = (rows: CanonicalRow[]) => rows.filter(r => r.kind === 'shelf').map(r => [r.title,r.raw.disclosure]).sort();
    const copy: CanonicalRow[] = []; next = null; let snapshot: string | undefined;
    do { const page = await checked<Page>(await exported(other,home.author.token,next,snapshot)); snapshot ??= page.snapshot;
      copy.push(...page.rows); next = page.nextCursor; } while (next);
    expect(shelvesOf(copy)).toEqual(shelvesOf(all));
    expect(copy.filter(r => r.kind === 'retained').map(importDigest).sort()).toEqual(all.filter(r => r.kind === 'retained').map(importDigest).sort());
    const kept = await checked<{ id: string }>(await create('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [
      { ...emptyRow('legacy-keep','',{ sessionProjection: null }),kind: 'entry',work: first.work,status: 'read' } ] }),
    undefined,randomUUID(),other,home.author.token),201);
    await checked(await resolve(kept.id,0,1,{ choice: 'apply',work: first.work,conflictChoice: 'keep' },other,home.author.token));
    expect(await settled(kept.id,other,home.author.token)).toMatchObject({ pending: false,issues: 0 });
    expect((await stack.contentPool.query('SELECT count(*)::integer AS n FROM reader.consumption_session WHERE agent=$1',[other])).rows[0].n).toBe(sessions.length);
    expect((await home.deps.libraryStatus.batch(other,[first.work]))[0]!.status).toBe('want-to-read');
    await home.deps.libraryStatus.putPrivateReview({ agent,work: first.work,text: 'Later private review',language: 'en',spoiler: true,
      expectedVersion: (await home.deps.libraryStatus.privateReviews(agent,[first.work]))[0]!.version,idempotencyKey: randomUUID() });
    expect((await exported(agent,home.reader.token,firstPage.nextCursor,firstPage.snapshot)).status).toBe(409);
  } finally { await home.stop(); }
},600_000);
