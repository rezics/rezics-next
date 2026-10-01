import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { LibraryBundleExporter } from '../../../services/main/src/modules/library-export/bundle.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { LibraryImportRetentionWorker } from '../../../services/main/src/modules/library-import/retention-worker.ts';
import { rateLimitBudgets } from '../../../services/main/src/modules/rate-limit/budgets.ts';
import { emptyRow, type CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startHomeStack } from './feed-read-support.ts';

type Page = { profile: 'rezics-library-export-v1'; rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
async function checked<T>(response: Response,status = 200): Promise<T> {
  if (response.status!==status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G-854 review: replay uses actual attempts, 4xx rows continue, upload deletion/expiry/erasure remove private evidence, and unrelated writes preserve cursors', async () => {
  const home = await startHomeStack('g-854-review');
  try {
    const { stack } = home;
    const agent = await home.provision('Review reader',home.reader.token), other = await home.provision('Other reader',home.author.token);
    const files = new LibraryFileStore(stack.contentPool), imports = new ReaderLibraryImportStore(stack.contentPool);
    const app = createMainApp(stack.fuseki,{ ...home.deps,libraryFiles: files,libraryImport: imports,
      libraryBundle: new LibraryBundleExporter(stack.contentPool,stack.accessPool),libraryRatings: new ReaderLibraryRatings(stack.accessPool),
      sessions: new ConsumptionSessionStore(stack.contentPool,home.deps.libraryStatus),
      rateLimit: { budgets: rateLimitBudgets(),options: { secret: 'g854-review-counter-secret-at-least-32-characters',
        serviceClientIds: new Set(),trustedProxyPeers: new Set(),clientIpHeader: 'x-forwarded-for' },store: {
          classify: async () => 'member',consume: async () => ({ allowed: true,retryAfter: 60 }) } } });
    imports.setDispatch(request => app.handle(request));
    const call = (method: string,path: string,body?: object,key = randomUUID(),token = home.reader.token) => app.handle(new Request(`http://main.local${path}`,{
      method,headers: { authorization: `Bearer ${token}`,'idempotency-key': key,...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const upload = async (rows: CanonicalRow[],key = randomUUID(),whitespace = '',actor = agent,token = home.reader.token) =>
      checked<{ id: string }>(await call('POST','/v1/me/library-imports',{ actingSubject: actor,format: 'rezics',file: JSON.stringify({ profile: 'rezics-library-export-v1',rows })+whitespace },key,token),201);
    // Explicit choices exercise ordinary authorization without relying on indexing readiness.
    const resolve = async (id: string,rows: CanonicalRow[],actor = agent,token = home.reader.token) => {
      for (const [index,row] of rows.entries()) await checked(await call('PUT',`/v1/me/library-imports/${id}/rows/${index}`,{
        actingSubject: actor,expectedVersion: 1,...(row.work ? { choice: 'apply',work: row.work,conflictChoice: 'replace' } : { choice: 'private' }) },randomUUID(),token));
    };
    const apply = (id: string,actor = agent,token = home.reader.token) => call('POST',`/v1/me/library-imports/${id}/apply`,{ actingSubject: actor,context: null,language: 'en' },randomUUID(),token);
    const sessions = async (actor = agent) => (await stack.contentPool.query('SELECT state FROM reader.consumption_session WHERE agent=$1 ORDER BY attempt_order',[actor])).rows.map(row => row.state);
    const exported = (cursor?: string | null,snapshot?: string) => call('GET',`/v1/me/library-export?${new URLSearchParams({ actingSubject: agent,limit: '1',...(cursor ? { cursor } : {}),...(snapshot ? { snapshot } : {}) })}`);
    const book = await stack.publicWork(agent,['en'],'Review book');
    const animeXml = readFileSync(new URL('../../fixtures/library-exports/mal-anime.xml',import.meta.url),'utf8');
    const template = animeXml.match(/<anime>[\s\S]*?<\/anime>/)![0];
    const largeMal = `<myanimelist>${Array.from({ length: 2000 },(_,i) => template.replace(/<series_animedb_id>[^<]+/,`<series_animedb_id>${i+1}`)).join('')}</myanimelist>`;
    expect(Buffer.byteLength(largeMal)).toBeLessThan(2*1024*1024);
    const largeMalUpload = await checked<{ id: string; total: number }>(await call('POST','/v1/me/library-imports',{
      actingSubject: agent,format: 'mal',file: largeMal }),201);
    expect(largeMalUpload.total).toBe(2001);
    await checked(await call('DELETE',`/v1/me/library-imports/${largeMalUpload.id}?actingSubject=${encodeURIComponent(agent)}`));
    const finished: CanonicalRow = { ...emptyRow('external:one','Review book',{ privateNote: 'Keep private' }),work: book.work,status: 'read',startedOn: '2026-01-01',finishedOn: '2026-02-01' };
    const initial = await upload([finished]);await resolve(initial.id,[finished]);
    expect(await checked(await apply(initial.id))).toMatchObject({ pending: false,issues: 0 });
    expect((await sessions()).length).toBe(1);
    expect((await upload([finished])).id).toBe(initial.id);
    expect(await checked(await apply(initial.id))).toMatchObject({ completed: 1 });
    const rewritten = await upload([finished],randomUUID(),'\n');await resolve(rewritten.id,[finished]);
    await checked(await apply(rewritten.id));expect((await sessions()).length).toBe(1);
    expect((await stack.contentPool.query('SELECT count(*)::integer AS n FROM reader.library_import_source WHERE agent=$1',[agent])).rows[0].n).toBe(1);
    // A completed legacy statement with different dates survives importing a read.
    const legacyBook = await stack.publicWork(other,['en'],'Legacy completion');
    await checked(await call('PUT',`/v1/works/${legacyBook.work.slice(-36)}/reader-status`,{ actingSubject: other,
      expectedVersion: 0,status: 'read',startedOn: '2020-01-01',finishedOn: '2020-02-01' },randomUUID(),home.author.token));
    const reread = { ...finished,sourceId: 'legacy-reread',work: legacyBook.work };
    const legacyUpload = await upload([reread],randomUUID(),'',other,home.author.token);
    await resolve(legacyUpload.id,[reread],other,home.author.token);await checked(await apply(legacyUpload.id,other,home.author.token));
    expect((await sessions(other)).map(state => [state.startedOn,state.finishedOn])).toEqual([
      ['2020-01-01','2020-02-01'],['2026-01-01','2026-02-01'] ]);
    await checked(await call('POST','/v1/collections',{ actingSubject: agent,collection: `https://rezics.com/id/${randomUUID()}`,
      name: 'Replay shelf',disclosure: 'private' }),201);
    const first = await checked<Page>(await exported());
    expect(first.nextCursor).not.toBeNull();
    await stack.publicWork(other,['en'],'Unrelated catalogue write');
    await checked(await call('PUT',`/v1/works/${book.work.slice(-36)}/reader-status`,{ actingSubject: other,expectedVersion: 0,status: 'want-to-read',startedOn: null,finishedOn: null },randomUUID(),home.author.token));
    await checked<Page>(await exported(first.nextCursor,first.snapshot));
    const all: CanonicalRow[] = [...first.rows];let next = first.nextCursor;
    while (next) { const page = await checked<Page>(await exported(next,first.snapshot));all.push(...page.rows);next=page.nextCursor; }
    const own = await upload(all);await resolve(own.id,all);await checked(await apply(own.id));
    expect((await sessions()).length).toBe(1);
    // A portable archive may contain two real attempts with identical dates.
    const attempt = { ...emptyRow(`https://rezics.com/id/${randomUUID()}`,'',{}),kind: 'session' as const,work: book.work,
      session: { target: book.work,state: 'finished' as const,startedOn: '2024-01-01',finishedOn: '2024-02-01',selections: [{ target: book.work }],locators: [] } };
    const twins = [attempt,{ ...attempt,sourceId: `https://rezics.com/id/${randomUUID()}` }];
    const twinUpload = await upload(twins);await resolve(twinUpload.id,twins);await checked(await apply(twinUpload.id));
    expect((await sessions()).length).toBe(3);
    let workCursor: string | null = null;
    const workHistory: string[] = [];
    do {
      const page = await checked<{ items: Array<{ id: string }>; nextCursor: string | null }>(await call('GET',
        `/v1/me/sessions?${new URLSearchParams({ actingSubject: agent,work: book.work,limit: '1',...(workCursor ? { cursor: workCursor } : {}) })}`));
      workHistory.push(...page.items.map(item => item.id));workCursor=page.nextCursor;
    } while (workCursor);
    expect(new Set(workHistory).size).toBe(3);
    expect((await call('GET',`/v1/me/sessions?actingSubject=${encodeURIComponent(agent)}&work=${encodeURIComponent(book.work)}&target=${encodeURIComponent(book.work)}`)).status).toBe(400);
    const twinReplay = await upload(twins,randomUUID(),' ');await resolve(twinReplay.id,twins);await checked(await apply(twinReplay.id));
    expect((await sessions()).length).toBe(3);
    // A target belonging to another Work permanently refuses the first row.
    const alien = await stack.publicWork(other,['en'],'Alien target');
    const bad = { ...attempt,sourceId: attempt.sourceId,session: { ...attempt.session,target: alien.work } };
    const good = { ...attempt,sourceId: 'later-good',session: { ...attempt.session,state: 'paused' as const,startedOn: '2023',finishedOn: null } };
    const failed = await upload([bad,good]);await resolve(failed.id,[bad,good]);
    expect(await checked(await apply(failed.id))).toMatchObject({ completed: 2,issues: 1,pending: false });
    expect(await checked(await apply(failed.id))).toMatchObject({ completed: 2,issues: 1,pending: false });
    expect((await sessions()).length).toBe(4);
    const badOutcome = (await stack.contentPool.query('SELECT outcome FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2 AND row_number=0',[agent,failed.id])).rows[0].outcome;
    expect(badOutcome.issues).toContain('session-failed');
    const deletePath = `/v1/me/library-imports/${initial.id}?actingSubject=${encodeURIComponent(agent)}`, deleteKey = randomUUID();
    expect((await call('DELETE',deletePath,undefined,deleteKey,home.author.token)).status).toBe(403);
    await checked(await call('DELETE',deletePath,undefined,deleteKey));await checked(await call('DELETE',deletePath,undefined,deleteKey));
    expect((await call('GET',`/v1/me/library-imports/${initial.id}/rows?actingSubject=${encodeURIComponent(agent)}`)).status).toBe(404);
    const afterDelete = await upload([finished]);await resolve(afterDelete.id,[finished]);await checked(await apply(afterDelete.id));
    expect((await sessions()).length).toBe(4);
    // Expiry excludes source rows before the retention poll physically removes them.
    const expires = { ...emptyRow('expires','',{ secret: 'Expiry secret' }),kind: 'retained' as const };
    const expiring = await upload([expires]);
    await stack.contentPool.query("UPDATE reader.library_import_file SET expires_at=now()-interval '1 second' WHERE agent=$1 AND id=$2",[agent,expiring.id]);
    expect((await call('GET',`/v1/me/library-imports/${expiring.id}/rows?actingSubject=${encodeURIComponent(agent)}`)).status).toBe(404);
    const retention = new LibraryImportRetentionWorker(stack.contentPool,stack.accessPool);await retention.poll();
    expect((await stack.contentPool.query('SELECT 1 FROM reader.library_import_source WHERE agent=$1 AND source->>\'sourceId\'=$2',[agent,expires.sourceId])).rowCount).toBe(0);
    const otherUpload = await upload([expires],randomUUID(),'',other,home.author.token);
    await stack.accessPool.query('UPDATE access.principal SET active=false WHERE id=$1',[home.reader.principalId]);
    await retention.poll();
    expect((await stack.contentPool.query('SELECT 1 FROM reader.library_import_file WHERE agent=$1 LIMIT 1',[agent])).rowCount).toBe(1);
    await stack.accessPool.query(`INSERT INTO access.outbox(id,kind,principal_id,authority_epoch)
      SELECT $1,'account.deletion_fenced',id,enforcement_epoch FROM access.principal WHERE id=$2`,[randomUUID(),home.reader.principalId]);
    await retention.poll();
    for (const table of ['library_import_file','library_import_source','library_import_step','library_import_session_effect']) {
      expect((await stack.contentPool.query(`SELECT 1 FROM reader.${table} WHERE agent=$1 LIMIT 1`,[agent])).rowCount).toBe(0);
    }
    expect((await stack.contentPool.query('SELECT 1 FROM reader.library_import_file WHERE agent=$1 AND id=$2',[other,otherUpload.id])).rowCount).toBe(1);
  } finally { await home.stop(); }
},600_000);
