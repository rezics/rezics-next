import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp } from '../../../services/main/src/app.ts';
import { LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { getLibraryImportApplyWorker } from '../../../services/main/src/modules/library-import/apply-worker.ts';
import { ImportJobLeaseLost } from '../../../services/main/src/modules/library-import/job-store.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import type { SessionState } from '../../../services/main/src/modules/session/contract.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { startHomeStack } from './feed-read-support.ts';

interface Progress {
  total: number; completed: number; issues: number; pending: boolean;
  state: 'review' | 'pending' | 'completed' | 'failed' | 'stalled';
  reason: string | null;
  receipt?: string;
}
interface SessionReceipt extends SessionState { replayed: boolean }

test('G428: reviewed import jobs finish, report real stalls and replay committed writes without duplicates', async () => {
  const home = await startHomeStack('library-import-apply');
  const files = new LibraryFileStore(home.stack.contentPool);
  const imports = new ReaderLibraryImportStore(home.stack.contentPool);
  const worker = getLibraryImportApplyWorker(files, imports);
  let releasePendingOwner: (() => void) | undefined;
  try {
    const { stack } = home;
    const agent = await home.provision('Library import reader', home.reader.token);
    const first = await stack.publicWork(agent, ['en'], 'Shared Moon');
    const second = await stack.publicWork(agent, ['en'], 'Dropped Moon');
    const lostWork = await stack.publicWork(agent, ['en'], 'Lost response moon');
    const deps = { ...home.deps, libraryFiles: files, libraryImport: imports,
      sessions: new ConsumptionSessionStore(stack.contentPool, home.deps.libraryStatus),
      libraryRatings: new ReaderLibraryRatings(stack.accessPool), accessPolicy: new AccessPolicyOwner(stack.accessPool) };
    let app = createMainApp(stack.fuseki, deps);
    const dispatched: string[] = [];
    let refuseShelfReads = false;
    let dropSessionResponse = false;
    let lostCommand: { key: string; receipt: SessionReceipt; request: Request } | undefined;
    let replayedSession: SessionReceipt | undefined;
    let ownerPending = false;
    let ownerPendingCalls = 0;
    let pendingOwnerGate: Promise<void> | undefined;
    let ownerHung = false;
    let ownerHungCalls = 0;
    imports.setDispatch(async request => {
      const path = new URL(request.url).pathname;
      const childRequest = request.method === 'POST' && path === '/v1/me/sessions' ? request.clone() : null;
      let response: Response;
      if (refuseShelfReads && request.method === 'GET' && path.startsWith('/v1/collections/')) {
        response = Response.json({ code: 'collection_unavailable' }, { status: 404 });
      } else if (ownerHung && request.method === 'GET' && path.endsWith('/reader-state')) {
        ownerHungCalls++;
        // The owner never answers and ignores cancellation, as a wedged transport would.
        await new Promise<never>(() => {});
        throw new Error('unreachable');
      } else if (ownerPending && request.method === 'GET' && path.endsWith('/reader-state')) {
        ownerPendingCalls++;
        await pendingOwnerGate;
        response = Response.json({ pending: true }, { status: 202 });
      } else {
        response = await app.handle(request);
      }
      dispatched.push(`${request.method} ${path}: ${response.status}${response.ok ? '' : ` ${await response.clone().text()}`}`);
      if (request.method === 'POST' && path === '/v1/me/sessions' && response.status === 201) {
        const receipt = await response.clone().json() as SessionReceipt;
        const key = request.headers.get('idempotency-key')!;
        if (dropSessionResponse) {
          dropSessionResponse = false;
          lostCommand = { key, receipt, request: childRequest! };
          // The ordinary owner committed its Session and command receipt before
          // the transport failed. A refusal before app.handle is not this case.
          throw new TypeError('Session response was lost after the owner committed');
        }
        if (key === lostCommand?.key) replayedSession = receipt;
      }
      return response;
    });
    const call = (method: string, path: string, body?: object, key = randomUUID()) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${home.reader.token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const checked = async <T>(response: Response, status = 200): Promise<T> => {
      if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}\n${dispatched.join('\n')}`);
      return response.json() as Promise<T>;
    };
    const file = readFileSync(new URL('../../fixtures/library-exports/goodreads.csv', import.meta.url), 'utf8');
    const prepare = async (csv: string, works: string[]) => {
      const upload = await checked<{ id: string; total: number }>(await call('POST', '/v1/me/library-imports', {
        actingSubject: agent, format: 'goodreads', file: csv }), 201);
      expect(upload.total).toBe(works.length);
      for (const [index, work] of works.entries()) {
        await checked(await call('PUT', `/v1/me/library-imports/${upload.id}/rows/${index}`, {
          actingSubject: agent, expectedVersion: 1, choice: 'apply', work }));
      }
      return upload.id;
    };
    const status = (id: string) => call('GET', `/v1/me/library-imports/${id}/apply?actingSubject=${encodeURIComponent(agent)}`);
    const terminal = async (id: string) => {
      const deadline = Date.now() + 30_000;
      let value: Progress;
      do {
        value = await checked<Progress>(await status(id));
        if (['completed', 'failed', 'stalled'].includes(value.state)) return value;
        await Bun.sleep(200);
      } while (Date.now() < deadline);
      throw new Error(`Import ${id} did not reach a terminal state: ${JSON.stringify(value)}\n${dispatched.join('\n')}`);
    };
    const start = (id: string, resume = false, key = randomUUID()) => call('POST', `/v1/me/library-imports/${id}/apply`, {
      actingSubject: agent, context: null, language: 'en', ...(resume ? { resume } : {}) }, key);
    const upload = await prepare(file, [first.work, second.work, first.work]);

    // A command refused by its idempotency receipt must not seal the upload it named.
    const other = await prepare(file.replace('favorites, reread', 'other-shelf'), [first.work, second.work, first.work]);
    const keyed = await prepare(file.replace('favorites, reread', 'keyed-shelf'), [first.work, second.work, first.work]);
    const otherKey = randomUUID();
    await checked(await start(keyed, false, otherKey), 202);
    expect((await start(other, false, otherKey)).status).toBe(409);
    expect((await stack.contentPool.query<{ apply_intent: unknown }>(
      'SELECT apply_intent FROM reader.library_import_file WHERE agent=$1 AND id=$2', [agent, other])).rows[0]!.apply_intent).toBeNull();
    const otherVersion = (await stack.contentPool.query<{ version: string }>(
      'SELECT version::text FROM reader.library_import_source_row WHERE agent=$1 AND file_id=$2 AND row_number=0', [agent, other])).rows[0]!.version;
    await checked(await call('PUT', `/v1/me/library-imports/${other}/rows/0`, {
      actingSubject: agent, expectedVersion: Number(otherVersion), choice: 'apply', work: second.work }));
    expect(await terminal(keyed)).toMatchObject({ state: 'completed' });

    // Drop the accepted response after the start command has committed, then
    // replay exactly that command after all its ordinary writes have finished.
    const outerKey = randomUUID();
    let accepted: Progress | undefined;
    const applyWithDroppedResponse = async () => {
      const committedResponse = await start(upload, false, outerKey);
      // Capture at the transport boundary only; the command caller receives no
      // response, even though the committed receipt can be inspected here.
      accepted = await checked<Progress>(committedResponse, 202);
      expect(await terminal(upload)).toMatchObject({ completed: 3, state: 'completed' });
      throw new TypeError('Apply response was lost after the start command committed');
    };
    await expect(applyWithDroppedResponse()).rejects.toThrow('Apply response was lost after the start command committed');
    expect(accepted).toMatchObject({ state: 'pending', pending: true });
    expect(accepted!.receipt).toMatch(/^urn:/);
    const privateStatus = await app.handle(new Request(`http://main.local/v1/me/library-imports/${upload}/apply?actingSubject=${encodeURIComponent(agent)}`, {
      headers: { authorization: `Bearer ${home.author.token}`, 'idempotency-key': randomUUID() } }));
    expect(privateStatus.status).toBe(403);
    expect(await terminal(upload)).toMatchObject({ total: 3, completed: 3, pending: false, state: 'completed', reason: null });
    const sourceRows = (await files.page(agent, upload, -1)).rows;
    expect(sourceRows).toHaveLength(3);
    expect(sourceRows.every(row => row.outcome !== null)).toBe(true);
    const beforeReplay = (await stack.contentPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM reader.consumption_session WHERE agent=$1', [agent])).rows[0]!.count;
    expect(await checked<Progress>(await start(upload, false, outerKey), 202)).toEqual(accepted);
    const outerReceipts = (await stack.contentPool.query<{ result: Progress }>(
      'SELECT result FROM reader.library_import_apply_command WHERE agent=$1 AND idempotency_key=$2', [agent, outerKey])).rows;
    expect(outerReceipts).toHaveLength(1);
    expect(outerReceipts[0]!.result).toEqual(accepted);
    expect((await files.page(agent, upload, -1)).rows).toEqual(sourceRows);
    expect((await stack.contentPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM reader.consumption_session WHERE agent=$1', [agent])).rows[0]!.count).toBe(beforeReplay);
    const sessions = await checked<{ items: SessionState[] }>(await call('GET', `/v1/me/sessions?actingSubject=${encodeURIComponent(agent)}`));
    expect(sessions.items.some(session => session.target.work === first.work && session.state === 'finished')).toBe(true);
    expect(sessions.items.some(session => session.target.work === second.work && session.state === 'dnf')).toBe(true);

    // A missing ordinary owner read belongs to a real terminal job outcome,
    // rather than a 202 claiming that work is still advancing.
    refuseShelfReads = true;
    const blocked = await prepare(file.replace('favorites, reread', 'new-private-shelf'), [first.work, second.work, first.work]);
    await checked(await start(blocked), 202);
    expect(await terminal(blocked)).toMatchObject({ completed: 0, state: 'failed', reason: 'owner-refused', pending: false });
    expect(dispatched.some(value => /GET \/v1\/collections\/[^:]+: 404/.test(value))).toBe(true);
    refuseShelfReads = false;
    await checked(await start(blocked, true), 202);
    expect(await terminal(blocked)).toMatchObject({ completed: 3, pending: false, state: 'completed' });

    // Production disclosure uses the batch reader; omitting it from the fixture
    // would conceal a private-curator baseline regression.
    app = createMainApp(stack.fuseki, { ...deps, mediaAccess: new MediaAccessBatchReader(stack.accessPool, stack.fuseki) });
    const production = await prepare(file.replace('favorites, reread', 'production-private-shelf'), [first.work, second.work, first.work]);
    await checked(await start(production), 202);
    expect(await terminal(production)).toMatchObject({ completed: 3, pending: false, state: 'completed' });

    const singleRow = `${file.trimEnd().split('\n').slice(0, 2).join('\n').replace('\n101,', '\n104,')}\n`;
    const lost = await prepare(singleRow, [lostWork.work]);
    dropSessionResponse = true;
    await checked(await start(lost), 202);
    expect(await terminal(lost)).toMatchObject({ completed: 0, state: 'failed', reason: 'apply-failed', pending: false });
    expect(lostCommand).toBeDefined();
    expect(lostCommand!.receipt.replayed).toBe(false);
    expect((await stack.contentPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM reader.consumption_session WHERE agent=$1 AND id=$2',
      [agent, lostCommand!.receipt.id])).rows[0]!.count).toBe(1);
    // Retry the exact owner command whose transport lost the committed reply.
    // The import job may then discover and reuse that same Session on resume.
    await checked(await imports.call(lostCommand!.request), 201);
    await checked(await start(lost, true), 202);
    expect(await terminal(lost)).toMatchObject({ completed: 1, pending: false, state: 'completed' });
    expect(replayedSession).toBeDefined();
    const { replayed: originalReplay, ...originalReceipt } = lostCommand!.receipt;
    const { replayed: retryReplay, ...retryReceipt } = replayedSession!;
    expect(originalReplay).toBe(false);
    expect(retryReplay).toBe(true);
    expect(retryReceipt).toEqual(originalReceipt);
    expect((await stack.contentPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM reader.consumption_session WHERE agent=$1 AND work=$2',
      [agent, lostWork.work])).rows[0]!.count).toBe(1);
    expect((await stack.contentPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM reader.consumption_session_command WHERE idempotency_key=$1',
      [lostCommand!.key])).rows[0]!.count).toBe(1);
    expect((await stack.contentPool.query<{ result: SessionState }>(
      'SELECT result FROM reader.consumption_session_command WHERE idempotency_key=$1',
      [lostCommand!.key])).rows[0]!.result).toEqual(originalReceipt);

    ownerPending = true;
    const pending = await prepare(singleRow.replace('\n104,', '\n105,'), [first.work]);
    await checked(await start(pending), 202);
    const ownerDeadline = Date.now() + 10_000;
    while (!ownerPendingCalls && Date.now() < ownerDeadline) await Bun.sleep(20);
    expect(ownerPendingCalls).toBeGreaterThan(0);
    expect(await checked<Progress>(await status(pending))).toMatchObject({ completed: 0, state: 'pending', pending: true });
    await stack.contentPool.query(`UPDATE reader.library_import_job SET last_progress_at=clock_timestamp()-interval '6 minutes'
      WHERE agent=$1 AND file_id=$2`, [agent, pending]);
    expect(await checked<Progress>(await status(pending))).toMatchObject({ completed: 0, state: 'stalled', reason: 'no-progress', pending: false });
    expect((await stack.contentPool.query<{ state: string }>(
      'SELECT state FROM reader.library_import_job WHERE agent=$1 AND file_id=$2', [agent, pending])).rows[0]!.state).toBe('stalled');

    const lease = await prepare(singleRow.replace('\n104,', '\n106,'), [first.work]);
    const pendingCallsBeforeLease = ownerPendingCalls;
    pendingOwnerGate = new Promise<void>(resolve => { releasePendingOwner = resolve; });
    await checked(await start(lease), 202);
    const leaseOwnerDeadline = Date.now() + 10_000;
    while (ownerPendingCalls === pendingCallsBeforeLease && Date.now() < leaseOwnerDeadline) await Bun.sleep(20);
    expect(ownerPendingCalls).toBeGreaterThan(pendingCallsBeforeLease);
    const oldLease=(await stack.contentPool.query<{ lease_token: string }>(`SELECT lease_token FROM reader.library_import_job
      WHERE agent=$1 AND file_id=$2`,[agent,lease])).rows[0]!.lease_token;
    await stack.contentPool.query(`UPDATE reader.library_import_job SET lease_token=$3,
      lease_expires_at=clock_timestamp()-interval '1 second' WHERE agent=$1 AND file_id=$2`, [agent, lease, randomUUID()]);
    expect(await checked<Progress>(await status(lease))).toMatchObject({ completed: 0, state: 'stalled', reason: 'lease-expired', pending: false });
    await expect(files.complete(agent,lease,0,{ applied: [],issues: [] },oldLease)).rejects.toBeInstanceOf(ImportJobLeaseLost);
    expect(await files.progress(agent,lease)).toMatchObject({ completed: 0,state: 'stalled',reason: 'lease-expired' });
    releasePendingOwner!();
    pendingOwnerGate = undefined;
    ownerPending = false;

    // Expiry must unwind an apply stuck on an owner that never answers: the
    // reader's lock is freed and a resumed job can take it and finish.
    const hung = await prepare(singleRow.replace('\n104,', '\n107,'), [first.work]);
    ownerHung = true;
    await checked(await start(hung), 202);
    const hungDeadline = Date.now() + 10_000;
    while (!ownerHungCalls && Date.now() < hungDeadline) await Bun.sleep(20);
    expect(ownerHungCalls).toBeGreaterThan(0);
    await stack.contentPool.query(`UPDATE reader.library_import_job SET lease_token=$3,
      lease_expires_at=clock_timestamp()-interval '1 second' WHERE agent=$1 AND file_id=$2`, [agent, hung, randomUUID()]);
    expect(await checked<Progress>(await status(hung))).toMatchObject({ state: 'stalled', reason: 'lease-expired' });
    const lockFree = async () => {
      const client = await stack.contentPool.connect();
      try {
        const lock = `reader-library-import:${agent}:library-file-agent-apply`;
        const { locked } = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lock])).rows[0]!;
        if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
        return locked;
      } finally { client.release(); }
    };
    const freeDeadline = Date.now() + 10_000;
    while (!await lockFree() && Date.now() < freeDeadline) await Bun.sleep(100);
    expect(await lockFree()).toBe(true);
    ownerHung = false;
    await checked(await start(hung, true), 202);
    expect(await terminal(hung)).toMatchObject({ completed: 1, pending: false, state: 'completed' });
  } finally { releasePendingOwner?.(); await worker.stop(); await home.stop(); }
}, 180_000);
