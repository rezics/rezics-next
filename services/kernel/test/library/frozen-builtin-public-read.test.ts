import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { routeOf } from '../../src/route/route.ts';
import { startConsentServer, type ConsentServer } from '../community/membership-fixture.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createOwnedErasureFixture } from './support/erasure-worker.ts';

async function waitFor<T>(phase: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 60_000;
  let value = await read();
  while (!ready(value)) {
    if (performance.now() >= deadline) throw new Error(`${phase}: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
    value = await read();
  }
  return value;
}

test('anonymous members retain the selected built-in generation after curator erasure and recheck live Subject disclosure', async () => {
  const f = await createOwnedErasureFixture();
  let consentServer: ConsentServer | undefined;
  try {
    const owner = f.people.alice;
    const id = builtinCollectionId(owner.accountId, { kind: 'everything' });
    const path = `/v1/collections/${id}`;
    const membersPath = `${path}/members`;
    const selected = [await f.subject(), await f.subject()].sort();
    for (const subjectId of selected)
      await f.json(owner, 'PUT', `/v1/libraryEntries/${subjectId}`, 201, { state: 'planned' });

    const temporaryRoot = resolve(import.meta.dir, '../../../../.temp');
    await mkdir(temporaryRoot, { recursive: true });
    const consent = createCurrentConsentReader({ database: f.auth.authPool });
    consentServer = await startConsentServer(
      async (input) => (await consent.readCurrentConsent(input))?.scopes ?? null,
      temporaryRoot,
    );
    await f.start({ ...consentServer.env, KERNEL_ROUTE_KEY: Buffer.from(testRouteKey()).toString('base64url') });
    const admitted = await f.json(owner, 'POST', `${path}:publish`, 202, { revision: 0, visibility: 'public' });
    const completed = await waitFor(
      'Built-in publication did not complete',
      async () => {
        const status = await f.json(owner, 'GET', `/v1/collectionPublications/${admitted.id}`, 200);
        if (status.phase !== 'complete' && (await f.client.getWorkflow(admitted.id))?.status === 'ERROR')
          await f.client.retrieveWorkflow(admitted.id).getResult();
        return status;
      },
      (value) => {
        expect(value.phase).not.toBe('refused');
        return value.phase === 'complete';
      },
    ).catch(async (error: unknown) => {
      const workflow = await f.client.getWorkflow(admitted.id);
      if (workflow?.status === 'ERROR') await f.client.retrieveWorkflow(admitted.id).getResult();
      throw new Error(`Publication workflow status: ${workflow?.status ?? 'absent'}`, { cause: error });
    });
    const generation: string = completed.publication.generation;
    const members = selected.map((subjectId) => ({ kind: 'dynamic', subjectId }));
    const live = await waitFor(
      'Selected output did not become readable',
      async () => {
        const response = await f.request(null, 'GET', membersPath);
        expect([200, 503]).toContain(response.status);
        return { status: response.status, body: await response.json() };
      },
      (value) => value.status === 200,
    );
    expect(live.body).toEqual({ members, next: null });

    const outside = await f.subject();
    await f.json(owner, 'PUT', `/v1/libraryEntries/${outside}`, 201, { state: 'planned' });
    await deletePersona(f.options, owner);
    expect((await f.request(owner, 'GET', membersPath)).status).toBe(401);
    const retained = async () =>
      (
        await f.db.pool.query(
          `SELECT c.curator_account_id,g.account_id,f.generation::text,f.members::int AS members
             FROM library.collection c
             LEFT JOIN library.collection_retained_output f USING (route,collection_id)
             LEFT JOIN library.collection_source_output g USING (route,collection_id,generation)
             WHERE c.route=$1 AND c.collection_id=$2`,
          [routeOf(id), id],
        )
      ).rows[0];
    await waitFor(
      'Terminal participant did not select the retained generation',
      retained,
      (row) => row?.generation === generation,
    );
    await f.client.triggerSchedule('library.canonicalSource.every-10-minutes');
    const frozen = await waitFor(
      'Selected output did not lose curator attribution',
      retained,
      (row) => row?.curator_account_id === null,
    );
    expect(frozen).toEqual({ curator_account_id: null, account_id: null, generation, members: 2 });
    const { collection } = await f.json(null, 'GET', path, 200);
    expect(collection).toMatchObject({ id, curatorAccountId: null, builtinKind: 'everything', visibility: 'public' });

    const first = await f.json(null, 'GET', `${membersPath}?limit=1`, 200);
    expect(first.members).toEqual(members.slice(0, 1));
    expect(first.next).toBeString();
    const second = await f.json(null, 'GET', `${membersPath}?limit=1&cursor=${encodeURIComponent(first.next)}`, 200);
    expect(second).toEqual({ members: members.slice(1), next: null });

    await f.json(f.people.staff, 'POST', `/v1/subjects/${selected[0]}:hide`, 200, {
      reason: 'Current disclosure of an exact frozen member',
    });
    expect(await f.json(null, 'GET', `${membersPath}?limit=1`, 200)).toEqual({
      members: members.slice(1),
      next: null,
    });
  } finally {
    try {
      await f.close();
    } finally {
      await consentServer?.close();
    }
  }
}, 360_000);
