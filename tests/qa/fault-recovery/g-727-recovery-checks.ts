import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { exportAccountData } from '../../../services/account/src/data-export.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import {
  OwnerOperations,
  type RestoreResources,
} from '../../../services/main/src/modules/owner/operations.ts';
import {
  PostgresReceiptCustodyStore,
  ReceiptCustody,
} from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { mirrorAccountDeletionIntent } from '../../../services/main/src/modules/outbox/account-deletion-journal.ts';
import { retainAccountSubjectDeletion } from '../../../services/main/src/modules/outbox/account-subject-deletion.ts';
import { DATASET, GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { objectStore } from '../../../scripts/ops/backup.ts';
import type { RestoredContext, RestoreChecks } from '../../../scripts/ops/restore.ts';

export type RecoveryProbeSource = Pick<RestoredContext, 'apps' | 'pools' | 'fuseki'>;

export interface RetainedRecoveryChecks {
  /** Caller-owned current ledger, available while the original project is stopped. */
  relayPool: Pool;
  /** The stopped source is qualified only through its retained native handoff. */
  erasures: Extract<
    NonNullable<RestoreResources['erasures']>,
    {
      originalSource: 'retained-native-event';
    }
  >;
}

/** Ephemeral QA custody uses distinct secret/public keyrings, just like the
 * one-Work harness. A manager can supply retained keyrings for a launch run. */
export function recoveryTestCustody(directory: string, nonce: string) {
  const secretHome = join(directory, 'offhost-keys');
  const publicHome = join(directory, 'backup-public-keys');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const home of [secretHome, publicHome]) mkdirSync(home, { mode: 0o700 });
  const offhost = { ...process.env, GNUPGHOME: secretHome };
  const publicOnly = { ...process.env, GNUPGHOME: publicHome };
  const run = (program: string, args: string[], environment: NodeJS.ProcessEnv) => {
    const result = spawnSync(program, args, {
      env: environment,
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.error || result.status !== 0) throw new Error(`${program} QA custody step failed`);
    return result.stdout.trim();
  };
  try {
    run(
      'gpg',
      [
        '--batch',
        '--pinentry-mode',
        'loopback',
        '--passphrase',
        '',
        '--quick-generate-key',
        `G727 recovery ${nonce} <g727-${nonce}@example.test>`,
        'rsa2048',
        'encr',
        '1d',
      ],
      offhost,
    );
    const recipient = run('gpg', ['--batch', '--with-colons', '--list-keys'], offhost)
      .split('\n')
      .find((line) => line.startsWith('fpr:'))
      ?.split(':')[9];
    if (!recipient) throw new Error('QA recovery recipient is unavailable');
    const publicKey = join(directory, 'recipient.asc');
    run('gpg', ['--batch', '--armor', '--output', publicKey, '--export', recipient], offhost);
    run('gpg', ['--batch', '--import', publicKey], publicOnly);
    return { recipient, offhost, publicOnly };
  } catch (error) {
    for (const environment of [offhost, publicOnly])
      run('gpgconf', ['--kill', 'gpg-agent'], environment);
    throw error;
  }
}

export function closeRecoveryTestCustody(custody: ReturnType<typeof recoveryTestCustody>): void {
  for (const environment of [custody.offhost, custody.publicOnly]) {
    const result = spawnSync('gpgconf', ['--kill', 'gpg-agent'], {
      env: environment,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) throw new Error('QA recovery agent cleanup failed');
  }
}

function archiveBasis(value: Awaited<ReturnType<typeof exportAccountData>>) {
  const { exportedAt: _exportedAt, ...basis } = value;
  return basis;
}

/** Seed one independent deleted Account and revoked grant on the writable copy,
 * then sample the actual source. The retained fixture itself is never changed. */
export async function captureRecoveryProbes(
  source: RecoveryProbeSource,
  sample: { work: string; revisionId: string; actingSubject: string; searchQuery: string },
) {
  const { account, access, content, relay } = source.pools;
  const person = randomUUID();
  const deleted = randomUUID();
  for (const id of [person, deleted])
    await account.query(
      `INSERT INTO public."user"
       (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1,'Restored reader',$2,true,now(),now())`,
      [id, `${id}@example.test`],
    );
  const operator = { issuer: source.apps.ACCOUNT_ISSUER!, subject: person };
  const deletedPrincipal = randomUUID();
  await access.query(
    'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)',
    [randomUUID(), operator.issuer, person, deletedPrincipal, deleted],
  );
  const deletion = await new AccessAdmissionRegistry(access).strongDeactivateAccountSubject(
    operator.issuer,
    deleted,
  );
  if (!deletion) throw new Error('deletion fence was not created');
  await mirrorAccountDeletionIntent(access, relay, deletion.principalId, deletion.enforcementEpoch);
  await retainAccountSubjectDeletion(relay, operator.issuer, deleted);
  await account.query('DELETE FROM public."user" WHERE id = $1', [deleted]);
  const revoked = randomUUID();
  const readScope = `work:read:${sample.work}`;
  await access.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    readScope,
  ]);
  await access.query(
    `INSERT INTO access.permission_grant
     (id, issuer_subject, recipient_subject, scope_id, action, valid_until, active)
     VALUES ($1,$2,$2,$3,'work.read',now() + interval '1 hour',false)`,
    [revoked, sample.actingSubject, readScope],
  );
  const archive = archiveBasis(
    await exportAccountData(account, source.apps.ACCOUNT_SECRET!, person, 'none'),
  );
  const exact = await new ContentCore(content).readExactBatch(
    [sample.revisionId],
    async (ids) => new Set(ids),
  );
  expect(exact[0]?.status).toBe('available');
  const search = await source.fuseki.query(sample.searchQuery);
  expect(search.results?.bindings.length).toBeGreaterThan(0);
  return { sample, operator, deleted, deletedPrincipal, revoked, archive, exact, search };
}

/** Both drills run the real reconciliation route in process. Only the Account
 * authentication adapter is a QA stand-in; no listening Main or deployment Task
 * is required. This does not qualify deployment OAuth or library takeout. */
export function recoveryChecks(
  probes: Awaited<ReturnType<typeof captureRecoveryProbes>>,
  key: string,
  retained: RetainedRecoveryChecks,
  verifyExtra?: (context: RestoredContext) => Promise<void>,
): RestoreChecks {
  if (
    typeof retained?.relayPool?.connect !== 'function' ||
    !retained.erasures?.authority?.sealedCoverage ||
    !retained.erasures.authority.hmacKey ||
    !retained.erasures.signingKey ||
    typeof retained.erasures.maintenance?.command !== 'function' ||
    retained.erasures.originalSource !== 'retained-native-event' ||
    'originalGraph' in retained.erasures
  ) {
    throw new Error(
      'Recovery checks require independently retained current erasure and authority evidence',
    );
  }
  let verifiedBeforeRelease = false;
  return {
    verify: async (context) => {
      expect(
        archiveBasis(
          await exportAccountData(
            context.pools.account,
            context.apps.ACCOUNT_SECRET!,
            probes.operator.subject,
            'none',
          ),
        ),
      ).toEqual(probes.archive);
      expect(
        (
          await context.pools.account.query('SELECT id FROM public."user" WHERE id = $1', [
            probes.deleted,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await context.pools.access.query('SELECT active FROM access.principal WHERE id = $1', [
            probes.deletedPrincipal,
          ])
        ).rows[0]?.active,
      ).toBe(false);
      expect(
        (
          await context.pools.access.query(
            'SELECT active FROM access.permission_grant WHERE id = $1',
            [probes.revoked],
          )
        ).rows[0]?.active,
      ).toBe(false);
      const core = new ContentCore(context.pools.content);
      expect(
        await core.readExactBatch([probes.sample.revisionId], async (ids) => new Set(ids)),
      ).toEqual(probes.exact);
      expect(await core.readExactBatch([probes.sample.revisionId], async () => new Set())).toEqual([
        { revisionId: probes.sample.revisionId, status: 'denied' },
      ]);
      expect(await context.fuseki.query(probes.sample.searchQuery)).toEqual(probes.search);
      expect(
        (
          await context.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
        <${DATASET}> rv:restoreHold true } }`)
        ).boolean,
      ).toBe(true);
      await verifyExtra?.(context);
      verifiedBeforeRelease = true;
    },
    reconcile: async (context, body, idempotencyKey) => {
      expect(verifiedBeforeRelease).toBe(true);
      const objects: RestoreResources['objectStore'] = objectStore(
        context.apps,
        context.budget,
        context.pools.content,
      );
      const env = {
        fuseki: context.fuseki,
        lineage: {
          dataEpoch: context.apps.MAIN_DATA_EPOCH!,
          routingEpoch: context.apps.MAIN_ROUTING_EPOCH!,
        },
        objectDirectory: context.apps.MAIN_OBJECT_DIRECTORY!,
        workObjects: objects.workObjects,
        titleAdmissionKey: retained.erasures.signingKey,
        ...(objects.workObjects
          ? {
              receiptCustody: new ReceiptCustody(
                new PostgresReceiptCustodyStore(context.pools.access),
                objects.workObjects,
                context.fuseki,
                retained.erasures.signingKey,
                proofRetirementSender(context.apps.FUSEKI_URL!, context.apps.FUSEKI_COMMAND_TOKEN!),
              ),
            }
          : {}),
      };
      const registry = new AccessAdmissionRegistry(context.pools.access);
      const operations = new OwnerOperations(retained.relayPool, env, {
        accountPool: context.pools.account,
        accessPool: context.pools.access,
        contentPool: context.pools.content,
        hmacKey: key,
        objectStore: objects,
        restoredRelayPool: context.pools.relay,
        erasures: retained.erasures,
      });
      const app = createMainApp(context.fuseki, {
        environment: env,
        account: {
          verify: async (request) => {
            if (request.headers.get('authorization') !== 'Bearer qa-owner')
              throw new AccountAssertionDenied('denied');
            return probes.operator;
          },
        },
        access: registry,
        content: new ContentCore(context.pools.content),
        ownerOperations: operations,
      });
      expect((await app.handle(new Request('http://localhost/health/ready'))).status).toBe(503);
      const request = (authorization: string) =>
        new Request('http://localhost/v1/owners/reconciliations', {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      expect((await app.handle(request('Bearer denied'))).status).toBe(401);
      const response = await app.handle(request('Bearer qa-owner'));
      const responseBody = (await response.clone().json()) as {
        state?: string;
        disposition?: string;
      };
      const hold = await retained.relayPool.query<{ hold_reason: string | null }>(
        'SELECT hold_reason FROM relay.owner_reconciliation WHERE operation_id = $1',
        [`owner:reconcile:${idempotencyKey}`],
      );
      const reason = hold.rows[0]?.hold_reason;
      if (Bun.env.REZICS_QA_ARTIFACT_DIR)
        writeFileSync(
          join(
            Bun.env.REZICS_QA_ARTIFACT_DIR,
            `g-727-reconciliation-${context.apps.MAIN_DATA_EPOCH}.json`,
          ),
          JSON.stringify({ status: response.status, ...responseBody, holdReason: reason }, null, 2),
          { mode: 0o600 },
        );
      if (reason) throw new Error(`Owner reconciliation remained held: ${reason}`);
      return response;
    },
  };
}
