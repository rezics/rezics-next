import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { addressFixture } from './g-937-support.ts';
import {
  spaceCreationDigest,
  sealRealmSpaceAdmission,
} from '../../../services/main/src/modules/space/create.ts';
import { readFileSync } from 'node:fs';
import { reportAddress } from '../../../services/main/src/modules/public-report/owners.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

test('G937: Space validation precedes a name claim and a cancelled creation can be reclaimed by its controller', async () => {
  const f = await addressFixture('creation');
  try {
    await f.grant('space:create:root', 'space.create');
    const handle = `space-${randomUUID().slice(0, 8)}`;
    const input = { name: 'Community', handle, actingSubject: f.actor };
    expect(
      (
        await f.call('POST', '/v1/spaces', {
          ...input,
          profile: 'space-realm-v2',
          capabilities: ['realm'],
          topics: [`https://rezics.com/id/${randomUUID()}`],
        })
      ).status,
    ).toBe(400);
    expect(await f.env.addresses.lookup('space', handle)).toBeNull();
    const principal = {
      issuer: f.account.issuer,
      subject: f.account.a.id,
      accountExpiresAt: Date.now() / 1000 + 3600,
    };
    const registered = await f.access.register({
      principal,
      actingSubject: f.actor,
      scope: 'space:create:root',
      action: 'space.create',
      idempotencyKey: randomUUID(),
      requestDigest: spaceCreationDigest(input),
    });
    const admission = await f.access.claim(registered.id, registered.requestDigest, principal);
    await f.access.withOwnerAuthority(
      { principal, actingSubject: f.actor, scope: 'space:create:root', action: 'space.create' },
      (client) =>
        f.env.addresses.write(
          client,
          principal,
          {
            scope: 'space',
            holder: `https://rezics.com/id/${admission.id}`,
            actingSubject: f.actor,
            operation: 'claim',
            alias: handle,
            expectedRevision: null,
            idempotencyKey: randomUUID(),
          },
          f.actor,
          admission.id,
        ),
    );
    await f.access.recordGraphOutcome(
      admission.id,
      await sealRealmSpaceAdmission(f.env, admission),
    );
    const created = await f.json<{ space: string }>(
      await f.call('POST', '/v1/spaces', {
        ...input,
        profile: 'space-realm-v2',
        capabilities: ['realm'],
      }),
      201,
    );
    expect(created.space).not.toBe(`https://rezics.com/id/${admission.id}`);
    expect(await f.env.addresses.lookup('space', handle)).toMatchObject({
      holder: created.space,
      state: 'current',
      controller: f.actor,
    });
  } finally {
    await f.close();
  }
}, 30_000);

test('G937: legacy pending address admissions are terminal before strong revocation; reporting still identifies private Works', async () => {
  const f = await addressFixture('legacy-admission');
  try {
    const record = await f.work('Private report target');
    await f.permit(record.work);
    const principal = {
      issuer: f.account.issuer,
      subject: f.account.a.id,
      accountExpiresAt: Date.now() / 1000 + 3600,
    };
    const scope = `address:claim:${record.work}`;
    const pending = await f.access.register({
      principal,
      actingSubject: f.actor,
      scope,
      action: 'address.claim',
      idempotencyKey: randomUUID(),
      requestDigest: 'a'.repeat(64),
    });
    await f.accessPool.query(
      readFileSync(
        'services/main/migrations/access/1013_terminal_legacy_address_admissions.sql',
        'utf8',
      ),
    );
    expect(
      (
        await f.accessPool.query('SELECT state,graph_outcome FROM access.admission WHERE id = $1', [
          pending.id,
        ])
      ).rows[0],
    ).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
    expect(await f.access.strongCloseScope(scope, pending.authorityEpoch)).toMatchObject({
      pending: 0,
    });
    // Reopen only this fixture's claim authority to claim its public name.
    await f.accessPool.query(
      'UPDATE access.scope_gate SET open = true,dispatch_open = true WHERE id = $1',
      [scope],
    );
    const named = await f.receipt(
      await f.aliasWrite('work', record.work, 'claim', `report-${randomUUID().slice(0, 8)}`, null),
    );
    await f.nativeFuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(record.work)} rv:catalogueVisible true } }`);
    expect((await f.lookup('work', named.key)).status).toBe(404);
    expect(
      await reportAddress(
        { environment: f.env } as Parameters<typeof reportAddress>[0],
        `https://rezics.com/w/${named.key}`,
      ),
    ).toBe(record.work);
  } finally {
    await f.close();
  }
}, 30_000);
