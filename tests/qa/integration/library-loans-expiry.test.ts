import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { CopyState } from '../../../services/main/src/modules/library/copies.ts';
import type { LoanView } from '../../../services/main/src/modules/library/loans.ts';
import { startHomeStack } from './feed-read-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
type Page<T> = { items: T[]; nextCursor: string | null; complete: boolean };
type Problem = { status: number; code: string; title: string };

// A loan is the owner's private record that one copy is out. The hold is the
// active slot (`returned_at` is null): it refuses a second loan and refuses
// removal of the copy. Passing the due date only changes the readable state
// from open to overdue. Returning is what ends the hold.
test('a loan past its due date reads as overdue, an extension clears that, and returning ends the hold', async () => {
  const home = await startHomeStack('library-loans-expiry');
  try {
    const { stack } = home;
    const agent = await home.provision('Loan reader', home.reader.token);
    const other = await home.provision('Another reader', home.author.token);
    const editor = await stack.member('loan-release-editor');
    const target = await stack.publicWork(editor.actor, ['en'], 'Exact edition');
    await editor.grant(`work:edit:${target.work}`, 'work.edit');
    const release = id();
    const written = await editor.send('PUT', `/v1/works/${target.work.slice(-36)}/releases/${release.slice(-36)}`, {
      profile: 'release-v1', expectedHead: null, actingSubject: editor.actor, id: release, kind: 'formal',
      status: 'official', contentLanguages: ['en'], isTranslation: false, originalLanguages: [],
      titleLanguage: 'en', tracklistLanguage: null, title: { value: 'Exact edition', language: 'en' },
      editionStatement: null, publisher: null, publicationYear: null, isbn13: null, originalUrl: null,
      fixedRelease: null, coverage: null, evidence: null,
    });
    if (written.status !== 200 && written.status !== 202) {
      throw new Error(`Release was not saved (${written.status}): ${await written.text()}`);
    }
    const call = (method: string, path: string, body?: object, token = home.reader.token) =>
      home.call(method, path, body, token);
    const problem = async (response: Response): Promise<Problem> => response.json() as Promise<Problem>;
    const loans = async (state: 'active' | 'overdue' | 'returned', token = home.reader.token) =>
      home.json<Page<LoanView>>(await call('GET', `/v1/me/library-loans?${new URLSearchParams({
        actingSubject: token === home.reader.token ? agent : other, state })}`, undefined, token));
    const copy = await home.json<CopyState & { replayed: boolean }>(await call('POST', '/v1/me/library-copies', {
      actingSubject: agent, expectedVersion: 0, release, format: 'Paperback',
      acquiredFrom: { kind: 'name', name: 'City Library' }, acquiredAt: '2024-02-01T00:00:00.000Z',
      ownedFrom: '2024-03-01T00:00:00.000Z', ownedThrough: null,
    }), 201);
    const startedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const dueAt = new Date(Date.now() + 8_000).toISOString();
    const loanBody = { actingSubject: agent, expectedVersion: 0, copy: copy.id, direction: 'lent' as const,
      counterparty: { kind: 'name' as const, name: 'City Library' }, startedAt, dueAt };
    const loan = await home.json<LoanView & { replayed: boolean }>(await call('POST', '/v1/me/library-loans', loanBody), 201);
    expect(loan).toMatchObject({ state: 'open', returnedAt: null, version: 1, direction: 'lent',
      counterparty: { kind: 'name', name: 'City Library' } });
    expect(Date.parse(loan.dueAt)).toBeGreaterThan(Date.now());
    const loanPath = `/v1/me/library-loans/${loan.id.slice(-36)}`;
    const copyPath = `/v1/me/library-copies/${copy.id.slice(-36)}`;
    const openAgain = { ...loanBody, dueAt: new Date(Date.now() + 86_400_000).toISOString() };
    const held = async () => {
      const second = await call('POST', '/v1/me/library-loans', openAgain);
      const removal = await call('DELETE', copyPath, { actingSubject: agent, expectedVersion: copy.version });
      expect(second.status).toBe(409);
      expect(await problem(second)).toMatchObject({ code: 'library_record_conflict' });
      expect(removal.status).toBe(409);
      expect(await problem(removal)).toMatchObject({ code: 'library_record_conflict' });
    };

    expect(await loans('overdue')).toMatchObject({ items: [], nextCursor: null, complete: true });
    expect(await loans('active')).toMatchObject({ items: [{ id: loan.id, state: 'open' }], nextCursor: null, complete: true });
    await held();
    const stranger = await call('GET', `/v1/me/library-loans?${new URLSearchParams({ actingSubject: agent, state: 'active' })}`,
      undefined, home.author.token);
    expect(stranger.status).toBe(403);
    expect(await problem(stranger)).toMatchObject({ code: 'library_record_denied' });
    const anonymous = await call('GET', `/v1/me/library-loans?${new URLSearchParams({ actingSubject: agent, state: 'overdue' })}`,
      undefined, '');
    expect(anonymous.status).toBe(401);
    expect((await loans('active', home.author.token)).items).toEqual([]);

    await Bun.sleep(Math.max(0, Date.parse(loan.dueAt) - Date.now()) + 3_000);
    const overdue = await call('GET', `/v1/me/library-loans?${new URLSearchParams({ actingSubject: agent, state: 'overdue' })}`);
    expect(overdue.headers.get('cache-control')).toBe('private, no-store');
    const overduePage = await home.json<Page<LoanView>>(overdue);
    expect(overduePage).toMatchObject({ items: [{ id: loan.id, state: 'overdue', returnedAt: null,
      counterparty: { kind: 'name', name: 'City Library' } }], nextCursor: null, complete: true });
    expect(await loans('active')).toMatchObject({ items: [{ id: loan.id, state: 'overdue' }] });
    // The due date changed the label. The copy is still out, so the hold remains.
    await held();

    const extendedDue = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const extended = await home.json<LoanView>(await call('POST', `${loanPath}/extend`, {
      actingSubject: agent, expectedVersion: loan.version, dueAt: extendedDue }));
    expect(extended).toMatchObject({ id: loan.id, state: 'open', returnedAt: null, version: loan.version + 1, dueAt: extendedDue });
    expect(await loans('overdue')).toMatchObject({ items: [], complete: true });
    expect(await loans('active')).toMatchObject({ items: [{ id: loan.id, state: 'open', dueAt: extendedDue }] });
    await held();

    const returned = await home.json<LoanView>(await call('POST', `${loanPath}/return`, {
      actingSubject: agent, expectedVersion: extended.version }));
    expect(returned.state).toBe('returned');
    expect(returned.returnedAt).toBeTruthy();
    expect(Date.parse(returned.returnedAt ?? '')).toBeLessThanOrEqual(Date.now());
    expect(await loans('active')).toMatchObject({ items: [], complete: true });
    expect(await loans('overdue')).toMatchObject({ items: [], complete: true });
    expect(await loans('returned')).toMatchObject({ items: [{ id: loan.id, state: 'returned' }], complete: true });
    const extendClosed = await call('POST', `${loanPath}/extend`, {
      actingSubject: agent, expectedVersion: returned.version, dueAt: extendedDue });
    expect(extendClosed.status).toBe(409);
    expect(await problem(extendClosed)).toMatchObject({ code: 'library_record_conflict' });

    const again = await home.json<LoanView>(await call('POST', '/v1/me/library-loans', openAgain), 201);
    expect(again).toMatchObject({ state: 'open', copy: copy.id, returnedAt: null });
    const closedAgain = await home.json<LoanView>(await call('POST', `/v1/me/library-loans/${again.id.slice(-36)}/return`, {
      actingSubject: agent, expectedVersion: again.version }));
    expect(closedAgain.state).toBe('returned');
    const removed = await home.json<CopyState>(await call('DELETE', copyPath, {
      actingSubject: agent, expectedVersion: copy.version }));
    expect(removed).toMatchObject({ id: copy.id, removed: true });
    expect((await call('POST', '/v1/me/library-loans', openAgain)).status).toBe(404);
  } finally { await home.stop(); }
}, 300_000);
