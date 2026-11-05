import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { systemClock } from '../../src/clock.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { createIdentitySourceSupportReader } from '../../src/semantic/identity-source-support.ts';
import type { IdentitySourceSupportRecord } from '../../src/semantic/identity-source-support-contract.ts';
import { createPublicFilterSourceBinding } from '../../src/semantic/public-filter-source-binding.ts';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import { cancelIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import {
  readIdentityEpochCutover,
  stepIdentityEpochBootstrapWork,
} from '../../src/semantic/identity-epoch-bootstrap.ts';
import { moderateSubject } from '../../src/semantic/moderation.ts';
import { nativeProducer, readContext } from './support/public-filter-source.ts';
import { cutoverFixture, ordinaryAdmission } from './support/identity-epoch-cutover.ts';
import { digest, globalResource, nativeMappingStep, release, seedLegacyGroup } from './support/identity-epoch.ts';

test('an actual admitted identity job yields complete original support and current anonymous native Source projection before publication without bypassing source privacy or certifying engine writer drain', async () => {
  const f = await cutoverFixture();
  try {
    const survivor = (await f.create('Visible native terminal', 0)).subject.id;
    const redirected = (await f.create('Complete admitted source', 0)).subject.id;
    const members = await seedLegacyGroup(f, redirected, 101);
    const hidden = members[0]!;
    await f.real.grant(globalResource, 'editor', 'moderation:hide');
    const moderationAccess = f.real.access({
      actions: new Map([['moderation:hide', { anonymous: false }]]),
    });
    const actor = await f.actor();
    const key = randomUUID();
    await moderateSubject(f.pool, {
      actor,
      subject: hidden,
      action: 'hide',
      body: {},
      idempotencyKey: key,
      digest: digest(key),
      deadline: readContext().deadline,
      authorization: await accessCommandAuthorization(
        moderationAccess,
        actor,
        'moderation:hide',
        globalResource,
        { pool: f.pool, ...readContext() },
        () => new Error('Native moderation denied'),
      ),
    });
    for (let step = 0; (await readIdentityEpochCutover(f.pool)).state !== 'ready'; step++) {
      expect(step, 'Finite native fixture must settle through its real bootstrap producer').toBeLessThan(100_000);
      expect(await stepIdentityEpochBootstrapWork(f.pool)).not.toBeNull();
    }
    const config = {
      pool: f.pool,
      routeKey: new Uint8Array(32).fill(61),
      access: f.access,
      clock: systemClock,
    };
    const { publicFilterSource } = await nativeProducer();
    const source = publicFilterSource(config);
    const meaning = { ...release, type: 'schema:Person' };
    const resolved = await createPublicFilterSourceBinding(f.pool, config.routeKey, f.access).resolve(
      {
        source,
        meaning,
        capture: {
          sort: 'id',
          size: 20,
          filterDocument: undefined,
          text: undefined,
        },
      },
      readContext(),
    );
    expect(resolved.status, 'A native registered Source definition is required; unavailable is not coverage').toBe(
      'resolved',
    );
    if (resolved.status !== 'resolved') throw new Error(`Native Source binding ${resolved.status}`);
    const admission = await ordinaryAdmission(f, store(), {
      kind: 'merge',
      survivor,
      redirected,
      release: release.digest,
    });
    const job = (await admission.execute()).value;
    const mapping = await nativeMappingStep();
    for (let step = 0; ; step++) {
      expect(step).toBeLessThan(1000);
      const result = await mapping(f.pool, job);
      if (result.state === 'complete') break;
    }
    expect((await store().readJob(f.pool, job))?.mapping?.state).toBe('complete');
    expect(
      (
        await source.readPublicFilterProjectionPage({
          subject: survivor,
          meaning,
          inputLimit: 8,
          frontier: null,
          context: readContext(),
        })
      ).status,
    ).toBe('unready');

    const records: IdentitySourceSupportRecord[] = [];
    let frontier: string | null = null;
    let pages = 0;
    for (;;) {
      // Fresh factory on every page proves the cursor is not an in-memory original set.
      const page = await createIdentitySourceSupportReader(config).readPage({
        job,
        definition: resolved.definition,
        frontier,
        inputLimit: 8,
        context: readContext(),
      });
      expect(['progress', 'complete']).toContain(page.status);
      if (page.status !== 'progress' && page.status !== 'complete') throw new Error(`Native support ${page.status}`);
      expect(page.cost.inputKeys).toBeLessThanOrEqual(8);
      expect(page.cost.engineSearches).toBe(0);
      records.push(...page.records);
      expect(++pages).toBeLessThan(5000);
      if (page.status === 'complete') {
        expect(page.frontier).toBeNull();
        break;
      }
      expect(page.frontier).not.toBe(frontier);
      frontier = page.frontier;
    }
    expect(pages).toBeGreaterThan(1);
    expect([...new Set(records.map((record) => record.original))].sort()).toEqual(
      [survivor, redirected, ...members].sort(),
    );
    expect(records.filter((record) => record.original === hidden)).toEqual([
      { original: hidden, terminal: survivor, projection: null },
    ]);
    for (const record of records.filter((record) => record.original !== hidden)) {
      expect(record.terminal).toBe(survivor);
      expect(record.projection?.status).toBe('complete');
      if (record.projection?.status !== 'complete') throw new Error('Native current Source projection did not finish');
      expect(record.projection.source).toMatchObject({
        subject: record.original,
        terminal: survivor,
        currentRelease: release.digest,
      });
      expect(record.projection.source.revision).toBeGreaterThan(0);
    }
    const saved = await store().readJob(f.pool, job);
    expect(saved?.state).toBe('pending');
    expect(saved?.participants['search-canonical-index']).toBeNull();
    expect(saved?.participants['library-private-follow-counts']).toBeNull();
    expect((await store().readMapping(f.pool, survivor)).state).toBe('pending');
    expect(
      (
        await source.readPublicFilterProjectionPage({
          subject: survivor,
          meaning,
          inputLimit: 8,
          frontier: null,
          context: readContext(),
        })
      ).status,
    ).toBe('unready');

    const reader = createIdentitySourceSupportReader(config);
    expect(
      (
        await reader.readPage({
          job: { jobId: newId(0), epoch: job.epoch },
          definition: resolved.definition,
          frontier: null,
          inputLimit: 8,
          context: readContext(),
        })
      ).status,
    ).toBe('changed');
    await f.admin.query(
      "UPDATE core.partition SET write_state='moved',moved_to='support-owned-fixture' WHERE partition_no=0",
    );
    try {
      expect(
        (
          await reader.readPage({
            job,
            definition: resolved.definition,
            frontier: null,
            inputLimit: 8,
            context: readContext(),
          })
        ).status,
      ).toBe('unavailable');
    } finally {
      await f.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=0");
    }
  } finally {
    await f.close();
  }
});

test('cancelled native preparation never becomes support readiness or an empty complete page', async () => {
  const f = await cutoverFixture();
  try {
    const redirected = (await f.create('Cancelled original', 0x6010)).subject.id;
    const survivor = (await f.create('Cancelled target', 0x6020)).subject.id;
    const actor = await f.actor();
    const key = randomUUID();
    const job = await store().prepareAdmission(
      f.pool,
      {
        basis: {
          actorAccountId: actor.accountId,
          clientId: actor.clientId,
          requestedBy: actor.requestedBy,
        },
        authorization: await f.authorization('subject:merge'),
      },
      {
        intent: {
          kind: 'merge',
          survivor,
          redirected,
          release: release.digest,
        },
        receipt: {
          kind: 'subject.merge',
          command: {
            actorAccountId: actor.accountId,
            kind: 'subject.merge',
            key,
            digest: digest(key),
          },
        },
      },
    );
    await cancelIdentityEpochAdmission(f.pool, job);
    const config = {
      pool: f.pool,
      routeKey: new Uint8Array(32).fill(61),
      access: f.access,
      clock: systemClock,
    };
    const { publicFilterSource } = await nativeProducer();
    const resolved = await createPublicFilterSourceBinding(f.pool, config.routeKey, f.access).resolve(
      {
        source: publicFilterSource(config),
        meaning: { ...release, type: 'schema:Person' },
        capture: {
          sort: 'id',
          size: 20,
          filterDocument: undefined,
          text: undefined,
        },
      },
      readContext(),
    );
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error(`Native Source binding ${resolved.status}`);
    expect(
      (
        await createIdentitySourceSupportReader(config).readPage({
          job,
          definition: resolved.definition,
          frontier: null,
          inputLimit: 8,
          context: readContext(),
        })
      ).status,
    ).toBe('changed');
  } finally {
    await f.close();
  }
});
