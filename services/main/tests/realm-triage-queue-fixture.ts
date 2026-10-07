import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { ManagementReadStore } from '../src/modules/management-reads/read-store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = 'a'.repeat(64);
const queueMigration = '1767_realm_review_pending_queue.sql';
type CaseKind = 'content_report' | 'rights_complaint';

/** Migrate one native PostgreSQL template; each test gets an isolated copy. */
export async function realmTriageQueueDatabase() {
  const root = resolve(import.meta.dir, '../../..');
  const directory = join(root, '.temp', `realm-triage-queue-${randomUUID()}`),
    data = join(directory, 'pgdata');
  const copies = new Set<() => Promise<void>>();
  let admin: Pool | undefined,
    started = false,
    count = 0;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const command = (name: string, args: string[]) =>
    execFileSync(name, args, { cwd: directory, stdio: 'pipe', timeout: 30_000 });
  async function stop() {
    const errors: unknown[] = [];
    for (const close of [...copies]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    admin = undefined;
    if (started) {
      try {
        command('pg_ctl', ['-D', data, '-m', 'immediate', '-t', '30', '-w', 'stop']);
        started = false;
      } catch (error) {
        errors.push(error);
      }
    }
    // Preserve a running server's data and log if shutdown failed.
    if (!started) rmSync(directory, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Realm triage PostgreSQL cleanup failed');
  }
  try {
    command('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync']);
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('No native PostgreSQL test port'));
          return;
        }
        server.close((error) => (error ? reject(error) : resolvePort(address.port)));
      });
    });
    started = true;
    command('pg_ctl', [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      '-t',
      '30',
      '-w',
      'start',
    ]);
    const config = {
      host: '127.0.0.1',
      port,
      user: process.env.USER,
      connectionTimeoutMillis: 30_000,
    };
    admin = new Pool({ ...config, database: 'postgres', max: 1 });
    await admin.query('CREATE DATABASE realm_triage_template');
    const files = schemaFiles(root, 'access');
    const template = new Pool({ ...config, database: 'realm_triage_template', max: 1 });
    try {
      const client = await template.connect();
      try {
        await client.query('BEGIN');
        for (const file of files) {
          if (file !== queueMigration)
            await client.query(
              readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'),
            );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await template.end();
    }
    await admin.query('CREATE DATABASE realm_triage_before_queue TEMPLATE realm_triage_template');
    if (files.includes(queueMigration)) {
      const current = new Pool({ ...config, database: 'realm_triage_template', max: 1 });
      try {
        await current.query(
          readFileSync(join(root, 'services/main/migrations/access', queueMigration), 'utf8'),
        );
      } finally {
        await current.end();
      }
    }
    return {
      fixture: async (options: { beforeQueueMigration?: boolean } = {}) => {
        const database = `realm_triage_copy_${++count}`;
        const source = options.beforeQueueMigration
          ? 'realm_triage_before_queue'
          : 'realm_triage_template';
        await admin!.query(`CREATE DATABASE ${database} TEMPLATE ${source}`);
        const pool = new Pool({ ...config, database });
        let poolClosed = false,
          closed = false;
        const close = async () => {
          if (closed) return;
          if (!poolClosed) {
            await pool.end();
            poolClosed = true;
          }
          await admin!.query(`DROP DATABASE ${database} WITH (FORCE)`);
          closed = true;
          copies.delete(close);
        };
        copies.add(close);
        return createRealmTriageQueueFixture(pool, close);
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Realm triage PostgreSQL setup and cleanup failed',
      );
    }
    throw error;
  }
}

/** Real migrated Access owners; only the unrelated graph existence probe is mocked. */
async function createRealmTriageQueueFixture(pool: Pool, stop: () => Promise<void>) {
  const realm = native(),
    scope = `governance:realm:${realm}`;
  const epoch = randomUUID();
  async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function person() {
    const principalId = randomUUID(),
      actor = native();
    const principal: VerifiedPrincipal = {
      issuer: 'urn:realm-triage:account',
      subject: randomUUID(),
    };
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO access.principal (id,account_issuer,account_subject)
        VALUES ($1,$2,$3)`,
        [principalId, principal.issuer, principal.subject],
      );
      await client.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [
        actor,
      ]);
      await client.query(
        `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'agent.control','infinity')`,
        [randomUUID(), principalId, actor],
      );
    });
    return { principalId, actor, principal };
  }
  try {
    const moderator = await person(),
      outsider = await person();
    const { principal, principalId, actor } = moderator;
    await transaction(async (client) => {
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await client.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1)', [realm]);
      await client.query(
        `INSERT INTO access.realm_admin_settings (realm,who_may_submit,visibility)
        VALUES ($1,'members','private')`,
        [realm],
      );
      await client.query(
        `INSERT INTO access.permission_grant
        (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,'governance.moderate',clock_timestamp()+interval '1 hour')`,
        [randomUUID(), actor, scope],
      );
    });
    const environment = {
      lineage: { dataEpoch: epoch, routingEpoch: '1' },
      fuseki: {
        query: async () => ({
          results: {
            bindings: [
              {
                epoch: { type: 'literal', value: epoch },
                sequence: { type: 'literal', value: '1' },
                realm: { type: 'uri', value: realm },
              },
            ],
          },
        }),
      },
    } as unknown as WorkActivationEnvironment;
    const store = new ManagementReadStore(pool, environment);
    async function refresh(client: PoolClient, caseId: string) {
      await client.query(
        'UPDATE access.governance_case SET review_pending = review_pending WHERE id = $1',
        [caseId],
      );
    }
    async function reportWith(client: PoolClient, caseId: string) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO access.governance_report
        (id,case_id,principal_id,acting_subject,principal_epoch,idempotency_key,request_digest,
          reason_code,statement,evidence_count,evidence_digest)
        VALUES ($1::uuid,$2,$3,$4,0,$1::text,$5,'abuse','Private report',1,$5)`,
        [id, caseId, outsider.principalId, outsider.actor, digest],
      );
      await client.query(
        `INSERT INTO access.governance_evidence
        (report_id,ordinal,owner,resource,component,revision,revision_digest,state,provenance)
        SELECT $1,1,target_owner,target_resource,target_component,'revision-1',$3,'available','{}'::jsonb
        FROM access.governance_case WHERE id = $2`,
        [id, caseId, digest],
      );
      return id;
    }
    async function newCase(kind: CaseKind = 'content_report') {
      return transaction(async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO access.governance_case
          (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
          VALUES ($1,$2,'realm',$3,$4,'content',$5,'body','private')`,
          [id, kind, scope, realm, native()],
        );
        await reportWith(client, id);
        return id;
      });
    }
    async function decide(caseId: string, effects = 2, answersStepId: string | null = null) {
      if (!Number.isInteger(effects) || effects < 0 || effects > 64)
        throw new Error('Invalid effect count');
      return transaction(async (client) => {
        const row = (
          await client.query<{ kind: CaseKind; generation: string; target_resource: string }>(
            'SELECT kind,generation::text,target_resource FROM access.governance_case WHERE id = $1 FOR UPDATE',
            [caseId],
          )
        ).rows[0];
        if (!row) throw new Error('Missing fixture case');
        const id = randomUUID(),
          sequence = (BigInt(row.generation) + 1n).toString();
        await client.query(
          `INSERT INTO access.moderation_decision
          (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,
            authority_scope_id,authority_epoch,authority_proof_digest,idempotency_key,request_digest,
            rule_ref,rule_revision,rule_digest,evidence_digest,rationale,disclosure,answers_step_id,statement_of_reasons)
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,'realm',$9,0,$10,$1::text,$10,
            'urn:realm-triage:rule','1',$10,$10,'Reviewed private evidence','private',$11,$12::jsonb)`,
          [
            id,
            row.kind === 'rights_complaint' ? 'rights_disposition' : 'content_moderation',
            effects
              ? row.kind === 'rights_complaint'
                ? 'interim_restrict'
                : 'restrict'
              : 'dismiss',
            realm,
            caseId,
            sequence,
            principalId,
            actor,
            scope,
            digest,
            answersStepId,
            JSON.stringify({
              facts: 'Reviewed private evidence',
              scope: 'This exact revision',
              duration: 'Until reviewed',
              automation: false,
              contentLanguage: 'en',
              appealRoute: '/v1/public-reports/{caseId}/correspondence',
            }),
          ],
        );
        await client.query(
          'INSERT INTO access.safety_decision_operation (decision_id) VALUES ($1)',
          [id],
        );
        for (let ordinal = 1; ordinal <= effects; ordinal++) {
          const target = ordinal === 1 ? row.target_resource : native();
          await client.query(
            `INSERT INTO access.moderation_decision_target
            (decision_id,ordinal,owner,resource,component,scope_kind,revision,effect)
            VALUES ($1,$2,'content',$3,'body','exact_revision','revision-1','disclosure')`,
            [id, ordinal, target],
          );
          await client.query(
            `INSERT INTO access.safety_decision_effect (decision_id,ordinal,plan)
            VALUES ($1,$2,$3::jsonb)`,
            [
              id,
              ordinal,
              JSON.stringify({ owner: 'content', resource: target, component: 'body' }),
            ],
          );
        }
        await client.query(
          `UPDATE access.governance_case SET decision_head = $2,generation = $3 WHERE id = $1`,
          [caseId, id, sequence],
        );
        return id;
      });
    }
    async function refreshDecision(client: PoolClient, decisionId: string) {
      const row = (
        await client.query<{ case_id: string }>(
          'SELECT case_id FROM access.moderation_decision WHERE id = $1',
          [decisionId],
        )
      ).rows[0];
      if (!row) throw new Error('Missing fixture decision');
      await refresh(client, row.case_id);
    }
    async function confirm(decisionId: string, ordinal: number) {
      await transaction(async (client) => {
        await client.query(
          `UPDATE access.safety_decision_effect SET state = 'confirmed',receipt = $3,
          continuation = NULL,error = NULL WHERE decision_id = $1 AND ordinal = $2 AND state <> 'confirmed'`,
          [decisionId, ordinal, `urn:realm-triage:effect:${decisionId}:${ordinal}`],
        );
        await refreshDecision(client, decisionId);
      });
    }
    async function cancel(decisionId: string) {
      await transaction(async (client) => {
        await client.query(
          'UPDATE access.safety_decision_operation SET cancelled = true WHERE decision_id = $1',
          [decisionId],
        );
        await refreshDecision(client, decisionId);
      });
    }
    async function step(caseId: string, decisionId: string, kind: 'appeal' | 'counter_notice') {
      return transaction(async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO access.governance_process_step
          (id,case_id,decision_id,process,step,principal_id,party_subject,idempotency_key,request_digest,statement,occurred_at)
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$1::text,$8,'Please reconsider',clock_timestamp())`,
          [
            id,
            caseId,
            decisionId,
            kind === 'counter_notice' ? 'dmca_512' : 'platform_appeal',
            kind,
            outsider.principalId,
            outsider.actor,
            digest,
          ],
        );
        return id;
      });
    }
    async function escalate(caseId: string) {
      return transaction(async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO access.realm_admin_receipt
          (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
          VALUES ($1::uuid,$2,$3,$4,$1::text,$5,'governance.moderate','Owner review needed','{}'::jsonb)`,
          [id, realm, principalId, actor, digest],
        );
        await client.query(
          `INSERT INTO access.realm_admin_escalation
          (id,realm,item_kind,item_id,reason,acting_subject) VALUES ($1,$2,'report',$3,'Owner review needed',$4)`,
          [id, realm, caseId, actor],
        );
        return id;
      });
    }
    async function snapshot(caseId: string) {
      const row = (
        await pool.query<{
          reviewPending: boolean;
          state: string;
          decisionHead: string | null;
          generation: string;
          openCount: number;
          escalatedCount: number;
          revision: string;
        }>(
          `
        SELECT c.review_pending AS "reviewPending",c.state,c.decision_head AS "decisionHead",c.generation::text,
          COALESCE(a.open_reports,0)::integer AS "openCount",COALESCE(a.escalated_reports,0)::integer AS "escalatedCount",
          COALESCE(r.revision,0)::text AS revision
        FROM access.governance_case c LEFT JOIN access.realm_management_activity a ON a.realm = c.context
          LEFT JOIN access.realm_management_read_revision r ON r.realm = c.context WHERE c.id = $1`,
          [caseId],
        )
      ).rows[0];
      if (!row) throw new Error('Missing fixture case');
      return row;
    }
    return {
      pool,
      realm,
      scope,
      principal,
      principalId,
      actor,
      outsider,
      store,
      environment,
      newCase,
      decide,
      confirm,
      cancel,
      report: (caseId: string) => transaction((client) => reportWith(client, caseId)),
      step,
      escalate,
      snapshot,
      pending: (caseId: string) =>
        transaction(async (client) => {
          await refresh(client, caseId);
          return (
            await client.query<{ review_pending: boolean }>(
              'SELECT review_pending FROM access.governance_case WHERE id = $1',
              [caseId],
            )
          ).rows[0]!.review_pending;
        }),
      close: async (caseId: string) => {
        await pool.query(
          `UPDATE access.governance_case
        SET state = 'closed',closed_at = clock_timestamp() WHERE id = $1`,
          [caseId],
        );
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Realm triage fixture setup and cleanup failed');
    }
    throw error;
  }
}
