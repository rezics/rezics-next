import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { selectLibraryProfile } from '../../src/library/profile.ts';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import { bindCanonicalSourceWork } from '../../src/library/canonical-source-store.ts';
import {
  collectionPublicationStepAllowance,
  prepareCollectionPublicationSource,
} from '../../src/library/collection-publication-work.ts';
import {
  createCollectionPublicationEpisodes,
  readCollectionPublicationEpisode,
} from '../../src/library/collection-publication-episodes.ts';
import { createCollectionPublicationFinalActivation } from '../../src/library/collection-publication-final.ts';
import { stageCollectionPublicationStep } from '../../src/library/collection-publication-staging.ts';
import { partitionOf } from '../../src/route/route.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { WorkContext } from '../../src/work/registry.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { membersPreparationRuntime } from './support/members-preparation-runtime.ts';

let n: Awaited<ReturnType<typeof membersPreparationRuntime>>;
const originalReceiptKeys = process.env.KERNEL_RECEIPT_KEYS;
beforeAll(async () => {
  process.env.KERNEL_RECEIPT_KEYS = [...testReceiptKeys().keys]
    .map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`)
    .join(',');
  n = await membersPreparationRuntime();
  n.db.pool.options.max = 4;
  await n.workClient.registerQueue('maintenance', WORK_QUEUES.maintenance);
  await setupSemantic(n.db.pool, bundledRelease);
  for (const group of ['personal_library', 'reading_progress'])
    expect((await n.send(n.personas.staff, 'POST', `/v1/platform/exposure/${group}:open`, {})).status).toBe(200);
});
afterAll(async () => {
  await n?.close();
  if (originalReceiptKeys === undefined) delete process.env.KERNEL_RECEIPT_KEYS;
  else process.env.KERNEL_RECEIPT_KEYS = originalReceiptKeys;
});

for (const visibility of ['public', 'unlisted'] as const)
  test(`saved query publishes every native page as ${visibility}, survives staging crash and rechecks reduced authority`, async () => {
    const owner = await n.person();
    const creator = await n.person();
    const consent = createCurrentConsentReader({ database: n.auth.authPool });
    const context: WorkContext = {
      pool: n.db.pool,
      client: n.workClient,
      queues: WORK_QUEUES,
      env: {},
      clock: () => new Date(),
      getAuthorization: () => ({
        access: n.kernel.testAccess,
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      }),
      addEffects() {},
      addService() {},
    };
    bindCanonicalSourceWork(context);
    const state = selectLibraryProfile(bundledRelease, 'schema:Book')?.entryStateSet?.states[0]?.id;
    if (!state) throw new Error('Released Book entry state required');
    const subjects: string[] = [];
    for (let i = 0; i < 18; i++) {
      const response = await n.send(creator, 'POST', '/v1/subjects', {
        type: 'schema:Book',
        labels: { en: `Publication ${i}` },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const subject = (await response.json()).subject.id;
      subjects.push(subject);
      expect((await n.send(owner, 'PUT', `/v1/libraryEntries/${subject}`, { state })).status).toBe(201);
    }
    const created = await n.send(owner, 'POST', '/v1/collections', {
      membershipKind: 'dynamic',
      title: 'Complete saved view',
      visibility: 'private',
      rule: { filter: { owner: { presence: true } } },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { collection } = await created.json();
    const actor = await n.actor(owner);
    if (actor.kind !== 'account') throw new Error('Native owner required');
    const episodes = createCollectionPublicationEpisodes({ pool: n.db.pool, access: n.kernel.testAccess });
    const input = { collectionId: collection.id, revision: collection.revision, visibility };
    const key = randomUUID();
    const begun = await episodes.begin(actor, input, key);
    const locator = begun.value.locator;
    expect((await episodes.begin(actor, input, key)).value.locator).toEqual(locator);
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      const progress = await prepareCollectionPublicationSource(context, {
        ...locator,
        accounts: [owner.accountId],
      }).catch(async (cause) => {
        const { rows } = await n.db.pool.query(
          `SELECT s.identity,s.frontier,s.capture_id,c.source_generation,c.visibility,
             c.collection_id::text || ':' || extract(epoch FROM c.created_at)::text AS incarnation,
             a.state,a.authn_fenced,p.epoch
             FROM library.canonical_source_scope s JOIN library.collection c USING(route,collection_id)
             JOIN access.account a ON a.route=c.route AND a.account_id=c.curator_account_id
             JOIN core.partition p ON p.partition_no=$3 WHERE s.route=$1 AND s.collection_id=$2`,
          [locator.route, collection.id, partitionOf(locator.route)],
        );
        throw new Error(`Native Source preparation step ${i}: ${JSON.stringify(rows)}`, { cause });
      });
      ready = progress === 'ready';
    }
    expect(ready).toBe(true);
    const selected = async () =>
      (
        await n.db.pool.query(
          'SELECT generation::text FROM library.collection_source_output_head WHERE route=$1 AND collection_id=$2',
          [locator.route, collection.id],
        )
      ).rows;
    const stage = (crash = false) => {
      const deadline = Date.now() + 30000;
      return runOperationalTransaction(
        n.db.pool,
        {
          mode: 'work-step',
          partition: partitionOf(locator.route),
          kind: 'library.collectionPublication.step',
          accounts: [owner.accountId],
          workClient: n.workClient,
          deadline,
        },
        async (tx) => {
          const result = await stageCollectionPublicationStep(tx, locator, {
            pool: n.db.pool,
            client: createOpenSearch('http://127.0.0.1:1'),
            prefix: 'rezics-',
            source: createRatedSubjectSource(n.db.pool, testRouteKey()).source,
            allowance: collectionPublicationStepAllowance(randomUUID()),
            evidence: {
              access: n.kernel.testAccess,
              routeKey: testRouteKey(),
              deadline,
              work: { kind: 'collection-publication', tx, locator },
            },
          });
          if (crash) throw new Error('staging crash before commit');
          return result;
        },
      );
    };
    const crashed = await stage(true).then(
      () => {
        throw new Error('Staging committed before crash');
      },
      (error: unknown) => error,
    );
    if (!(crashed instanceof Error) || crashed.message !== 'staging crash before commit') throw crashed;
    expect(await selected()).toEqual([]);
    let result = await stage();
    expect(result.state).toBe('more');
    for (let i = 0; i < 100 && result.state !== 'sealed'; i++) result = await stage();
    expect(result.state).toBe('sealed');
    expect((await stage()).state).toBe('sealed');
    expect(await selected()).toEqual([]);
    const activate = createCollectionPublicationFinalActivation({ workContext: context });
    const originalConsent = await consent.readCurrentConsent({
      actorAccountId: actor.accountId,
      clientId: actor.clientId,
    });
    if (!originalConsent) throw new Error('Native current consent required');
    const setConsent = (scopes: readonly string[]) =>
      n.auth.authPool.query('UPDATE auth_consent SET scopes=$3 WHERE account_id=$1 AND client_id=$2', [
        actor.accountId,
        actor.clientId,
        scopes,
      ]);
    await setConsent(originalConsent.scopes.filter((scope) => scope !== 'library_entry:read'));
    await expect(activate.activate(locator, key)).rejects.toBeDefined();
    expect(await selected()).toEqual([]);
    // Restore exactly the original Auth fact after the negative authority probe.
    await setConsent(originalConsent.scopes);
    const complete = await activate.activate(locator, key);
    const episode = await readCollectionPublicationEpisode(n.db.pool, locator);
    if (!episode || episode.phase !== 'complete') throw new Error('Actual complete publication required');
    expect(complete.value.output).toEqual(episode.output.ref);
    expect((await activate.activate(locator, key)).replayed).toBe(true);
    expect((await episodes.begin(actor, input, key)).value.locator).toEqual(locator);
    const members = await n.db.pool.query(
      'SELECT subject_id::text AS id FROM library.collection_source_output_member WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id',
      [locator.route, collection.id, complete.value.output.generation],
    );
    expect(members.rows.map((row) => row.id)).toEqual(subjects.sort());
    expect((await selected())[0]?.generation).toBe(complete.value.output.generation);
    await setConsent(originalConsent.scopes.filter((scope) => scope !== 'progress_session:list'));
    await expect(activate.activate(locator, key)).rejects.toBeDefined();
    expect((await selected())[0]?.generation).toBe(complete.value.output.generation);
  }, 120000);
