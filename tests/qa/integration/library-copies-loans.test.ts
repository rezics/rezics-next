import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryCopyStore, LIBRARY_RECORD_COST, LibraryRecordDenied, type CopyState } from '../../../services/main/src/modules/library/copies.ts';
import { LibraryLoanStore, type LoanState, type LoanView } from '../../../services/main/src/modules/library/loans.ts';
import { LibraryBundleExporter } from '../../../services/main/src/modules/library-export/bundle.ts';
import { LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { eraseLibraryImportsForPrincipals } from '../../../services/main/src/modules/library-import/privacy.ts';
import { parseRezics } from '../../../services/main/src/modules/library-import/formats/rezics.ts';
import type { CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startHomeStack } from './feed-read-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
type Page<T> = { items: T[]; nextCursor: string | null };
type Bundle = { profile: 'rezics-library-export-v1'; rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('private exact-release copies and overdue loans preserve replay, CAS, concurrent transitions, paging, export and erasure', async () => {
  const preparation = Date.now(), home = await startHomeStack('library-copies-loans');
  try {
    const { stack } = home;
    const agent = await home.provision('Copy owner', home.reader.token);
    const other = await home.provision('Other copy owner', home.author.token);
    const editor = await stack.member('release-editor');
    const target = await stack.publicWork(editor.actor, ['en'], 'Exact edition');
    await editor.grant(`work:edit:${target.work}`, 'work.edit');
    const release = id();
    await json(await editor.send('PUT', `/v1/works/${target.work.slice(-36)}/releases/${release.slice(-36)}`, {
      profile: 'release-v1', expectedHead: null, actingSubject: editor.actor, id: release, kind: 'formal', status: 'official',
      contentLanguages: ['en'], isTranslation: false, originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
      title: { value: 'Exact edition', language: 'en' }, editionStatement: null, publisher: null, publicationYear: null,
      isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
    }));
    const copies = new LibraryCopyStore(stack.contentPool), loans = new LibraryLoanStore(stack.contentPool);
    const imports = new ReaderLibraryImportStore(stack.contentPool);
    const app = createMainApp(stack.fuseki, { ...home.deps, libraryCopies: copies, libraryLoans: loans,
      libraryBundle: new LibraryBundleExporter(stack.contentPool, stack.accessPool),
      libraryFiles: new LibraryFileStore(stack.contentPool), libraryImport: imports });
    imports.setDispatch(request => app.handle(request));
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = home.reader.token) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: { authorization: `Bearer ${token}`,
        'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const copyBody = { actingSubject: agent, expectedVersion: 0, release, format: 'paperback',
      acquiredFrom: { kind: 'name', name: 'City Library' }, acquiredAt: '2026-01-01T08:00:00+08:00',
      ownedFrom: '2026-01-02T00:00:00Z', ownedThrough: null };
    const copyKey = randomUUID();
    const copy = await json<CopyState & { replayed: boolean }>(await call('POST', '/v1/me/library-copies', copyBody, copyKey), 201);
    expect(copy).toMatchObject({ release, work: target.work, format: 'paperback', version: 1, replayed: false,
      acquiredAt: '2026-01-01T00:00:00.000Z' });
    expect(await json(await call('POST', '/v1/me/library-copies', copyBody, copyKey), 201)).toEqual({ ...copy, replayed: true });
    expect((await call('POST', '/v1/me/library-copies', { ...copyBody, format: 'ebook' }, copyKey)).status).toBe(409);
    expect((await call('POST', '/v1/me/library-copies', { ...copyBody, release: target.work })).status).toBe(400);
    expect((await call('POST', '/v1/me/library-copies', copyBody, randomUUID(), home.author.token)).status).toBe(403);
    const copyPath = `/v1/me/library-copies/${copy.id.slice(-36)}`;
    const patch = { actingSubject: agent, expectedVersion: 1, format: 'hardcover' };
    const updated = await json<CopyState>(await call('PATCH', copyPath, patch));
    expect(updated).toMatchObject({ version: 2, format: 'hardcover', acquiredFrom: copy.acquiredFrom, ownedFrom: copy.ownedFrom });
    expect((await call('PATCH', copyPath, patch)).status).toBe(409);
    expect((await call('PATCH', copyPath, { ...patch, expectedVersion: 2 }, randomUUID(), home.author.token)).status).toBe(403);
    const copiesPath = `/v1/works/${target.work.slice(-36)}/copies?actingSubject=${encodeURIComponent(agent)}`;
    expect(await json<Page<CopyState>>(await call('GET', copiesPath))).toMatchObject({ items: [{ id: copy.id, release }], nextCursor: null });
    expect((await call('GET', copiesPath, undefined, randomUUID(), home.author.token)).status).toBe(403);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString(), startedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const dueFuture = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const loanBody = { actingSubject: agent, expectedVersion: 0, copy: copy.id, direction: 'lent',
      counterparty: { kind: 'name', name: other }, startedAt, dueAt: yesterday };
    const openKey = randomUUID();
    const loan = await json<LoanView>(await call('POST', '/v1/me/library-loans', loanBody, openKey), 201);
    expect(loan).toMatchObject({ state: 'overdue', counterparty: { kind: 'name', name: other }, version: 1 });
    expect((await call('POST', '/v1/me/library-loans', loanBody)).status).toBe(409);
    expect((await call('POST', '/v1/me/library-loans', { ...loanBody, actingSubject: other }, randomUUID(), home.author.token)).status).toBe(404);
    expect((await call('DELETE', copyPath, { actingSubject: agent, expectedVersion: 2 })).status).toBe(409);
    const loanPath = `/v1/me/library-loans/${loan.id.slice(-36)}`;
    const duePath = `/v1/me/library-loans?actingSubject=${encodeURIComponent(agent)}&state=overdue`;
    const dueResponse = await call('GET', duePath);
    expect(dueResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(await json<Page<LoanView>>(dueResponse)).toMatchObject({ items: [{ id: loan.id, state: 'overdue' }] });
    expect((await call('GET', duePath, undefined, randomUUID(), home.author.token)).status).toBe(403);
    expect((await call('POST', `${loanPath}/return`, { actingSubject: agent, expectedVersion: 1 }, randomUUID(), home.author.token)).status).toBe(403);
    const returnKey = randomUUID();
    const returned = await json<LoanView>(await call('POST', `${loanPath}/return`, { actingSubject: agent, expectedVersion: 1 }, returnKey));
    expect(returned).toMatchObject({ state: 'returned', version: 2 });
    expect(returned.returnedAt).toBeTruthy();
    expect(await json(await call('POST', `${loanPath}/return`, { actingSubject: agent, expectedVersion: 1 }, returnKey)))
      .toEqual({ ...returned, replayed: true });
    expect((await call('POST', `${loanPath}/return`, { actingSubject: agent, expectedVersion: 1 })).status).toBe(409);
    expect((await call('POST', `${loanPath}/extend`, { actingSubject: agent, expectedVersion: 2, dueAt: dueFuture })).status).toBe(409);
    const borrowed = await json<LoanView>(await call('POST', '/v1/me/library-loans', { ...loanBody,
      direction: 'borrowed', counterparty: { kind: 'person', person: other } }), 201);
    const borrowedPath = `/v1/me/library-loans/${borrowed.id.slice(-36)}`;
    const racing = await Promise.all([
      call('POST', `${borrowedPath}/extend`, { actingSubject: agent, expectedVersion: 1, dueAt: dueFuture }),
      call('POST', `${borrowedPath}/return`, { actingSubject: agent, expectedVersion: 1 }),
    ]);
    expect(racing.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = await json<LoanView>(racing.find(response => response.status === 200)!);
    const finish = winner.state === 'returned' ? winner : await json<LoanView>(await call('POST', `${borrowedPath}/return`,
      { actingSubject: agent, expectedVersion: winner.version }));
    expect(finish.state).toBe('returned');
    const removeKey = randomUUID(), remove = { actingSubject: agent, expectedVersion: 2 };
    const removed = await json<CopyState & { replayed: boolean }>(await call('DELETE', copyPath, remove, removeKey));
    expect(removed).toMatchObject({ removed: true, version: 3 });
    expect(await json(await call('DELETE', copyPath, remove, removeKey))).toEqual({ ...removed, replayed: true });
    expect(await json(await call('GET', copiesPath))).toMatchObject({ items: [] });
    expect((await call('POST', '/v1/me/library-loans', loanBody)).status).toBe(404);

    const exportPage = async (actor = agent, token = home.reader.token, cursor?: string | null, snapshot?: string) => {
      const query = new URLSearchParams({ actingSubject: actor, ...(cursor ? { cursor } : {}), ...(snapshot ? { snapshot } : {}) });
      return json<Bundle>(await call('GET', `/v1/me/library-export?${query}`, undefined, randomUUID(), token));
    };
    const bundle = await exportPage();
    const native = bundle.rows.filter(row => row.raw.libraryCopy || row.raw.libraryLoan);
    expect(native).toHaveLength(3);
    const { replayed: removedReplay, ...removedRecord } = removed;
    expect(removedReplay).toBe(false);
    expect(native.find(row => row.raw.libraryCopy)?.raw.libraryCopy).toEqual(removedRecord);
    expect(native.filter(row => row.raw.libraryLoan).map(row => row.raw.jsonLd)).toEqual(expect.arrayContaining([
      expect.objectContaining({ '@type': 'LendAction', borrower: { name: other }, endTime: yesterday }),
      expect.objectContaining({ '@type': 'BorrowAction', lender: { '@id': other, '@type': 'Person' } }),
    ]));
    expect(parseRezics(JSON.stringify(bundle)).filter(row => row.raw.libraryCopy || row.raw.libraryLoan)).toEqual(native);
    // Re-import retains these private native records and JSON-LD losslessly. It
    // grants no authority over the source owner and fabricates no shared graph fact.
    const uploaded = await json<{ id: string }>(await call('POST', '/v1/me/library-imports',
      { actingSubject: other, format: 'rezics', file: JSON.stringify({ profile: bundle.profile, rows: native }) }, randomUUID(), home.author.token), 201);
    const importRows = await json<{ rows: Array<{ index: number; version: number }> }>(await call('GET',
      `/v1/me/library-imports/${uploaded.id}/rows?actingSubject=${encodeURIComponent(other)}`, undefined, randomUUID(), home.author.token));
    for (const row of importRows.rows) await json(await call('PUT', `/v1/me/library-imports/${uploaded.id}/rows/${row.index}`,
      { actingSubject: other, expectedVersion: row.version, choice: 'private' }, randomUUID(), home.author.token));
    await json(await call('POST', `/v1/me/library-imports/${uploaded.id}/apply`,
      { actingSubject: other, context: null, language: 'en' }, randomUUID(), home.author.token));
    const roundTrip = await exportPage(other, home.author.token);
    const bySource = (rows: CanonicalRow[]) => [...rows].sort((a,b) => a.sourceId.localeCompare(b.sourceId));
    expect(bySource(roundTrip.rows.filter(row => row.raw.libraryCopy || row.raw.libraryLoan))).toEqual(bySource(native));
    expect((await copies.page(other, target.work, {})).items).toEqual([]);

    // One bounded fixture transaction creates a large inventory from the already
    // validated owner shapes. Tied due times exercise the identity tie-breaker.
    const bulkCopies: CopyState[] = [], bulkLoans: LoanState[] = [];
    for (let i = 0; i < 500; i++) {
      const nextCopy = { ...removedRecord, id: id(), removed: false, version: 1 };
      const nextLoan: LoanState = { ...(native.find(row => row.sourceId === `loan:${loan.id}`)!.raw.libraryLoan as LoanState),
        id: id(), copy: nextCopy.id, returnedAt: null, version: 1,
        dueAt: new Date(Date.parse(yesterday) + Math.floor(i / 10) * 1000).toISOString() };
      bulkCopies.push(nextCopy); bulkLoans.push(nextLoan);
    }
    await stack.contentPool.query(`INSERT INTO reader.library_copy(agent,id,work,release,state,version)
      SELECT $1,s->>'id',s->>'work',s->>'release',s,(s->>'version')::bigint FROM jsonb_array_elements($2::jsonb) s`,
    [agent, JSON.stringify(bulkCopies)]);
    await stack.contentPool.query(`INSERT INTO reader.library_loan(agent,id,copy,state,due_at,version)
      SELECT $1,s->>'id',s->>'copy',s,(s->>'dueAt')::timestamptz,(s->>'version')::bigint FROM jsonb_array_elements($2::jsonb) s`,
    [agent, JSON.stringify(bulkLoans)]);
    expect(Date.now() - preparation).toBeLessThan(600_000);
    const seen: LoanView[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ actingSubject: agent, state: 'active', limit: '20', ...(cursor ? { cursor } : {}) });
      const page = await json<Page<LoanView>>(await call('GET', `/v1/me/library-loans?${query}`));
      expect(page.items.length).toBeLessThanOrEqual(LIBRARY_RECORD_COST.page);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(LIBRARY_RECORD_COST.responseBytes);
      seen.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(500);
    expect(new Set(seen.map(loan => loan.id)).size).toBe(500);
    expect(seen.every(loan => loan.state === 'overdue')).toBe(true);
    expect(seen.map(loan => `${loan.dueAt}:${loan.id}`)).toEqual(seen.map(loan => `${loan.dueAt}:${loan.id}`).sort());
    const copied: CopyState[] = [];
    cursor = null;
    do {
      const page = await json<Page<CopyState>>(await call('GET', `${copiesPath}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      copied.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(copied.map(copy => copy.id)).size).toBe(500);
    const firstPage = await loans.page(agent, { state: 'active', limit: 1 });
    expect((await call('GET', `/v1/me/library-loans?${new URLSearchParams({ actingSubject: other,
      state: 'active', cursor: firstPage.nextCursor! })}`, undefined, randomUUID(), home.author.token)).status).toBe(400);
    const exportBeforeChange = await exportPage();
    const changedLoan = firstPage.items[0]!;
    await json(await call('POST', `/v1/me/library-loans/${changedLoan.id.slice(-36)}/extend`,
      { actingSubject: agent, expectedVersion: changedLoan.version, dueAt: dueFuture }));
    const failedKey = randomUUID();
    let authorityChecks = 0;
    await expect(loans.write({ operation: 'return', agent, id: changedLoan.id, expectedVersion: changedLoan.version + 1,
      idempotencyKey: failedKey }, async () => {
      if (++authorityChecks === 2) throw new LibraryRecordDenied('Owner was revoked before commit');
    })).rejects.toBeInstanceOf(LibraryRecordDenied);
    expect((await stack.contentPool.query<{ state: LoanState }>('SELECT state FROM reader.library_loan WHERE agent=$1 AND id=$2',
      [agent, changedLoan.id])).rows[0]!.state).toMatchObject({ returnedAt: null, version: changedLoan.version + 1, dueAt: dueFuture });
    expect((await stack.contentPool.query('SELECT 1 FROM reader.library_copy_loan_command WHERE agent=$1 AND idempotency_key=$2',
      [agent, failedKey])).rowCount).toBe(0);
    await expect(loans.page(agent, { state: 'active', cursor: firstPage.nextCursor! })).rejects.toThrow('Collection changed');
    expect((await call('GET', `/v1/me/library-export?${new URLSearchParams({ actingSubject: agent,
      snapshot: exportBeforeChange.snapshot, cursor: exportBeforeChange.nextCursor! })}`)).status).toBe(409);
    const planClient = await stack.contentPool.connect();
    try {
      await planClient.query('BEGIN');
      await planClient.query('SET LOCAL enable_seqscan=off');
      const plan = await planClient.query(`EXPLAIN SELECT id,state FROM reader.library_loan
        WHERE agent=$1 AND returned_at IS NULL AND (due_at,id)>($2::timestamptz,$3) ORDER BY due_at,id LIMIT 21`,
      [agent, seen[250]!.dueAt, seen[250]!.id]);
      expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('library_loan_active_due');
      const copyPlan = await planClient.query(`EXPLAIN SELECT id,state FROM reader.library_copy
        WHERE agent=$1 AND work=$2 AND NOT removed AND id>$3 ORDER BY id LIMIT 21`, [agent,target.work,copied[250]!.id]);
      expect(copyPlan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('library_copy_work');
    } finally { await planClient.query('ROLLBACK'); planClient.release(); }
    let exportedCopies = 0, exportedLoans = 0, snapshot: string | undefined;
    cursor = null;
    do {
      const page = await exportPage(agent, home.reader.token, cursor, snapshot);
      exportedCopies += page.rows.filter(row => row.raw.libraryCopy).length;
      exportedLoans += page.rows.filter(row => row.raw.libraryLoan).length;
      snapshot = page.snapshot; cursor = page.nextCursor;
    } while (cursor);
    expect(exportedCopies).toBe(501); expect(exportedLoans).toBe(502);

    await stack.accessPool.query('UPDATE access.principal SET active=false WHERE id=$1', [home.reader.principalId]);
    await stack.accessPool.query(`INSERT INTO access.outbox(id,kind,principal_id,authority_epoch)
      SELECT $1,'account.deletion_fenced',id,enforcement_epoch FROM access.principal WHERE id=$2`,
    [randomUUID(), home.reader.principalId]);
    await eraseLibraryImportsForPrincipals(stack.contentPool, stack.accessPool, [home.reader.principalId]);
    for (const table of ['library_copy', 'library_loan', 'library_copy_loan_command']) {
      expect((await stack.contentPool.query(`SELECT 1 FROM reader.${table} WHERE agent=$1 LIMIT 1`, [agent])).rowCount).toBe(0);
    }
    // Restored records are erased by the same hook used by restore reconciliation.
    await stack.contentPool.query(`INSERT INTO reader.library_copy(agent,id,work,release,state,version)
      VALUES ($1,$2,$3,$4,$5,1)`, [agent, copy.id, target.work, release, JSON.stringify(copy)]);
    await eraseLibraryImportsForPrincipals(stack.contentPool, stack.accessPool, [home.reader.principalId]);
    expect((await copies.page(agent, target.work, {})).items).toEqual([]);
    expect((await exportPage(other, home.author.token)).rows.filter(row => row.raw.libraryLoan)).toHaveLength(2);
  } finally { await home.stop(); }
}, 600_000);
