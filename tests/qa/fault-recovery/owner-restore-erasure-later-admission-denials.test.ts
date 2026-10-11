import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import { importAccessErasureRecoveryAttachment } from '../../../services/main/src/modules/access/erasure-recovery.ts';
import * as nativeRecovery from '../../../services/main/src/modules/access/erasure-recovery.ts';
import {
  captureErasureJournalCoreCoverage,
  createPublicRevisionJournalDeltaVerifier,
} from '../../../services/main/src/modules/erasure/core-journal-coverage.ts';
import { journalErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import * as authority from '../../../services/main/src/modules/erasure/authority.ts';
import {
  captureReleaseBasis,
  proveReleaseTransition,
} from '../../../services/main/src/modules/owner/restore-release-binding.ts';
import * as binding from '../../../services/main/src/modules/owner/restore-release-binding.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { dirname } from 'node:path';
import { ContentCore } from '../../../services/content/src/core.ts';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import {
  accessOutboxCoverage,
  accessStateCoverage,
} from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import {
  releaseRestoredGraphHold,
  assertRecoveryCoverage,
  RestoreLineageConflict,
  type RecoveryCoverage,
} from '../../../services/main/src/modules/work/restore-lineage.ts';
import { finishOperatorRestore } from '../../../scripts/ops/restore.ts';
import { RecoveryRefusal } from '../../../scripts/ops/recovery-set.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import {
  accessFence,
  failOuterOutcome,
  graphReleased,
  operatorContext,
  outerOperation,
  ownerLogins,
  ownerRestoreErasureFixture,
  repairOuterOutcome,
  replicaAccess,
  restoreKey,
  type Copy,
} from './owner-restore-erasure-fixture.ts';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const seal = (coverage: RecoveryCoverage, key = restoreKey) =>
  JSON.stringify(sealRecoveryPayload(coverage, key, 'graph-recovery-coverage'));
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

/** Fault custody is byte-exact; restoring it must not recapture or normalize evidence. */
async function retainedSnapshot(copy: Copy, table: string, where = 'true', values: unknown[] = []) {
  const select = `SELECT to_jsonb(original) AS row FROM ${table} original WHERE ${where} ORDER BY to_jsonb(original)::text`;
  const rows = (await copy.retainedRelay.query<{ row: object }>(select, values)).rows;
  return async () => {
    await copy.faultRetained([
      { sql: `DELETE FROM ${table} WHERE ${where}`, values },
      ...rows.map(({ row }) => ({
        sql: `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,
        values: [JSON.stringify(row)],
      })),
    ]);
    expect((await copy.retainedRelay.query(select, values)).rows).toEqual(rows);
  };
}

async function contentFault(copy: Copy, sql: string, values: unknown[]) {
  const client = await copy.owners.content.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    expect((await client.query(sql, values)).rowCount).toBe(1);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

test(
  'OPS12: later admission refuses the complete two-cut evidence and release denial matrix',
  async () => {
    const started = Date.now();
    const fixture = await ownerRestoreErasureFixture({ laterApiAdmission: true });
    const later = fixture.laterAdmission!;
    let capturedRevision: object;
    const body = {
      profile: 'owner-reconciliation-v1' as const,
      kind: 'restore' as const,
      sealedCoverage: fixture.baseAuthority.sealedCoverage,
      retainedAuthorityCoverage: fixture.currentAuthority.sealedCoverage,
      sealedDeletionSets: [],
    };
    const attempt = async (copy: Copy, key: string, input = body) => {
      const start = Date.now();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        // Every inner operator command has a 180 s hang deadline, independently
        // of the physical fixture's 600 s ceiling; log actual command durations.
        await Promise.race([
          finishOperatorRestore(
            operatorContext(fixture, copy),
            {
              reconcile: (_context, _body, id) => copy.request(id, undefined, input),
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
        const elapsedMs = Date.now() - start;
        console.info('later admission denial operator duration', { key, elapsedMs });
        expect(elapsedMs).toBeLessThan(180_000);
      }
    };
    try {
      expect(later).toBeDefined();
      expect(
        (
          await fixture.source.access.query('SELECT state FROM access.admission WHERE id=$1', [
            later.admissionId,
          ])
        ).rows,
      ).toEqual([{ state: 'sealed' }]);
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();
      const copy = await fixture.copy();
      try {
        const baseState = {
          count: fixture.baseCoverage.accessStateCount,
          digest: fixture.baseCoverage.accessStateDigest,
        };
        const baseOutbox = {
          count: fixture.baseCoverage.accessOutboxCount,
          digest: fixture.baseCoverage.accessOutboxDigest,
        };
        const content = new ContentCore(copy.owners.content);
        capturedRevision = (
          await copy.owners.content.query<{ row: object }>(
            'SELECT to_jsonb(r) AS row FROM content.revision r WHERE id=$1',
            [fixture.revisionId],
          )
        ).rows[0]!.row;
        const before = await content.readExactBatch(
          [fixture.revisionId, fixture.laterRevisionId],
          (ids) => Promise.resolve(new Set(ids)),
        );
        const maintenance = spyOn(copy.resources.erasures!.maintenance, 'command');
        const commands = spyOn(copy.fuseki, 'commandWithReceipt');
        const restoreHead = await retainedSnapshot(copy, 'relay.recovery_coverage_head');
        const restoreCurrent = await retainedSnapshot(copy, 'relay.current_authority_coverage');
        const restoreJournal = await retainedSnapshot(copy, 'relay.erasure');
        const restoreTargets = await retainedSnapshot(copy, 'relay.erasure_target');
        const restoreEvents = await retainedSnapshot(copy, 'relay.delivered_event');
        // Fault custody signs and retains the changed evidence together, so a
        // freshness mismatch cannot stand in for the intended reference gate.
        const pinCurrent = (coverage: RecoveryCoverage) =>
          copy.faultRetained([
            {
              sql: 'UPDATE relay.recovery_coverage_head SET coverage_digest=$1 WHERE consumer=$2',
              values: [sha(JSON.stringify(canonical(coverage))), fixture.coverage.relay.consumer],
            },
            {
              sql: 'UPDATE relay.current_authority_coverage SET coverage_digest=$1 WHERE id=true',
              values: [sha(JSON.stringify(canonical(coverage)))],
            },
          ]);
        const pristine = async () => {
          expect(await accessStateCoverage(copy.owners.access)).toEqual(baseState);
          expect(await accessOutboxCoverage(copy.owners.access)).toEqual(baseOutbox);
          expect(
            await content.readExactBatch([fixture.revisionId, fixture.laterRevisionId], (ids) =>
              Promise.resolve(new Set(ids)),
            ),
          ).toEqual(before);
          expect(await graphReleased(copy)).toBe(false);
          expect(await accessFence(copy)).toEqual([
            { open: false, generation: fixture.generation },
          ]);
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
        const controlled = async (
          label: string,
          mutate: () => void | Promise<unknown>,
          restore: () => void | Promise<unknown>,
          input = body,
          expectedGate?: string,
        ) => {
          maintenance.mockClear();
          commands.mockClear();
          await mutate();
          const key = `later-denial:${label}`;
          try {
            const response = await copy.request(key, undefined, input);
            expect(response.status).toBe(201);
            expect(await response.json()).toMatchObject({ state: 'held' });
            const held = await outerOperation(copy, key);
            expect(held.hold_reason).toBeString();
            if (expectedGate) expect(held.hold_reason).toContain(expectedGate);
            expect(held.qualifications).toHaveLength(0);
            expect(held.releases).toHaveLength(0);
            expect(maintenance).not.toHaveBeenCalled();
            expect(commands).not.toHaveBeenCalled();
            await expect(attempt(copy, key, input)).rejects.toBeInstanceOf(RecoveryRefusal);
            console.info('later admission refusal proved', { label, reason: held.hold_reason });
          } finally {
            await restore();
          }
          await pristine();
        };
        const noChange = () => {};
        try {
          // Physical provenance is always C0, including its original WAL and relay.
          await controlled('C1-as-C0', noChange, noChange, {
            ...body,
            sealedCoverage: body.retainedAuthorityCoverage,
          });
          for (const [label, coverage] of [
            ['altered-C0', { ...fixture.baseCoverage, accessStateDigest: '0'.repeat(64) }],
            [
              'original-WAL',
              {
                ...fixture.baseCoverage,
                accountPg: { ...fixture.baseCoverage.accountPg, flushedLsn: '0/1' },
              },
            ],
            [
              'captured-relay',
              {
                ...fixture.baseCoverage,
                relay: { ...fixture.baseCoverage.relay, batchDigest: '0'.repeat(64) },
              },
            ],
          ] as const)
            await controlled(label, noChange, noChange, {
              ...body,
              sealedCoverage: seal(coverage),
            });
          await controlled('forged-C1', noChange, noChange, {
            ...body,
            retainedAuthorityCoverage: body.retainedAuthorityCoverage.replace(/.$/, 'x'),
          });
          await controlled('wrong-C1-key', noChange, noChange, {
            ...body,
            retainedAuthorityCoverage: seal(fixture.currentCoverage, 'a5'.repeat(32)),
          });
          await controlled(
            'old-consumer-head',
            () =>
              copy.faultRetained(
                'UPDATE relay.recovery_coverage_head SET coverage_digest=$1 WHERE consumer=$2',
                [sha(body.sealedCoverage), fixture.coverage.relay.consumer],
              ),
            restoreHead,
          );
          await controlled(
            'newer-global-other-consumer',
            () =>
              copy.faultRetained(
                'UPDATE relay.current_authority_coverage SET consumer=$1, coverage_digest=$2, coverage_generation=coverage_generation+1 WHERE id=true',
                ['another-consumer', 'f'.repeat(64)],
              ),
            restoreCurrent,
          );
          // The later public API journal cannot make the old signature fresh.
          await controlled('C0-with-J1-no-C1-D', noChange, noChange, {
            ...body,
            retainedAuthorityCoverage: body.sealedCoverage,
          });
          const custody = copy.resources.nativeAccessAttachment;
          await controlled(
            'missing-D',
            () => {
              delete copy.resources.nativeAccessAttachment;
            },
            () => {
              copy.resources.nativeAccessAttachment = custody;
            },
          );
          const ciphertext = readFileSync(fixture.nativeAccessAttachment!.path);
          await controlled(
            'missing-encrypted-D',
            () => unlinkSync(fixture.nativeAccessAttachment!.path),
            () => writeFileSync(fixture.nativeAccessAttachment!.path, ciphertext, { mode: 0o600 }),
          );

          const plaintext = execFileSync(
            'gpg',
            ['--batch', '--decrypt', fixture.nativeAccessAttachment!.path],
            {
              env: fixture.attachmentCustody!.offhost,
              timeout: 15_000,
              stdio: ['ignore', 'pipe', 'ignore'],
            },
          ).toString('utf8');
          type NativeRow = {
            kind: string;
            table?: string;
            key?: Record<string, string>;
            values?: Record<string, unknown>;
          };
          const faultAttachment = async (
            label: string,
            gate: string,
            tamper: (rows: NativeRow[]) => void,
          ) => {
            const rows = plaintext
              .trimEnd()
              .split('\n')
              .map((line) => JSON.parse(line) as NativeRow);
            tamper(rows);
            const changedCoverage = structuredClone(fixture.currentCoverage);
            const summary = changedCoverage.nativeAccessErasure!.summary;
            const nativeRows = rows.filter((row) => row.kind === 'row');
            summary.rowCount = String(nativeRows.length);
            summary.rowDigest = sha(nativeRows.map((row) => JSON.stringify(row) + '\n').join(''));
            Object.assign(rows.at(-1)!, {
              rowCount: summary.rowCount,
              rowDigest: summary.rowDigest,
            });
            const changed = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            summary.plaintextBytes = String(Buffer.byteLength(changed));
            summary.plaintextDigest = sha(changed);
            const originalImport = nativeRecovery.importAccessErasureRecoveryAttachment;
            const failures: string[] = [];
            const imported = spyOn(
              nativeRecovery,
              'importAccessErasureRecoveryAttachment',
            ).mockImplementation(async (...args) => {
              try {
                return await originalImport(...args);
              } catch (error) {
                failures.push(error instanceof Error ? error.message : String(error));
                throw error;
              }
            });
            try {
              await controlled(
                label,
                async () => {
                  await pinCurrent(changedCoverage);
                  copy.resources.nativeAccessAttachment = async function* () {
                    yield changed;
                  };
                },
                async () => {
                  copy.resources.nativeAccessAttachment = custody;
                  await restoreHead();
                  await restoreCurrent();
                },
                { ...body, retainedAuthorityCoverage: seal(changedCoverage) },
                'native Access additions differ from signed current custody',
              );
              expect(failures).toHaveLength(1);
              expect(failures[0]).toContain(gate);
              console.info('later admission attachment denial gate', { label, gate: failures[0] });
            } finally {
              imported.mockRestore();
            }
          };
          for (const field of [
            'registered_at',
            'id',
            'authority_witness',
            'authority_epoch',
            'graph_sequence',
          ] as const) {
            const gate =
              field === 'id'
                ? 'graph_receipt'
                : field === 'authority_epoch'
                  ? 'native Access erasure outbox differs from its admission'
                  : field === 'graph_sequence'
                    ? 'retained revision erasure differs from its completed native admission'
                    : 'restored Access does not equal the signed current capture';
            await faultAttachment(`native-admission-${field}`, gate, (rows) => {
              const row = rows.find((row) => row.table === 'access.admission')!;
              expect(row.values).toHaveProperty(field);
              row.values![field] =
                field === 'id'
                  ? randomUUID()
                  : field === 'registered_at'
                    ? '2000-01-01T00:00:00.000Z'
                    : field === 'authority_witness'
                      ? {
                          $rezicsNativeJson: 'value',
                          $value: JSON.stringify([
                            { table: 'permission_grant', id: randomUUID(), generation: '999999' },
                          ]),
                        }
                      : '999999';
              if (field === 'id') row.key!.id = row.values!.id as string;
            });
          }
          await faultAttachment(
            'native-registration-receipt',
            'native Access erasure receipt differs from its admission',
            (rows) => {
              rows.find((row) => row.table === 'access.admission_receipt')!.values!.request_digest =
                'a'.repeat(64);
            },
          );
          await faultAttachment(
            'absent-sealed-outbox',
            'new Access erasure admission is missing a native outbox phase',
            (rows) => {
              const index = rows.findIndex(
                (row) => row.table === 'access.outbox' && row.values!.kind === 'admission.sealed',
              );
              expect(index).toBeGreaterThanOrEqual(0);
              rows.splice(index, 1);
            },
          );
          await faultAttachment('extra-admission', 'graph_receipt', (rows) => {
            const extra = structuredClone(rows.find((row) => row.table === 'access.admission')!);
            extra.key!.id = randomUUID();
            extra.values!.id = extra.key!.id;
            rows.splice(rows.findIndex((row) => row.table === 'access.admission') + 1, 0, extra);
            const admissions = rows
              .filter((row) => row.table === 'access.admission')
              .sort((a, b) => (a.key!.id! < b.key!.id! ? -1 : 1));
            rows.splice(1, admissions.length, ...admissions);
          });
          await controlled(
            'missing-J1',
            () => copy.faultRetained('DELETE FROM relay.erasure WHERE id=$1', [later.erasureId]),
            restoreJournal,
          );
          // Raw entries are fault custody only. Sign the complete three-entry
          // journal before removing its middle, so a max-epoch-only check cannot pass.
          try {
            const additions: Awaited<ReturnType<typeof journalErasure>>[] = [];
            for (let index = 0; index < 2; index++)
              additions.push(
                await journalErasure(copy.retainedRelay, {
                  operationId: randomUUID(),
                  requestDigest: sha(String(index)),
                  kind: 'revision',
                  principalId: fixture.principalId,
                  admissionId: randomUUID(),
                  authorityEpoch: fixture.generation,
                  targets: [{ kind: 'content_revision', ref: randomUUID() }],
                }),
              );
            const current = structuredClone(fixture.currentCoverage);
            current.erasureJournal = await captureErasureJournalCoreCoverage(copy.retainedRelay);
            current.nativeAccessErasure!.sourceErasureJournal = current.erasureJournal;
            const envelope = seal(current);
            await retainRecoveryCoverageHead(copy.retainedRelay, envelope, restoreKey, {
              attachmentDirectory: dirname(fixture.nativeAccessAttachment!.path),
            });
            const restoreThree = await retainedSnapshot(copy, 'relay.erasure');
            await controlled(
              'missing-middle-J1-with-max-unchanged',
              async () => {
                await copy.faultRetained('DELETE FROM relay.erasure WHERE id=$1', [
                  additions[0]!.erasureId,
                ]);
                expect((await captureErasureJournalCoreCoverage(copy.retainedRelay)).epoch).toBe(
                  current.erasureJournal!.epoch,
                );
              },
              async () => {
                await restoreThree();
                await restoreJournal();
                await restoreTargets();
                await restoreHead();
                await restoreCurrent();
              },
              { ...body, retainedAuthorityCoverage: envelope },
            );
          } finally {
            await restoreJournal();
            await restoreTargets();
            await restoreHead();
            await restoreCurrent();
          }
          await controlled(
            'target-ordinal',
            () =>
              copy.faultRetained(
                'UPDATE relay.erasure_target SET ordinal=ordinal+10 WHERE erasure_id=$1',
                [later.erasureId],
              ),
            restoreTargets,
          );
          await controlled(
            'truncated-native-batch',
            () =>
              copy.faultRetained(
                "DELETE FROM relay.delivered_event WHERE envelope->'data'->'receipt'->>'id'=$1",
                [fixture.original.receipt],
              ),
            restoreEvents,
          );
          for (const [label, path, value] of [
            ['terminal-erasure-epoch', '{data,receipt,systemProof,erasureEpoch}', '999999'],
            ['original-source-data-epoch', '{data,receipt,systemProof,dataEpoch}', randomUUID()],
          ])
            await controlled(
              label!,
              () =>
                copy.faultRetained(
                  "UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,$2::text[],to_jsonb($3::text)) WHERE envelope->'data'->'receipt'->>'id'=$1",
                  [fixture.original.receipt, path, value],
                ),
              restoreEvents,
            );
          for (const [label, mutate] of [
            [
              'reference-consumer',
              (coverage: RecoveryCoverage) => {
                coverage.nativeAccessErasure!.consumer = 'another-consumer';
              },
            ],
            [
              'reference-source-epoch',
              (coverage: RecoveryCoverage) => {
                coverage.nativeAccessErasure!.sourceDataEpoch = randomUUID();
              },
            ],
            [
              'reference-target-generation',
              (coverage: RecoveryCoverage) => {
                coverage.nativeAccessErasure!.summary.baseFenceGeneration = '999999';
              },
            ],
          ] as const) {
            const changed = structuredClone(fixture.currentCoverage);
            mutate(changed);
            expect(() => assertRecoveryCoverage(changed)).toThrow(
              'native Access erasure reference is invalid or differs from C1',
            );
            const originalCapture = authority.assertRetainedAuthorityCapture;
            const captures: RecoveryCoverage[] = [];
            const captured = spyOn(authority, 'assertRetainedAuthorityCapture').mockImplementation(
              async (...args) => {
                const result = await originalCapture(...args);
                captures.push(result);
                return result;
              },
            );
            try {
              await controlled(
                label,
                () => pinCurrent(changed),
                async () => {
                  await restoreHead();
                  await restoreCurrent();
                },
                {
                  ...body,
                  retainedAuthorityCoverage: seal(changed),
                },
                'independently current authority capture is invalid or superseded',
              );
              expect(captures).toContainEqual(changed);
              console.info('later admission signed-reference denial gate', {
                label,
                gate: 'native Access erasure reference is invalid or differs from C1',
              });
            } finally {
              captured.mockRestore();
            }
          }
          // Covered but unsupported writes cannot be admitted into an older cut.
          const gate = (
            await copy.owners.access.query<{ epoch: string }>(
              'SELECT authority_epoch::text AS epoch FROM access.scope_gate WHERE id=$1',
              [`work:edit:${fixture.work}`],
            )
          ).rows[0]!.epoch;
          await controlled(
            'unrelated-Access-authority',
            () =>
              replicaAccess(
                copy,
                'UPDATE access.scope_gate SET authority_epoch=authority_epoch+1 WHERE id=$1',
                [`work:edit:${fixture.work}`],
              ),
            () =>
              replicaAccess(copy, 'UPDATE access.scope_gate SET authority_epoch=$2 WHERE id=$1', [
                `work:edit:${fixture.work}`,
                gate,
              ]),
          );
          await faultAttachment(
            'auxiliary-admission-proof',
            'unknown native Access attachment schema or row',
            (rows) => {
              const extra = structuredClone(
                rows.find((row) => row.table === 'access.admission_receipt')!,
              );
              extra.table = 'access.admission_proof';
              rows.splice(rows.length - 1, 0, extra);
            },
          );
          await faultAttachment(
            'source-queue-fold',
            'discovery source invalidation is not the fence reopen/refence',
            (rows) => {
              rows.find(
                (row) => row.table === 'access.discovery_source_change',
              )!.values!.context_key = 'unsupported-fold';
            },
          );
          await controlled(
            'unrelated-graph-tail-command',
            () =>
              copy.faultRetained(
                "UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,'{type}',to_jsonb('com.rezics.work.created.v1'::text)) WHERE envelope->'data'->'receipt'->>'id'=$1",
                [fixture.original.receipt],
              ),
            restoreEvents,
          );
          for (const generation of [
            (BigInt(fixture.generation) + 1n).toString(),
            later.currentGeneration,
          ]) {
            await controlled(
              `G0-drift-${generation}`,
              () =>
                replicaAccess(
                  copy,
                  'UPDATE access.recovery_fence SET generation=$1 WHERE id=true',
                  [generation],
                ),
              () =>
                replicaAccess(
                  copy,
                  'UPDATE access.recovery_fence SET generation=$1 WHERE id=true',
                  [fixture.generation],
                ),
            );
          }
          // A borrowed client never lets a caller bypass transaction ownership.
          const relayClient = await copy.retainedRelay.connect();
          const accessClient = await copy.owners.access.connect();
          try {
            await expect(
              releaseRestoredGraphHold(
                copy.fuseki,
                copy.owners.access,
                copy.retainedRelay,
                copy.lineage,
                {
                  ...copy.resources,
                  sealedCoverage: body.sealedCoverage,
                  retainedAuthorityCoverage: body.retainedAuthorityCoverage,
                },
                relayClient,
                accessClient,
              ),
            ).rejects.toBeInstanceOf(RestoreLineageConflict);
          } finally {
            relayClient.release();
            accessClient.release();
          }
          await pristine();

          // Prove both post-CAS denial variants on the real imported C1 and CAS,
          // rolling back only this uncommitted Access transaction each time.
          for (const sql of [
            'UPDATE access.scope_gate SET authority_epoch=authority_epoch+1 WHERE id=$1',
            'INSERT INTO access.discovery_source_change DEFAULT VALUES',
          ]) {
            const relay = await copy.retainedRelay.connect(),
              access = await copy.owners.access.connect();
            try {
              await relay.query('BEGIN ISOLATION LEVEL READ COMMITTED');
              await access.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
              const reference = fixture.currentCoverage.nativeAccessErasure!;
              const verifier = await createPublicRevisionJournalDeltaVerifier(
                relay,
                reference.baseErasureJournal.epoch,
                reference.sourceErasureJournal.epoch,
              );
              await importAccessErasureRecoveryAttachment(
                access,
                custody!(reference),
                reference.summary,
                verifier.verifyAdmissions,
              );
              verifier.assertComplete();
              const basis = await captureReleaseBasis(
                copy.owners.access,
                access,
                fixture.currentCoverage,
              );
              await admission.releaseAccessRecoveryFence(access, fixture.generation);
              await access.query(sql, sql.includes('$1') ? [`work:edit:${fixture.work}`] : []);
              await expect(
                proveReleaseTransition(copy.owners.access, access, basis, fixture.generation),
              ).rejects.toBeInstanceOf(RestoreLineageConflict);
            } finally {
              await access.query('ROLLBACK');
              await relay.query('ROLLBACK');
              access.release();
              relay.release();
            }
            await pristine();
          }

          // Stop after both qualification commits. The fresh release transaction
          // must see new journal/head evidence even though qualification is durable.
          const gapKey = randomUUID();
          const stop = spyOn(binding, 'captureReleaseBasis').mockImplementation(async () => {
            throw Object.assign(new Error('fault: qualification commit gap'), {
              code: 'ECONNRESET',
            });
          });
          try {
            await expect(attempt(copy, gapKey)).rejects.toBeInstanceOf(RecoveryRefusal);
          } finally {
            stop.mockRestore();
          }
          const qualified = await outerOperation(copy, gapKey);
          expect(qualified.state).toBe('running');
          expect(qualified.qualifications).toHaveLength(1);
          expect(qualified.releases).toHaveLength(0);
          expect(await graphReleased(copy)).toBe(false);
          expect(await accessFence(copy)).toEqual([
            { open: false, generation: fixture.generation },
          ]);
          const restoreGapOuter = await retainedSnapshot(
            copy,
            'relay.owner_reconciliation',
            'id=$1',
            [qualified.id],
          );
          const restoreGapItems = await retainedSnapshot(
            copy,
            'relay.owner_reconciliation_item',
            'reconciliation_id=$1',
            [qualified.id],
          );
          // Delivery leases appear on the fresh release transaction, after the
          // durable qualification. Keep the exact qualified owners between faults;
          // the earlier controlled cases continue to prove zero qualification.
          const qualifiedState = await accessStateCoverage(copy.owners.access);
          const qualifiedOutbox = await accessOutboxCoverage(copy.owners.access);
          const qualifiedContent = await copy.owners.content.query(
            'SELECT to_jsonb(r) AS row FROM content.revision r WHERE id=ANY($1::uuid[]) ORDER BY id',
            [[fixture.revisionId, fixture.laterRevisionId]],
          );
          for (const kind of ['search', 'download'] as const) {
            const lock = admission.lockAccessRecoveryFenceForRelease;
            let inserted = 0;
            maintenance.mockClear();
            commands.mockClear();
            const spy = spyOn(admission, 'lockAccessRecoveryFenceForRelease').mockImplementation(
              async (client, generation) => {
                await lock(client, generation);
                const table =
                  kind === 'search' ? 'access.search_read_lease' : 'access.download_read_lease';
                const result = await client.query(
                  `INSERT INTO ${table} SELECT cloned.* FROM ${table} template
                CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},to_jsonb(template) ||
                  jsonb_build_object('id',$1::text,'recovery_generation',$2::text,'created_at',clock_timestamp(),
                    'expires_at',clock_timestamp()+interval '1 minute','state','delivering',
                    'delivery_started_at',clock_timestamp(),'finished_at',NULL)) cloned WHERE template.id=$3::uuid`,
                  [randomUUID(), generation, fixture.leaseTemplates[kind]],
                );
                expect(result.rowCount).toBe(1);
                inserted++;
                // Prove the real target CAS veto, then allow the release owner to
                // detect the same lease in its full C1 closure authentication.
                await expect(
                  admission.releaseAccessRecoveryFence(client, generation),
                ).rejects.toThrow('Access recovery fence changed');
                expect(
                  (
                    await client.query(
                      'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
                    )
                  ).rows,
                ).toEqual([{ open: false, generation: fixture.generation }]);
              },
            );
            try {
              const response = await copy.request(gapKey, undefined, body);
              expect(response.status).toBe(200);
              expect(await response.json()).toMatchObject({ state: 'held' });
              const held = await outerOperation(copy, gapKey);
              expect(held.qualifications).toEqual(qualified.qualifications);
              expect(held.erasures).toEqual(qualified.erasures);
              expect(held.releases).toHaveLength(0);
              expect(held.hold_reason).toContain(
                'restored Access differs from current retained authority',
              );
              await expect(attempt(copy, gapKey)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect(inserted).toBe(1);
              expect(maintenance).not.toHaveBeenCalled();
              expect(commands).not.toHaveBeenCalled();
              expect(await outerOperation(copy, gapKey)).toEqual(held);
              expect(await accessStateCoverage(copy.owners.access)).toEqual(qualifiedState);
              expect(await accessOutboxCoverage(copy.owners.access)).toEqual(qualifiedOutbox);
              expect(
                (
                  await copy.owners.content.query(
                    'SELECT to_jsonb(r) AS row FROM content.revision r WHERE id=ANY($1::uuid[]) ORDER BY id',
                    [[fixture.revisionId, fixture.laterRevisionId]],
                  )
                ).rows,
              ).toEqual(qualifiedContent.rows);
              expect(await graphReleased(copy)).toBe(false);
              expect(await accessFence(copy)).toEqual([
                { open: false, generation: fixture.generation },
              ]);
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
              console.info('later admission delivery lease denial gates', {
                kind,
                casGate: 'Access recovery fence changed',
                ownerGate: held.hold_reason,
              });
            } finally {
              spy.mockRestore();
              await restoreGapOuter();
              await restoreGapItems();
            }
          }
          for (const fault of ['new-journal', 'new-head'] as const) {
            try {
              if (fault === 'new-journal')
                await journalErasure(copy.retainedRelay, {
                  operationId: randomUUID(),
                  requestDigest: sha(fault),
                  kind: 'revision',
                  principalId: fixture.principalId,
                  admissionId: randomUUID(),
                  authorityEpoch: fixture.generation,
                  targets: [{ kind: 'content_revision', ref: randomUUID() }],
                });
              else
                await copy.faultRetained(
                  'UPDATE relay.current_authority_coverage SET coverage_generation=coverage_generation+1,coverage_digest=$1 WHERE id=true',
                  ['f'.repeat(64)],
                );
              await expect(attempt(copy, gapKey)).rejects.toBeInstanceOf(RecoveryRefusal);
              expect((await outerOperation(copy, gapKey)).state).toBe('held');
              expect(await graphReleased(copy)).toBe(false);
              expect(await accessFence(copy)).toEqual([
                { open: false, generation: fixture.generation },
              ]);
              expect((await copy.ready()).status).toBe(503);
              expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
                false,
                false,
                false,
                false,
              ]);
            } finally {
              await restoreJournal();
              await restoreTargets();
              await restoreHead();
              await restoreCurrent();
              await restoreGapOuter();
              await restoreGapItems();
            }
          }
          // The real Owner release proves rollback when an extra write slips in
          // after its native graph commit but before the Access commit.
          const release = admission.releaseAccessRecoveryFence;
          let extraWritten = false;
          const extra = spyOn(admission, 'releaseAccessRecoveryFence').mockImplementation(
            async (client, generation) => {
              await release(client, generation);
              await client.query('INSERT INTO access.discovery_source_change DEFAULT VALUES');
              extraWritten = true;
            },
          );
          try {
            await expect(attempt(copy, gapKey)).rejects.toBeInstanceOf(RecoveryRefusal);
          } finally {
            extra.mockRestore();
          }
          expect(extraWritten).toBe(true);
          expect((await outerOperation(copy, gapKey)).hold_reason).toMatch(/Access changed beyond/);
          expect(await graphReleased(copy)).toBe(true);
          expect(await accessFence(copy)).toEqual([
            { open: false, generation: fixture.generation },
          ]);
          expect((await copy.ready()).status).toBe(503);
          expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
            false,
            false,
            false,
            false,
          ]);
        } finally {
          commands.mockRestore();
          maintenance.mockRestore();
        }
      } finally {
        await copy.dispose();
      }

      // A second, serial candidate reaches real replay and both independent
      // commits. Its lost outcome lets each closure fault be restored exactly.
      const completed = await fixture.copy();
      try {
        const key = randomUUID();
        await failOuterOutcome(completed, key);
        await expect(attempt(completed, key)).rejects.toBeInstanceOf(RecoveryRefusal);
        await repairOuterOutcome(completed);
        const lost = await outerOperation(completed, key);
        expect(lost).toMatchObject({ state: 'running' });
        expect(lost.qualifications).toHaveLength(1);
        expect(lost.releases).toHaveLength(1);
        const restoreOuter = await retainedSnapshot(
          completed,
          'relay.owner_reconciliation',
          'id=$1',
          [lost.id],
        );
        const restoreBindings = await retainedSnapshot(
          completed,
          'relay.owner_reconciliation_item',
          'reconciliation_id=$1',
          [lost.id],
        );
        const restoreEvents = await retainedSnapshot(completed, 'relay.delivered_event');
        const commands = spyOn(completed.fuseki, 'commandWithReceipt');
        const maintenance = spyOn(completed.resources.erasures!.maintenance, 'command');
        const controlled = async (
          label: string,
          mutate: () => Promise<unknown>,
          restore: () => Promise<unknown>,
          input = body,
        ) => {
          commands.mockClear();
          maintenance.mockClear();
          await mutate();
          try {
            await expect(attempt(completed, key, input)).rejects.toBeInstanceOf(RecoveryRefusal);
            const held = await outerOperation(completed, key);
            expect(held.state).toBe('held');
            expect(held.erasures).toEqual(lost.erasures);
            expect(await graphReleased(completed)).toBe(true);
            expect(await accessFence(completed)).toEqual([
              { open: true, generation: (BigInt(fixture.generation) + 1n).toString() },
            ]);
            expect((await ownerLogins(completed)).map((row) => row.rolcanlogin)).toEqual([
              false,
              false,
              false,
              false,
            ]);
            expect(commands).not.toHaveBeenCalled();
            expect(maintenance).not.toHaveBeenCalled();
            console.info('later admission completion refused', { label, reason: held.hold_reason });
          } finally {
            await restore();
            await restoreBindings();
            await restoreOuter();
          }
        };
        try {
          for (const prefix of ['restore-qualification:', 'restore-release:'])
            await controlled(
              `forged-${prefix}`,
              () =>
                completed.faultRetained(
                  'UPDATE relay.owner_reconciliation_item SET item_ref=$2 WHERE reconciliation_id=$1 AND item_ref LIKE $3',
                  [lost.id, prefix + 'f'.repeat(64), prefix + '%'],
                ),
              async () => {},
            );
          // Changed D under the same idempotency key is a conflict, never a fresh import.
          const changed = structuredClone(fixture.currentCoverage);
          changed.nativeAccessErasure!.summary.plaintextDigest = 'f'.repeat(64);
          const swap = await completed.request(key, undefined, {
            ...body,
            retainedAuthorityCoverage: seal(changed),
          });
          expect(swap.status).toBe(409);
          expect(await outerOperation(completed, key)).toEqual(lost);
          await controlled(
            'replanted-original-native-event',
            () =>
              completed.faultRetained(
                "UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,'{data,receipt,systemProof,erasureEpoch}',to_jsonb('999999'::text)) WHERE envelope->'data'->'receipt'->>'id'=$1",
                [fixture.original.receipt],
              ),
            restoreEvents,
          );

          const erasedRevision = (
            await completed.owners.content.query<{ row: object }>(
              'SELECT to_jsonb(r) AS row FROM content.revision r WHERE id=$1',
              [fixture.revisionId],
            )
          ).rows[0]!.row;
          const replaceRevision = async (row: object) => {
            await contentFault(completed, 'DELETE FROM content.revision WHERE id=$1', [
              fixture.revisionId,
            ]);
            await contentFault(
              completed,
              'INSERT INTO content.revision SELECT * FROM jsonb_populate_record(NULL::content.revision,$1::jsonb)',
              [JSON.stringify(row)],
            );
          };
          await controlled(
            'replanted-Content-bytes',
            () => replaceRevision(capturedRevision),
            () => replaceRevision(erasedRevision),
          );
          const target = `urn:rezics:content:revision:${fixture.revisionId}`;
          const tombstone = `PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.revisions}> { <${target}> a rv:ErasedRevision } }`;
          expect((await completed.fuseki.query(tombstone)).boolean).toBe(true);
          await controlled(
            'replanted-graph-tombstone',
            () =>
              completed.fuseki.update(
                `PREFIX rv: <${RV}> DELETE DATA { GRAPH <${GRAPHS.revisions}> { <${target}> a rv:ErasedRevision } }`,
              ),
            async () => {
              await completed.fuseki.update(
                `PREFIX rv: <${RV}> INSERT DATA { GRAPH <${GRAPHS.revisions}> { <${target}> a rv:ErasedRevision } }`,
              );
              expect((await completed.fuseki.query(tombstone)).boolean).toBe(true);
            },
          );

          for (const [label, table, where, values, mutation, faultValues] of [
            [
              'foreign-content-tombstone',
              'content.revision_erasure',
              'revision_id=$1',
              [fixture.revisionId],
              'UPDATE content.revision_erasure SET erasure_id=$2 WHERE revision_id=$1',
              [fixture.revisionId, randomUUID()],
            ],
            [
              'comment-source',
              'content.comment',
              'id=$1',
              [fixture.quotedSource.commentId],
              'UPDATE content.comment SET exact=$2, prefix=$3, suffix=$4 WHERE id=$1',
              [
                fixture.quotedSource.commentId,
                fixture.quotedSource.exact,
                fixture.quotedSource.prefix,
                fixture.quotedSource.suffix,
              ],
            ],
            [
              'evidence-source',
              'verification.evidence_item',
              'content_revision_id=$1',
              [fixture.revisionId],
              "UPDATE verification.evidence_item SET selector=selector || jsonb_build_object('exact',$2::text),source_terminal=false,source_erasure_id=NULL,source_erasure_epoch=NULL WHERE content_revision_id=$1",
              [fixture.revisionId, fixture.quotedSource.exact],
            ],
            [
              'terminal-evidence-source',
              'verification.evidence_item',
              'content_revision_id=$1',
              [fixture.revisionId],
              "UPDATE verification.evidence_item SET selector=selector || jsonb_build_object('exact',$2::text) WHERE content_revision_id=$1",
              [fixture.revisionId, fixture.quotedSource.exact],
            ],
          ] as const) {
            const original = (
              await completed.owners.content.query<{ row: object }>(
                `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where}`,
                [...values],
              )
            ).rows;
            expect(original).toHaveLength(1);
            await controlled(
              label,
              () => contentFault(completed, mutation, [...faultValues]),
              async () => {
                await contentFault(completed, `DELETE FROM ${table} WHERE ${where}`, [...values]);
                await contentFault(
                  completed,
                  `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,
                  [JSON.stringify(original[0]!.row)],
                );
                expect(
                  (
                    await completed.owners.content.query(
                      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where}`,
                      [...values],
                    )
                  ).rows,
                ).toEqual(original);
              },
            );
          }
        } finally {
          maintenance.mockRestore();
          commands.mockRestore();
        }
        await attempt(completed, key);
        expect((await outerOperation(completed, key)).state).toBe('reconciled');
        expect((await ownerLogins(completed)).map((row) => row.rolcanlogin)).toEqual([
          true,
          true,
          true,
          true,
        ]);
      } finally {
        await completed.dispose();
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - started;
      console.info('later admission denial matrix duration', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
    // 600 s is a hang deadline. The shared later-admission source + one restored
    // candidate measured 242,936 ms (246.0 s file) in QA 20261011t220649-f78dff;
    // this file logs its two serial candidates and every <=180 s operator attempt.
  },
  qaStartupTestTimeout(600_000),
);
