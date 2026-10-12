import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { FusekiHttpError } from '../../../services/main/src/infrastructure/fuseki.ts';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import * as contentErasure from '../../../services/main/src/modules/erasure/content.ts';
import * as accountCoverage from '../../../services/account/src/recovery-coverage.ts';
import * as accessCoverage from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import * as commerceCoverage from '../../../services/main/src/modules/commerce/recovery-coverage.ts';
import * as pgCoverage from '../../../services/main/src/modules/work/pg-recovery-frontier.ts';
import * as subjectDeletion from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import * as relayCoverage from '../../../services/main/src/modules/outbox/relay.ts';
import * as journalCoverage from '../../../services/main/src/modules/erasure/core-journal-coverage.ts';
import * as erasureAuthority from '../../../services/main/src/modules/erasure/authority.ts';
import * as custody from '../../../services/main/src/modules/erasure/custody.ts';
import * as graphErasure from '../../../services/main/src/modules/erasure/graph.ts';
import * as graphReplay from '../../../services/main/src/modules/erasure/replay-graph.ts';
import * as modelCustody from '../../../services/main/src/modules/semantic/model-custody.ts';
import {
  ObjectIntegrityError,
  ObjectUnavailable,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { RestoreLineageConflict } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { readGraphErasureProof } from '../../../services/main/src/modules/erasure/graph.ts';
import { readErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import * as binding from '../../../services/main/src/modules/owner/restore-release-binding.ts';
import * as restoreLineage from '../../../services/main/src/modules/work/restore-lineage.ts';
import * as erasureReconcile from '../../../services/main/src/modules/erasure/reconcile.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { finishOperatorRestore } from '../../../scripts/ops/restore.ts';
import { RecoveryRefusal } from '../../../scripts/ops/recovery-set.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  accessFence,
  failAccessCommit,
  failOuterOutcome,
  graphReleased,
  liveAccess,
  operatorContext,
  outerOperation,
  ownerLogins,
  ownerRestoreErasureFixture,
  repairAccessCommit,
  repairOuterOutcome,
  type Copy,
} from './owner-restore-erasure-fixture.ts';

/** Restore the exact outer custody after a deliberate refusal, without recapturing authority. */
async function preservedOuter(copy: Copy, key: string) {
  const outer = await outerOperation(copy, key);
  const items = (
    await copy.retainedRelay.query<{ row: object }>(
      `SELECT to_jsonb(i) AS row FROM relay.owner_reconciliation_item i
     WHERE reconciliation_id=$1 ORDER BY ordinal`,
      [outer.id],
    )
  ).rows;
  return async () => {
    await copy.faultRetained([
      {
        sql: 'DELETE FROM relay.owner_reconciliation_item WHERE reconciliation_id=$1',
        values: [outer.id],
      },
      ...items.map(({ row }) => ({
        sql: 'INSERT INTO relay.owner_reconciliation_item SELECT * FROM jsonb_populate_record(NULL::relay.owner_reconciliation_item,$1::jsonb)',
        values: [JSON.stringify(row)],
      })),
      {
        sql: 'UPDATE relay.owner_reconciliation SET state=$2, hold_reason=$3 WHERE id=$1',
        values: [outer.id, outer.state, outer.hold_reason],
      },
    ]);
    expect(await outerOperation(copy, key)).toEqual(outer);
    expect(
      (
        await copy.retainedRelay.query(
          `SELECT to_jsonb(i) AS row FROM relay.owner_reconciliation_item i
       WHERE reconciliation_id=$1 ORDER BY ordinal`,
          [outer.id],
        )
      ).rows,
    ).toEqual(items);
  };
}

type QualificationArgs = Parameters<typeof binding.requireQualification>;

function ownerFailure(code: string): Error {
  return code === 'integrity'
    ? new RestoreLineageConflict('integrity mismatch: connection timeout ECONNRESET 57P01')
    : code === '503'
      ? new FusekiHttpError('Fuseki query returned 503', 503, 'Service Unavailable')
      : Object.assign(new Error('owner unavailable'), { code });
}

/** Fault only SQL executed on clients borrowed by this restore pass. */
function interruptSql(pool: Pool, needle: string, failure: Error) {
  const connect = pool.connect.bind(pool);
  let hits = 0;
  const restores: (() => void)[] = [];
  const installed = new Set<PoolClient>();
  const install = (client: PoolClient) => {
    // A pool may lend the same client to its preliminary read and held pass.
    // Replacing one Bun spy twice would bind its fallback to itself.
    if (installed.has(client)) return client;
    installed.add(client);
    const query = client.query.bind(client);
    const injected = spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
      const sql = args[0];
      if (typeof sql === 'string' && sql.includes(needle)) {
        hits++;
        throw failure;
      }
      return Reflect.apply(query, client, args);
    }) as typeof client.query);
    restores.push(() => injected.mockRestore());
    return client;
  };
  // pg Pool.query borrows through the callback overload. Forward that contract
  // too, or a fault helper itself leaves every pool-level read waiting forever.
  const borrowed = spyOn(pool, 'connect').mockImplementation(((
    callback?: Parameters<Pool['connect']>[0],
  ) => callback
    ? connect((error, client, release) => callback(error, client ? install(client) : client, release))
    : connect().then(install)) as typeof pool.connect);
  return { get hits() { return hits; }, restore: () => {
    borrowed.mockRestore();
    for (const restore of restores.reverse()) restore();
  } };
}

test(
  'OPS12: later-admission restore refuses partial replay and resumes every durable owner interruption without duplicate effects',
  async () => {
    const started = Date.now();
    const fixture = await ownerRestoreErasureFixture({ laterApiAdmission: true });
    const later = fixture.laterAdmission!;
    const body = {
      profile: 'owner-reconciliation-v1' as const,
      kind: 'restore' as const,
      sealedCoverage: fixture.baseAuthority.sealedCoverage,
      retainedAuthorityCoverage: fixture.currentAuthority.sealedCoverage,
      sealedDeletionSets: [],
    };
    const base = {
      state: {
        count: fixture.baseCoverage.accessStateCount,
        digest: fixture.baseCoverage.accessStateDigest,
      },
      outbox: {
        count: fixture.baseCoverage.accessOutboxCount,
        digest: fixture.baseCoverage.accessOutboxDigest,
      },
    };
    const current = {
      state: {
        count: fixture.currentCoverage.accessStateCount,
        digest: fixture.currentCoverage.accessStateDigest,
      },
      outbox: {
        count: fixture.currentCoverage.accessOutboxCount,
        digest: fixture.currentCoverage.accessOutboxDigest,
      },
    };
    const attachment = readFileSync(fixture.nativeAccessAttachment!.path);
    const ciphertextDigest = createHash('sha256').update(attachment).digest('hex');
    let responseStatus: number | undefined;
    const attempt = async (copy: Copy, key: string, input = body) => {
      const attemptStarted = Date.now();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          finishOperatorRestore(
            operatorContext(fixture, copy),
            {
              reconcile: async (_context, _body, id) => {
                const response = await copy.request(id, undefined, input);
                responseStatus = response.status;
                return response;
              },
            },
            key,
            () => {},
          ),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('operator restore exceeded 180 s hang deadline')),
              180_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        const elapsedMs = Date.now() - attemptStarted;
        console.info('later admission interruption operator duration', { key, elapsedMs });
        expect(elapsedMs).toBeLessThan(180_000);
      }
    };
    const closed = async (copy: Copy, released = false) => {
      expect(await graphReleased(copy)).toBe(released);
      expect(await accessFence(copy)).toEqual([{ open: false, generation: fixture.generation }]);
      expect((await copy.ready()).status).toBe(503);
      expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
        false,
        false,
        false,
        false,
      ]);
      await expect(
        new admission.AccessAdmissionRegistry(copy.owners.access).activePrincipalId(
          fixture.principal,
        ),
      ).rejects.toBeInstanceOf(admission.AdmissionUnavailable);
    };
    const exactNativeAdmission = async (copy: Copy, count: number) => {
      expect(
        (
          await copy.owners.access.query(
            'SELECT count(*)::int AS count FROM access.admission WHERE id=$1',
            [later.admissionId],
          )
        ).rows,
      ).toEqual([{ count }]);
    };
    const noDuplicateRetry = async (copy: Copy, key: string) => {
      const before = await outerOperation(copy, key);
      const access = await liveAccess(copy);
      const journal = await readErasure(copy.retainedRelay, later.erasureId);
      const content = new ContentCore(copy.owners.content);
      const revisions = await content.readExactBatch(
        [fixture.revisionId, fixture.laterRevisionId],
        async (ids) => new Set(ids),
      );
      const graphProof = await readGraphErasureProof(
        copy.fuseki,
        copy.lineage,
        later.erasureId,
        later.erasureEpoch,
        [fixture.revisionId],
      );
      const maintenance = spyOn(copy.resources.erasures!.maintenance, 'command');
      const commands = spyOn(copy.fuseki, 'commandWithReceipt');
      const imported = spyOn(copy.resources, 'nativeAccessAttachment');
      const released = spyOn(admission, 'releaseAccessRecoveryFence');
      try {
        await attempt(copy, key);
        expect(maintenance).not.toHaveBeenCalled();
        expect(commands).not.toHaveBeenCalled();
        expect(imported).not.toHaveBeenCalled();
        expect(released).not.toHaveBeenCalled();
      } finally {
        released.mockRestore();
        imported.mockRestore();
        commands.mockRestore();
        maintenance.mockRestore();
      }
      expect(await outerOperation(copy, key)).toEqual(before);
      expect(await liveAccess(copy)).toEqual(access);
      expect(await readErasure(copy.retainedRelay, later.erasureId)).toEqual(journal);
      expect(
        await content.readExactBatch(
          [fixture.revisionId, fixture.laterRevisionId],
          async (ids) => new Set(ids),
        ),
      ).toEqual(revisions);
      expect(
        await readGraphErasureProof(
          copy.fuseki,
          copy.lineage,
          later.erasureId,
          later.erasureEpoch,
          [fixture.revisionId],
        ),
      ).toEqual(graphProof);
      expect(graphProof).toEqual(fixture.original);
      expect(revisions[0]?.status).toBe('erased');
      expect(revisions[1]?.status).toBe('available');
      await exactNativeAdmission(copy, 1);
      expect(await accessFence(copy)).toEqual([
        { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
      ]);
      expect((await copy.ready()).status).toBe(200);
      expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
        true,
        true,
        true,
        true,
      ]);
    };
    try {
      expect(later).toBeDefined();
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();

      // A real graph suppression commits, but Content replay cannot finish.
      // There is no qualification: the held outcome must never resume its changed base.
      const partial = await fixture.copy();
      try {
        const key = randomUUID();
        const content = new ContentCore(partial.owners.content);
        const revisions = await content.readExactBatch(
          [fixture.revisionId, fixture.laterRevisionId],
          async (ids) => new Set(ids),
        );
        const maintenance = spyOn(partial.resources.erasures!.maintenance, 'command');
        const nativeCommands = spyOn(partial.fuseki, 'commandWithReceipt');
        const contentFailure = spyOn(contentErasure, 'applyContentErasure').mockImplementation(
          async (_pool, command) => {
            expect(command.graphProof).toEqual(fixture.original);
            throw new contentErasure.ContentErasureStale(
              'fault: Content interrupted after committed graph suppression',
            );
          },
        );
        try {
          await expect(attempt(partial, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          expect(contentFailure).toHaveBeenCalled();
          expect(maintenance).toHaveBeenCalledTimes(1);
        } finally {
          contentFailure.mockRestore();
        }
        const held = await outerOperation(partial, key);
        expect(held.state).toBe('held');
        expect(held.hold_reason).toMatch(/retained erasure reconciliation is held/);
        expect(held.qualifications).toHaveLength(0);
        expect(held.releases).toHaveLength(0);
        expect(await liveAccess(partial)).toEqual(base);
        await exactNativeAdmission(partial, 0);
        await closed(partial);
        maintenance.mockClear();
        nativeCommands.mockClear();
        try {
          await expect(attempt(partial, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          expect(maintenance).not.toHaveBeenCalled();
          expect(nativeCommands).not.toHaveBeenCalled();
        } finally {
          nativeCommands.mockRestore();
          maintenance.mockRestore();
        }
        expect(await outerOperation(partial, key)).toEqual(held);
        expect(
          await content.readExactBatch(
            [fixture.revisionId, fixture.laterRevisionId],
            async (ids) => new Set(ids),
          ),
        ).toEqual(revisions);
        await closed(partial);
        console.info('later admission interruption proved', {
          case: 'prequalification-partial-replay-held',
        });
      } finally {
        await partial.dispose();
      }

      // PostgreSQL commits the relay qualification before the Access transaction.
      // A deferred fault at that commit leaves authentic qualification and exact C0.
      const rolledBack = await fixture.copy();
      try {
        const key = randomUUID();
        await rolledBack.owners.access.query(`CREATE FUNCTION access.fail_native_delta_commit()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'fault: native Access qualification commit connection lost' USING ERRCODE='08006';
          END $$`);
        await rolledBack.owners.access.query(`CREATE CONSTRAINT TRIGGER fail_native_delta_commit
          AFTER INSERT ON access.admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          WHEN (NEW.id='${later.admissionId}'::uuid) EXECUTE FUNCTION access.fail_native_delta_commit()`);
        try {
          await expect(attempt(rolledBack, key)).rejects.toBeInstanceOf(RecoveryRefusal);
        } finally {
          await rolledBack.owners.access.query(
            'DROP TRIGGER fail_native_delta_commit ON access.admission',
          );
          await rolledBack.owners.access.query('DROP FUNCTION access.fail_native_delta_commit()');
        }
        const interrupted = await outerOperation(rolledBack, key);
        expect(interrupted).toMatchObject({ state: 'running', hold_reason: null });
        expect(interrupted.erasures?.state).toBe('reconciled');
        expect(interrupted.qualifications).toHaveLength(1);
        expect(interrupted.releases).toHaveLength(0);
        expect(await liveAccess(rolledBack)).toEqual(base);
        await exactNativeAdmission(rolledBack, 0);
        await closed(rolledBack);
        const maintenance = spyOn(rolledBack.resources.erasures!.maintenance, 'command');
        const imported = spyOn(rolledBack.resources, 'nativeAccessAttachment');
        const qualified = spyOn(binding, 'recordQualification');
        try {
          await attempt(rolledBack, key);
          expect(imported).toHaveBeenCalledTimes(1);
          expect(maintenance).not.toHaveBeenCalled();
          expect(qualified).not.toHaveBeenCalled();
        } finally {
          qualified.mockRestore();
          imported.mockRestore();
          maintenance.mockRestore();
        }
        const done = await outerOperation(rolledBack, key);
        expect(done.state).toBe('reconciled');
        expect(done.erasures).toEqual(interrupted.erasures);
        expect(done.qualifications).toEqual(interrupted.qualifications);
        expect(done.releases).toHaveLength(1);
        await noDuplicateRetry(rolledBack, key);
        console.info('later admission interruption proved', {
          case: 'qualification-survives-D-rollback-C0',
        });
      } finally {
        await rolledBack.dispose();
      }

      // This candidate begins with a non-resume qualification, so both commits
      // survive. Its subsequent interruptions exercise the distinct C1 resume.
      const qualified = await fixture.copy();
      try {
        const key = randomUUID();
        const stopBeforeRelease = spyOn(binding, 'captureReleaseBasis').mockImplementation(
          async () => {
            throw new Error('fault: interrupted after durable qualification before native release');
          },
        );
        try {
          await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          expect(stopBeforeRelease).toHaveBeenCalledTimes(1);
        } finally {
          stopBeforeRelease.mockRestore();
        }
        const interrupted = await outerOperation(qualified, key);
        expect(interrupted).toMatchObject({ state: 'running', hold_reason: null });
        expect(interrupted.erasures?.state).toBe('reconciled');
        expect(interrupted.qualifications).toHaveLength(1);
        expect(interrupted.releases).toHaveLength(0);
        expect(await liveAccess(qualified)).toEqual(current);
        await exactNativeAdmission(qualified, 1);
        await closed(qualified);

        const restoreOuter = await preservedOuter(qualified, key);
        const maintenance = spyOn(qualified.resources.erasures!.maintenance, 'command');
        let graphCommands = spyOn(qualified.fuseki, 'commandWithReceipt');
        const imported = spyOn(qualified.resources, 'nativeAccessAttachment');
        const requalified = spyOn(binding, 'recordQualification');
        const actualRequire = binding.requireQualification;
        // D and replay have committed: C0 cannot admit a fresh operation. Every
        // adapter must leave this exact operation retryable on transport loss.
        // The unit table completes an independent same-key operation per site;
        // this native C1 drill keeps the same durable findings across all sites
        // and completes it below without importing D or replaying erasures again.
        const qualifiedSites = [
          ['Access outbox', () => spyOn(accessCoverage, 'scanAccessOutbox')],
          ['Access state', () => spyOn(accessCoverage, 'scanAccessState')],
          ['Commerce', () => spyOn(commerceCoverage, 'assertCommerceRecoveryCoverageOnClient')],
          ['Account WAL', () => spyOn(pgCoverage, 'assertPgRecoveryFrontier')],
          ['Account rows', () => spyOn(accountCoverage, 'assertAccountRecoveryCoverage')],
          [
            'Account absent subjects',
            () => spyOn(subjectDeletion, 'assertAccountSubjectDeletionsAbsent'),
          ],
          ['captured relay scan', () => spyOn(relayCoverage, 'relayCoverageOnClient')],
          [
            'captured journal scan',
            () => spyOn(journalCoverage, 'captureErasureJournalCoreCoverage'),
          ],
          [
            'retained two-cut journal scan',
            () => {
              const actual = journalCoverage.captureErasureJournalCoreCoverage;
              return spyOn(
                journalCoverage,
                'captureErasureJournalCoreCoverage',
              ).mockImplementationOnce(actual);
            },
            2,
          ],
          ['retained relay prefix', () => spyOn(relayCoverage, 'relayPrefixCoverageOnClient')],
          [
            'retained relay scan',
            () => {
              const actual = relayCoverage.relayCoverageOnClient;
              return spyOn(relayCoverage, 'relayCoverageOnClient').mockImplementationOnce(actual);
            },
            2,
          ],
          [
            'retained suppression originals',
            () => spyOn(custody, 'readRetainedNativeGraphSuppressionProof'),
          ],
          ['retained authority', () => spyOn(erasureAuthority, 'assertRetainedAuthorityCapture')],
          ['retained reconciliation / Content basis', () => spyOn(binding, 'captureReleaseBasis')],
          ['native graph release', () => spyOn(qualified.fuseki, 'commandWithReceipt')],
        ] as const;
        for (const [site, install, calls = 1] of qualifiedSites) {
          for (const code of ['503', 'ECONNRESET', '57P01', 'integrity']) {
            const failure = ownerFailure(code);
            const injected = install().mockImplementationOnce(async () => {
              throw failure;
            });
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(injected).toHaveBeenCalledTimes(calls);
              const failed = await outerOperation(qualified, key);
              expect(failed.state).toBe(code === 'integrity' ? 'held' : 'running');
              if (code !== 'integrity') {
                expect(responseStatus).toBe(503);
                expect(failed.hold_reason).toBeNull();
              }
              expect(failed.erasures).toEqual(interrupted.erasures);
              expect(failed.qualifications).toEqual(interrupted.qualifications);
              expect(failed.releases).toHaveLength(0);
              expect(await liveAccess(qualified)).toEqual(current);
              expect(maintenance).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              await closed(qualified);
              console.info('qualified owner wrapper proved', { site, code, state: failed.state });
            } finally {
              injected.mockRestore();
              // A terminal mismatch is deliberately isolated just like the
              // binding-denial matrix; ordinary transport retries need no repair.
              if (code === 'integrity') await restoreOuter();
            }
          }
        }

        // Inject inside the adapters, so replacing their original cause or
        // swallowing it as a proof mismatch is observable in the outer state.
        const innerSites = [
          'qualification binding findings SQL',
          'retained authority head SQL',
          'retained relay checkpoint SQL',
          'custody command inventory SQL',
          'historical receipt custody SQL',
          'Structure group custody SQL',
          'Structure qualifier custody SQL',
          'held graph proof query',
          'erased graph assertion query',
          'model manifest object GET',
          'model state object GET',
        ] as const;
        for (const site of innerSites) {
          for (const code of ['503', 'ECONNRESET', '57P01', 'integrity']) {
            const failure = ownerFailure(code);
            let hits = 0;
            const stop: (() => void)[] = [];
            const fail = () => {
              hits++;
              throw failure;
            };
            const insideRelayQuery = async <T>(
              client: Pool | PoolClient,
              needle: string,
              operation: () => Promise<T>,
            ): Promise<T> => {
              const query = client.query.bind(client);
              const injected = spyOn(client, 'query').mockImplementation(((
                sql: string,
                values?: unknown[],
              ) => {
                if (sql.includes(needle)) fail();
                return query(sql, values);
              }) as typeof client.query);
              try {
                return await operation();
              } finally {
                injected.mockRestore();
              }
            };
            if (site === 'qualification binding findings SQL') {
              const actual = binding.requireQualification;
              const injected = spyOn(binding, 'requireQualification').mockImplementationOnce(
                async (...args) =>
                  insideRelayQuery(args[0], 'FROM relay.owner_reconciliation_item', () =>
                    actual(...args),
                  ),
              );
              stop.push(() => injected.mockRestore());
            } else if (site === 'retained authority head SQL') {
              const actual = erasureAuthority.assertRetainedAuthorityCapture;
              const injected = spyOn(
                erasureAuthority,
                'assertRetainedAuthorityCapture',
              ).mockImplementationOnce(async (...args) =>
                insideRelayQuery(args[0], 'FROM relay.recovery_coverage_head', () =>
                  actual(...args),
                ),
              );
              stop.push(() => injected.mockRestore());
            } else if (site === 'retained relay checkpoint SQL') {
              const actual = relayCoverage.relayPrefixCoverageOnClient;
              const injected = spyOn(
                relayCoverage,
                'relayPrefixCoverageOnClient',
              ).mockImplementationOnce(async (...args) =>
                insideRelayQuery(args[0], 'FROM relay.checkpoint', () => actual(...args)),
              );
              stop.push(() => injected.mockRestore());
            } else if (
              site === 'custody command inventory SQL' ||
              site === 'historical receipt custody SQL'
            ) {
              const actual = custody.restoredCustodyDigests;
              const outer = spyOn(custody, 'restoredCustodyDigests').mockImplementationOnce(
                async (...args) => {
                  const client = args[3]!;
                  const query = client.query.bind(client);
                  const injected = spyOn(client, 'query').mockImplementation(((
                    sql: string,
                    values?: unknown[],
                  ) => {
                    if (
                      sql.includes(
                        site === 'custody command inventory SQL'
                          ? 'FROM access.command_custody WHERE receipt >'
                          : 'FROM access.command_custody WHERE data_epoch=',
                      )
                    )
                      fail();
                    return query(sql, values);
                  }) as typeof client.query);
                  try {
                    return await actual(...args);
                  } finally {
                    injected.mockRestore();
                  }
                },
              );
              stop.push(() => outer.mockRestore());
            } else if (
              site === 'Structure group custody SQL' ||
              site === 'Structure qualifier custody SQL'
            ) {
              const pool = qualified.resources.contentPool;
              const query = pool.query.bind(pool);
              const injected = spyOn(pool, 'query').mockImplementation(((
                sql: string,
                values?: unknown[],
              ) => {
                if (
                  sql.includes(
                    site === 'Structure group custody SQL'
                      ? 'FROM structure.group_root ORDER BY'
                      : 'FROM structure.qualifier_root ORDER BY',
                  )
                )
                  fail();
                return query(sql, values);
              }) as typeof pool.query);
              stop.push(() => injected.mockRestore());
            } else if (
              site === 'held graph proof query' ||
              site === 'erased graph assertion query'
            ) {
              const enter = async <T>(operation: () => Promise<T>): Promise<T> => {
                const injected = spyOn(qualified.fuseki, 'query').mockImplementation(async () =>
                  fail(),
                );
                try {
                  return await operation();
                } finally {
                  injected.mockRestore();
                }
              };
              if (site === 'held graph proof query') {
                const actual = graphErasure.readGraphErasureProof;
                const injected = spyOn(
                  graphErasure,
                  'readGraphErasureProof',
                ).mockImplementationOnce(async (...args) => enter(() => actual(...args)));
                stop.push(() => injected.mockRestore());
              } else {
                const actual = graphReplay.assertGraphErasure;
                const injected = spyOn(graphReplay, 'assertGraphErasure').mockImplementationOnce(
                  async (...args) => enter(() => actual(...args)),
                );
                stop.push(() => injected.mockRestore());
              }
            } else {
              const actual = modelCustody.readExactModelGeneration;
              const outer = spyOn(modelCustody, 'readExactModelGeneration').mockImplementationOnce(
                async (env, generation) => {
                  const objects = env.workObjects!;
                  const get = objects.get.bind(objects);
                  const injected = spyOn(objects, 'get').mockImplementation(async (...args) => {
                    const manifest = args[0] === generation.slice(-64);
                    if (manifest === (site === 'model manifest object GET')) {
                      hits++;
                      const Failure =
                        code === 'integrity' ? ObjectIntegrityError : ObjectUnavailable;
                      throw new Failure(
                        code === 'integrity'
                          ? 'model object is corrupt'
                          : 'model object owner is unavailable',
                        {
                          cause: failure,
                        },
                      );
                    }
                    return get(...args);
                  });
                  try {
                    return await actual(env, generation);
                  } finally {
                    injected.mockRestore();
                  }
                },
              );
              stop.push(() => outer.mockRestore());
            }
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(hits).toBe(1);
              const failed = await outerOperation(qualified, key);
              expect(failed.state).toBe(code === 'integrity' ? 'held' : 'running');
              if (code !== 'integrity') expect(failed.hold_reason).toBeNull();
              expect(failed.erasures).toEqual(interrupted.erasures);
              expect(failed.qualifications).toEqual(interrupted.qualifications);
              expect(failed.releases).toHaveLength(0);
              expect(await liveAccess(qualified)).toEqual(current);
              expect(maintenance).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              await closed(qualified);
              console.info('qualified inner owner boundary proved', {
                site,
                code,
                state: failed.state,
              });
            } finally {
              for (const restore of stop.reverse()) restore();
              if (code === 'integrity') await restoreOuter();
            }
          }
        }
        graphCommands = spyOn(qualified.fuseki, 'commandWithReceipt');
        const denials: [string, (args: QualificationArgs) => void][] = [
          [
            'C0-envelope',
            (args) => {
              args[6]!.baseCoverageEnvelope += ' ';
            },
          ],
          [
            'C0-digest',
            (args) => {
              args[6]!.baseCoverageDigest = '0'.repeat(64);
            },
          ],
          [
            'C1-digest',
            (args) => {
              args[6]!.currentCoverageDigest = '0'.repeat(64);
            },
          ],
          [
            'D-digest',
            (args) => {
              args[6]!.nativeAccessDigest = '0'.repeat(64);
            },
          ],
          [
            'G0-binding',
            (args) => {
              args[6]!.baseFenceGeneration = '999999';
            },
          ],
          [
            'G0-release-generation',
            (args) => {
              args[4] = '999999';
            },
          ],
          [
            'J1-epoch',
            (args) => {
              args[6]!.journal.epoch = '999999';
            },
          ],
          [
            'J1-count',
            (args) => {
              args[6]!.journal.count = '999999';
            },
          ],
          [
            'J1-digest',
            (args) => {
              args[6]!.journal.digest = '0'.repeat(64);
            },
          ],
          [
            'native-data-epoch',
            (args) => {
              args[5].lineage.dataEpoch = randomUUID();
            },
          ],
          [
            'native-routing-epoch',
            (args) => {
              args[5].lineage.routingEpoch = randomUUID();
            },
          ],
          [
            'native-cutover',
            (args) => {
              args[5].restoreCutover += ':other';
            },
          ],
          [
            'native-saved-epoch',
            (args) => {
              args[5].saved.dataEpoch = randomUUID();
            },
          ],
          [
            'native-saved-sequence',
            (args) => {
              args[5].saved.graphSequence = '999999';
            },
          ],
          [
            'native-effective-epoch',
            (args) => {
              args[5].effective.dataEpoch = randomUUID();
            },
          ],
          [
            'native-effective-sequence',
            (args) => {
              args[5].effective.graphSequence = '999999';
            },
          ],
          [
            'erasures-id',
            (args) => {
              args[3].id = randomUUID();
            },
          ],
          [
            'erasures-consumer',
            (args) => {
              args[3].consumer += ':other';
            },
          ],
          [
            'erasures-request',
            (args) => {
              args[3].requestDigest = '0'.repeat(64);
            },
          ],
          [
            'erasures-outcome',
            (args) => {
              args[3].outcomeDigest = '0'.repeat(64);
            },
          ],
          [
            'coverage-generation',
            (args) => {
              args[3].coverageGeneration = '999999';
            },
          ],
          [
            'erasures-frontier',
            (args) => {
              args[3].erasureEpoch = '999999';
            },
          ],
          [
            'erasures-items',
            (args) => {
              args[3].items++;
            },
          ],
          [
            'erasures-cuts',
            (args) => {
              args[3].cuts = '0'.repeat(64);
            },
          ],
        ];
        for (const phase of ['saved', 'effective'] as const)
          for (const field of ['streamScope', 'dataEpoch', 'sequence'] as const)
            denials.push([
              `native-${phase}-main-${field}`,
              (args) => {
                expect(args[5][phase].main).toBeDefined();
                args[5][phase].main![field] = field === 'dataEpoch' ? randomUUID() : '999999';
              },
            ]);
        try {
          // Fault the real authenticator's bound identity one member at a time.
          // The recorded HMAC is untouched, and the authenticated route must hold.
          for (const [label, tamper] of denials) {
            const denied = spyOn(binding, 'requireQualification').mockImplementation(
              async (...args) => {
                args[3] = structuredClone(args[3]);
                args[5] = structuredClone(args[5]);
                args[6] = structuredClone(args[6]);
                expect(args[6]).toBeDefined();
                tamper(args);
                return actualRequire(...args);
              },
            );
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(denied).toHaveBeenCalledTimes(1);
              const held = await outerOperation(qualified, key);
              expect(held.state).toBe('held');
              expect(held.hold_reason).toBe(
                'durable restore qualification differs from the retained record',
              );
              expect(held.erasures).toEqual(interrupted.erasures);
              expect(maintenance).not.toHaveBeenCalled();
              expect(graphCommands).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              expect(await liveAccess(qualified)).toEqual(current);
              await closed(qualified);
              console.info('later admission binding refusal proved', {
                label,
                gate: held.hold_reason,
              });
            } finally {
              denied.mockRestore();
              await restoreOuter();
            }
          }
          await qualified.faultRetained(
            `UPDATE relay.owner_reconciliation_item SET item_ref=$2, evidence_digest=$3
             WHERE reconciliation_id=$1 AND item_ref LIKE 'restore-qualification:%'`,
            [interrupted.id, 'restore-qualification:' + 'a'.repeat(64), 'a'.repeat(64)],
          );
          try {
            await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
            expect((await outerOperation(qualified, key)).hold_reason).toBe(
              'durable restore qualification differs from the retained record',
            );
          } finally {
            await restoreOuter();
          }

          // Graph release may commit before Access release is attempted. Both
          // transport forms must leave this qualified key available for resume.
          for (const code of ['503', 'ECONNRESET']) {
            const injected = spyOn(admission, 'releaseAccessRecoveryFence').mockImplementationOnce(
              async () => { throw ownerFailure(code); },
            );
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(responseStatus).toBe(503);
              expect(injected).toHaveBeenCalledTimes(1);
              const failed = await outerOperation(qualified, key);
              expect(failed).toMatchObject({ state: 'running', hold_reason: null });
              expect(failed.erasures).toEqual(interrupted.erasures);
              expect(failed.qualifications).toEqual(interrupted.qualifications);
              expect(failed.releases).toHaveLength(0);
              await closed(qualified, true);
              console.info('restore phase interruption proved', { phase: 'Access release', code });
            } finally { injected.mockRestore(); }
          }

          // Native release and the relay finding commit, while Access rolls back
          // its CAS to the same exact C1. No D import or replay is needed on retry.
          await failAccessCommit(qualified);
          try {
            await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          } finally {
            await repairAccessCommit(qualified);
          }
          const nativeReleased = await outerOperation(qualified, key);
          expect(nativeReleased).toMatchObject({ state: 'running', hold_reason: null });
          expect(nativeReleased.erasures).toEqual(interrupted.erasures);
          expect(nativeReleased.qualifications).toEqual(interrupted.qualifications);
          expect(nativeReleased.releases).toHaveLength(1);
          expect(await liveAccess(qualified)).toEqual(current);
          await closed(qualified, true);
          expect(maintenance).not.toHaveBeenCalled();
          expect(imported).not.toHaveBeenCalled();
          expect(requalified).not.toHaveBeenCalled();
          expect(graphCommands).toHaveBeenCalledTimes(1);
          graphCommands.mockClear();

          let commitCandidates = nativeReleased.releases;
          for (const code of ['503', 'ECONNRESET']) {
            const injected = interruptSql(qualified.resources.accessPool, 'COMMIT', ownerFailure(code));
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(responseStatus).toBe(503);
              expect(injected.hits).toBe(1);
            } finally { injected.restore(); }
            const failed = await outerOperation(qualified, key);
            expect({ ...failed, releases: [] }).toEqual({ ...nativeReleased, releases: [] });
            // Sequence allocation survives rollback. Each attempted CAS therefore
            // retains one distinct signed candidate, while live C1 stays exact.
            expect(failed.releases.slice(0, -1)).toEqual(commitCandidates);
            expect(failed.releases).toHaveLength(commitCandidates.length + 1);
            expect(new Set(failed.releases).size).toBe(failed.releases.length);
            commitCandidates = failed.releases;
            expect(await liveAccess(qualified)).toEqual(current);
            expect(maintenance).not.toHaveBeenCalled();
            expect(graphCommands).not.toHaveBeenCalled();
            expect(imported).not.toHaveBeenCalled();
            expect(requalified).not.toHaveBeenCalled();
            await closed(qualified, true);
            console.info('restore phase interruption proved', { phase: 'Access commit', code });
          }

          // Both releases now commit, but the outer matched outcome rolls back.
          // The next attempt enters completeReleasedRestore instead of release.
          for (const code of ['503', 'ECONNRESET']) {
            const injected = interruptSql(qualified.retainedRelay,
              'coverage_generation = $2, outcome_digest = $3', ownerFailure(code));
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(responseStatus).toBe(503);
              expect(injected.hits).toBe(1);
            } finally { injected.restore(); }
            expect(await outerOperation(qualified, key)).toMatchObject({ state: 'running', hold_reason: null });
            expect(await graphReleased(qualified)).toBe(true);
            expect(await accessFence(qualified)).toEqual([
              { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
            ]);
            console.info('restore phase interruption proved', { phase: 'final outcome write', code });
          }

          await failOuterOutcome(qualified, key);
          try {
            await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
          } finally {
            await repairOuterOutcome(qualified);
          }
          const lost = await outerOperation(qualified, key);
          expect(lost).toMatchObject({ state: 'running', hold_reason: null });
          expect(lost.erasures).toEqual(interrupted.erasures);
          expect(lost.qualifications).toEqual(interrupted.qualifications);
          expect(lost.releases.slice(0, -1)).toEqual(commitCandidates);
          expect(lost.releases).toHaveLength(commitCandidates.length + 1);
          expect(await graphReleased(qualified)).toBe(true);
          expect(await accessFence(qualified)).toEqual([
            { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
          ]);
          expect((await ownerLogins(qualified)).map((row) => row.rolcanlogin)).toEqual([
            false,
            false,
            false,
            false,
          ]);
          expect(maintenance).not.toHaveBeenCalled();
          expect(graphCommands).not.toHaveBeenCalled();
          expect(imported).not.toHaveBeenCalled();
          expect(requalified).not.toHaveBeenCalled();

          const completionSites = [
            'opened graph expectation query',
            'opened graph release proof',
            'opened erased closure',
          ] as const;
          for (const phase of completionSites) {
            for (const code of ['503', 'ECONNRESET']) {
              const failure = ownerFailure(code);
              let hits = 0;
              const fail = async () => { hits++; throw failure; };
              const query = qualified.fuseki.query.bind(qualified.fuseki);
              const injected = phase === 'opened graph expectation query'
                ? spyOn(qualified.fuseki, 'query').mockImplementation(sparql =>
                    sparql.includes('SELECT ?savedMainSequence ?reconciledMainSequence ?savedSequence')
                      ? fail() : query(sparql))
                : phase === 'opened graph release proof'
                  ? spyOn(restoreLineage, 'readRestoredGraphReleaseProof').mockImplementationOnce(fail)
                  : spyOn(erasureReconcile, 'assertReleasedErasuresCurrent').mockImplementationOnce(
                      async () => { hits++; throw new RestoreLineageConflict('released owner proof unavailable', { cause: failure }); },
                    );
              try {
                await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
                expect(responseStatus).toBe(503);
                expect(hits).toBe(1);
                expect(await outerOperation(qualified, key)).toEqual(lost);
                expect(await graphReleased(qualified)).toBe(true);
                expect((await ownerLogins(qualified)).every(row => !row.rolcanlogin)).toBe(true);
                expect(maintenance).not.toHaveBeenCalled();
                expect(graphCommands).not.toHaveBeenCalled();
                expect(imported).not.toHaveBeenCalled();
                expect(requalified).not.toHaveBeenCalled();
                console.info('restore phase interruption proved', { phase, code });
              } finally { injected.mockRestore(); }
            }
          }

          // Completion must authenticate every persisted release member, even
          // while live owners already have their exact opened post-state.
          const restoreLost = await preservedOuter(qualified, key);
          const accessAfter = await liveAccess(qualified);
          const release = lost.releases.at(-1)!;
          for (const [label, index] of [
            ['release-HMAC', 1],
            ['post-state-count', 2],
            ['post-state-digest', 3],
            ['post-outbox-count', 4],
            ['post-outbox-digest', 5],
            ['discovery-invalidation', 6],
            ['also-enjoyed-invalidation', 7],
          ] as const) {
            const changed = release.split(':');
            changed[index] = [1, 3, 5].includes(index) ? '0'.repeat(64) : '999999';
            await qualified.faultRetained(
              `UPDATE relay.owner_reconciliation_item SET item_ref=$2, evidence_digest=$3
               WHERE reconciliation_id=$1 AND item_ref=$4`,
              [lost.id, changed.join(':'), '0'.repeat(64), release],
            );
            try {
              await expect(attempt(qualified, key)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect((await outerOperation(qualified, key)).state).toBe('held');
              expect(await liveAccess(qualified)).toEqual(accessAfter);
              expect(await graphReleased(qualified)).toBe(true);
              expect((await ownerLogins(qualified)).map((row) => row.rolcanlogin)).toEqual([
                false,
                false,
                false,
                false,
              ]);
              expect(maintenance).not.toHaveBeenCalled();
              expect(graphCommands).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              console.info('later admission binding refusal proved', {
                label,
                phase: 'released-completion',
              });
            } finally {
              await restoreLost();
            }
          }

          // LOGIN is operator-owned and follows a matched API result. Retrying
          // its interruption must replay that result, never release owners again.
          for (const phase of ['LOGIN release', 'LOGIN readback'] as const) {
            for (const code of ['503', 'ECONNRESET']) {
              const failure = ownerFailure(code);
              const injected = interruptSql(qualified.owners.account,
                phase === 'LOGIN release' ? 'ALTER ROLE account LOGIN' : 'FROM pg_roles', failure);
              try {
                let caught: unknown;
                try { await attempt(qualified, key); } catch (error) { caught = error; }
                expect(caught).toBeInstanceOf(Error);
                expect(restoreLineage.isRestoreTransientFailure(caught)).toBe(true);
                expect(responseStatus).toBe(200);
                expect(injected.hits).toBe(1);
              } finally { injected.restore(); }
              const matched = await outerOperation(qualified, key);
              expect(matched.state).toBe('reconciled');
              expect(matched.erasures).toEqual(lost.erasures);
              expect(matched.qualifications).toEqual(lost.qualifications);
              expect(matched.releases).toEqual(lost.releases);
              expect((await ownerLogins(qualified)).every(row => row.rolcanlogin)).toBe(
                phase === 'LOGIN readback',
              );
              expect(maintenance).not.toHaveBeenCalled();
              expect(graphCommands).not.toHaveBeenCalled();
              expect(imported).not.toHaveBeenCalled();
              expect(requalified).not.toHaveBeenCalled();
              console.info('restore phase interruption proved', { phase, code });
            }
          }

          const released = spyOn(admission, 'releaseAccessRecoveryFence');
          try {
            await attempt(qualified, key);
            expect(released).not.toHaveBeenCalled();
          } finally {
            released.mockRestore();
          }
          const done = await outerOperation(qualified, key);
          expect(done.state).toBe('reconciled');
          expect(done.erasures).toEqual(lost.erasures);
          expect(done.qualifications).toEqual(lost.qualifications);
          expect(done.releases).toEqual(lost.releases);
          expect(maintenance).not.toHaveBeenCalled();
          expect(graphCommands).not.toHaveBeenCalled();
          expect(imported).not.toHaveBeenCalled();
          expect(requalified).not.toHaveBeenCalled();
          expect(await liveAccess(qualified)).toEqual(accessAfter);
          expect((await ownerLogins(qualified)).every(row => row.rolcanlogin)).toBe(true);
        } finally {
          requalified.mockRestore();
          imported.mockRestore();
          graphCommands.mockRestore();
          maintenance.mockRestore();
        }
        await noDuplicateRetry(qualified, key);
        console.info('later admission interruption proved', {
          case: 'closed-C1-native-release-and-lost-outcome',
        });
      } finally {
        await qualified.dispose();
      }
      expect(
        createHash('sha256')
          .update(readFileSync(fixture.nativeAccessAttachment!.path))
          .digest('hex'),
      ).toBe(ciphertextDigest);
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - started;
      console.info('later admission interruption fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  // 600 s is a hang deadline. The source plus one copy measured 242,936 ms in
  // QA20261011t220649-f78dff; this complete three-copy drill measured 204,240 ms
  // (205.91 s file) in QA20261011t233604-c97d55. Attempts each stay under 180 s.
  qaStartupTestTimeout(600_000),
);
