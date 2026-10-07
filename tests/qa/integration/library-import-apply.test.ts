import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { startHomeStack } from './feed-read-support.ts';

test('G428: a reviewed Goodreads apply finishes all rows through ordinary owner commands', async () => {
  const home = await startHomeStack('library-import-apply');
  try {
    const { stack } = home;
    const agent = await home.provision('Library import reader', home.reader.token);
    const first = await stack.publicWork(agent, ['en'], 'Shared Moon');
    const second = await stack.publicWork(agent, ['en'], 'Dropped Moon');
    const files = new LibraryFileStore(stack.contentPool);
    const imports = new ReaderLibraryImportStore(stack.contentPool);
    const deps = { ...home.deps, libraryFiles: files, libraryImport: imports,
      sessions: new ConsumptionSessionStore(stack.contentPool, home.deps.libraryStatus),
      libraryRatings: new ReaderLibraryRatings(stack.accessPool), accessPolicy: new AccessPolicyOwner(stack.accessPool) };
    let app = createMainApp(stack.fuseki, deps);
    const dispatched: string[] = [];
    let refuseShelfReads = false;
    imports.setDispatch(async request => {
      const response = refuseShelfReads && request.method === 'GET' && new URL(request.url).pathname.startsWith('/v1/collections/')
        ? Response.json({ code: 'collection_unavailable' }, { status: 404 }) : await app.handle(request);
      dispatched.push(`${request.method} ${new URL(request.url).pathname}: ${response.status}${response.ok ? '' : ` ${await response.clone().text()}`}`);
      return response;
    });
    const call = (method: string, path: string, body?: object) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${home.reader.token}`, 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const checked = async <T>(response: Response, status = 200): Promise<T> => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}\n${dispatched.join('\n')}`);
      return response.json() as Promise<T>;
    };
    const file = readFileSync(new URL('../../fixtures/library-exports/goodreads.csv', import.meta.url), 'utf8');
    const upload = await checked<{ id: string; total: number }>(await call('POST', '/v1/me/library-imports', {
      actingSubject: agent, format: 'goodreads', file }), 201);
    expect(upload.total).toBe(3);
    for (const [index, work] of [first.work, second.work, first.work].entries()) {
      await checked(await call('PUT', `/v1/me/library-imports/${upload.id}/rows/${index}`, {
        actingSubject: agent, expectedVersion: 1, choice: 'apply', work }));
    }
    let progress: { completed: number; pending: boolean } | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await call('POST', `/v1/me/library-imports/${upload.id}/apply`, {
        actingSubject: agent, context: null, language: 'en' });
      if (![200, 202].includes(response.status)) throw new Error(`${response.status}: ${await response.text()}\n${dispatched.join('\n')}`);
      progress = await response.json() as typeof progress;
      if (!progress?.pending) break;
    }
    expect(progress, dispatched.join('\n')).toMatchObject({ completed: 3, pending: false });

    // A missing owner read must be a real refusal, never a 202 that claims
    // work is advancing. Simulate it so this guard survives owner fixes.
    refuseShelfReads = true;
    const blocked = await checked<{ id: string }>(await call('POST', '/v1/me/library-imports', {
      actingSubject: agent, format: 'goodreads', file: file.replace('favorites, reread', 'new-private-shelf') }), 201);
    for (const [index, work] of [first.work, second.work, first.work].entries()) {
      await checked(await call('PUT', `/v1/me/library-imports/${blocked.id}/rows/${index}`, {
        actingSubject: agent, expectedVersion: 1, choice: 'apply', work }));
    }
    const apply = () => call('POST', `/v1/me/library-imports/${blocked.id}/apply`, {
      actingSubject: agent, context: null, language: 'en' });
    const refused = await apply();
    const refusal = await checked<{ code: string; title: string }>(refused, 503);
    expect(refusal).toMatchObject({ code: 'library_import_unavailable', title: 'Library import owner read was refused (404)' });
    expect(await files.progress(agent, blocked.id)).toMatchObject({ completed: 0, pending: true });
    expect(dispatched.some(value => /GET \/v1\/collections\/[^:]+: 404/.test(value))).toBe(true);
    // Owner recovery resumes the same planned command without losing the source
    // or treating the shelf's 404 as a missing upload.
    refuseShelfReads = false;
    expect(await checked(await apply())).toMatchObject({ completed: 3, pending: false });

    // The HTTP composition supplies this batch reader; fixtures that omit it
    // must not conceal a private-curator disclosure regression.
    app = createMainApp(stack.fuseki, { ...deps, mediaAccess: new MediaAccessBatchReader(stack.accessPool, stack.fuseki) });
    const production = await checked<{ id: string }>(await call('POST', '/v1/me/library-imports', {
      actingSubject: agent, format: 'goodreads', file: file.replace('favorites, reread', 'production-private-shelf') }), 201);
    for (const [index, work] of [first.work, second.work, first.work].entries()) {
      await checked(await call('PUT', `/v1/me/library-imports/${production.id}/rows/${index}`, {
        actingSubject: agent, expectedVersion: 1, choice: 'apply', work }));
    }
    expect(await checked(await call('POST', `/v1/me/library-imports/${production.id}/apply`, {
      actingSubject: agent, context: null, language: 'en' }))).toMatchObject({ completed: 3, pending: false });
  } finally { await home.stop(); }
}, 180_000);
