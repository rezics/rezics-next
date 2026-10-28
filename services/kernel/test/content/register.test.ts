import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import pg from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Effect } from '../../src/events/effects.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import {
  contentWorkDependencies,
  ContentDependencyUnavailableError,
  registerContent,
} from '../../src/content/register.ts';
import { CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';
import {
  CONTENT_BOARD_RANK_SCHEDULE,
  CONTENT_COLLECTION_SCHEDULE,
  CONTENT_NOTICE_RETENTION_SCHEDULE,
} from '../../src/content/work.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { WorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const routeKey = Buffer.alloc(32, 7).toString('base64url');
const canary = 'do-not-log-content-secret';
const contentEnv = {
  CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
  CONTENT_R2_BUCKET: 'content-media',
  CONTENT_R2_ACCESS_KEY_ID: 'private-access-id',
  CONTENT_R2_SECRET_ACCESS_KEY: 'private-secret',
  CONTENT_SOURCE_HOSTS: 'images.example.org,covers.example.net',
  KERNEL_AUTH_CONSENT_URL: 'https://consent.example.test/internal/v1/consents:read',
  CF_ACCESS_CLIENT_ID: 'access-client-id',
  CF_ACCESS_CLIENT_SECRET: 'access-client-secret',
};

type Registration = {
  workflows: string[];
  steps: string[];
  queues: Array<{ name: string; parameters: object }>;
  schedules: Array<{
    scheduleName: string;
    workflowName: string;
    schedule: string;
    queueName: string;
    cronTimezone: string;
    automaticBackfill: boolean;
  }>;
  effects: Array<{ name: string; types: string[] }>;
};

function workEnvironment(mode: 'empty' | 'full'): Record<string, string | undefined> {
  return {
    DATABASE_URL: databaseUrl,
    KERNEL_ROUTE_KEY: routeKey,
    CONTENT_CANARY: canary,
    ...(mode === 'full' ? contentEnv : {}),
  };
}

async function composeRegistration(mode: 'empty' | 'full'): Promise<Registration> {
  const workflows: string[] = [];
  const steps: string[] = [];
  const queues: Registration['queues'] = [];
  const schedules: Registration['schedules'] = [];
  const effects: Registration['effects'] = [];
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const registerWorkflow = DBOS.registerWorkflow.bind(DBOS);
  const registerStep = DBOS.registerStep.bind(DBOS);
  const dbos = DBOS as unknown as {
    registerWorkflow: typeof DBOS.registerWorkflow;
    registerStep: typeof DBOS.registerStep;
  };
  dbos.registerWorkflow = ((func, config) => {
    workflows.push(config?.name ?? func.name);
    return registerWorkflow(func, config);
  }) as typeof DBOS.registerWorkflow;
  dbos.registerStep = ((func, config) => {
    steps.push(config?.name ?? func.name);
    return registerStep(func, config);
  }) as typeof DBOS.registerStep;
  try {
    await composeWork(
      [
        {
          name: registerContent.name,
          async register(context) {
            // The composed context is frozen. A Proxy cannot replace addEffects without breaking
            // the invariant for its non-writable property, so record on a plain wrapper instead.
            await registerContent.register({
              ...context,
              addEffects(items: Effect[]) {
                for (const effect of items) effects.push({ name: effect.name, types: [...effect.types] });
                context.addEffects(items);
              },
            });
          },
        },
      ],
      {
        databaseUrl: databaseUrl!,
        pool,
        client: {
          async registerQueue(name: string, parameters: object) {
            queues.push({ name, parameters });
          },
          async applySchedules(items: Registration['schedules']) {
            schedules.push(...items);
          },
        } as unknown as WorkClient,
        env: workEnvironment(mode),
      },
    );
    return { workflows, steps, queues, schedules, effects };
  } finally {
    dbos.registerWorkflow = registerWorkflow;
    dbos.registerStep = registerStep;
    await pool.end();
  }
}

if (process.argv.includes('--content-registration')) {
  try {
    const mode = process.env.CONTENT_REGISTRATION_MODE;
    if (mode !== 'empty' && mode !== 'full') throw new Error('CONTENT_REGISTRATION_MODE must be empty or full');
    const registration = await composeRegistration(mode);
    console.log(`CONTENT_REGISTRATION_JSON:${JSON.stringify(registration)}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
} else {
  const { expect, test } = await import('bun:test');

  function absenceLines(output: string): string[] {
    return output.split('\n').filter((line) => line.startsWith('content ') && line.includes('group is absent'));
  }

  async function spawnRegistration(mode: 'empty' | 'full'): Promise<{ registration: Registration; output: string }> {
    const child = Bun.spawn([process.execPath, import.meta.path, '--content-registration'], {
      env: { ...process.env, CONTENT_REGISTRATION_MODE: mode, CONTENT_CANARY: canary },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 45_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}${stderr}`;
      expect(exitCode, output).toBe(0);
      const line = stdout.split('\n').find((item) => item.startsWith('CONTENT_REGISTRATION_JSON:'));
      expect(line, output).toBeDefined();
      return {
        registration: JSON.parse(line!.slice('CONTENT_REGISTRATION_JSON:'.length)) as Registration,
        output,
      };
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }

  const captured = Promise.all([spawnRegistration('empty'), spawnRegistration('full')]);

  test('with no content variable set the worker registers content and reports each absent group without values', async () => {
    const { registration, output } = (await captured)[0];
    expect(registration.workflows).toEqual(
      expect.arrayContaining([
        CONTENT_WORKFLOWS.image,
        CONTENT_WORKFLOWS.purge,
        CONTENT_WORKFLOWS.collect,
        CONTENT_WORKFLOWS.authorErase,
        CONTENT_WORKFLOWS.importFromUrl,
        'content.collect.partition',
        'content.board-rank.refresh',
        'content.notice-retention',
        'content.notice-retention.partition',
        'content.erasePostRevisions',
      ]),
    );
    expect(registration.effects.map((effect) => effect.name)).toEqual([
      'content_post_erased',
      'content_reaction_count',
      'content_subject_thread',
      'content_author_item',
      'content_board_thread',
      'content_report_target',
      'content_media_image',
      'content_media_purge',
      'content_author_erasure',
      'content_url_import',
      'content_subject_reaction_merge',
    ]);
    expect(absenceLines(output)).toEqual([
      'content storage group is absent: CONTENT_R2_ENDPOINT, CONTENT_R2_BUCKET, CONTENT_R2_ACCESS_KEY_ID, CONTENT_R2_SECRET_ACCESS_KEY',
      'content sources group is absent: CONTENT_SOURCE_HOSTS',
      'content consent group is absent: KERNEL_AUTH_CONSENT_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET',
    ]);
    expect(output).not.toContain(canary);
    expect(output).not.toContain(routeKey);
    expect(output).not.toContain(databaseUrl!);
    expect(output).not.toContain(contentEnv.CONTENT_R2_SECRET_ACCESS_KEY);
    expect(output).not.toContain(contentEnv.CF_ACCESS_CLIENT_SECRET);
    expect(output).not.toContain(contentEnv.CONTENT_R2_ENDPOINT);
  });

  test('the registration set is identical with and without configuration', async () => {
    const [empty, full] = await captured;
    expect(empty.registration.workflows).toEqual(full.registration.workflows);
    expect(empty.registration.steps).toEqual(full.registration.steps);
    expect(empty.registration.queues).toEqual(full.registration.queues);
    expect(empty.registration.schedules).toEqual(full.registration.schedules);
    expect(empty.registration.effects).toEqual(full.registration.effects);
    expect(empty.registration.queues.map((queue) => queue.name)).toEqual(Object.keys(WORK_QUEUES));
    expect(empty.registration.schedules).toEqual([
      {
        scheduleName: CONTENT_COLLECTION_SCHEDULE,
        workflowName: CONTENT_WORKFLOWS.collect,
        schedule: '0 * * * *',
        queueName: 'maintenance',
        cronTimezone: 'UTC',
        automaticBackfill: false,
      },
      {
        scheduleName: CONTENT_BOARD_RANK_SCHEDULE,
        workflowName: 'content.board-rank.refresh',
        schedule: '*/10 * * * *',
        queueName: 'maintenance',
        cronTimezone: 'UTC',
        automaticBackfill: false,
      },
      {
        scheduleName: CONTENT_NOTICE_RETENTION_SCHEDULE,
        workflowName: 'content.notice-retention',
        schedule: '0 * * * *',
        queueName: 'maintenance',
        cronTimezone: 'UTC',
        automaticBackfill: false,
      },
    ]);
    expect(empty.registration.steps).toEqual(
      expect.arrayContaining([
        'content.image.step',
        'content.purge.step',
        'content.import.step',
        'content.authorErase.step',
        'content.collect.step',
        'content.notice-retention.cutoff',
        'content.notice-retention.page',
      ]),
    );
    expect(absenceLines(full.output)).toEqual([]);
    expect(full.output).not.toContain(canary);
    expect(full.output).not.toContain(contentEnv.CONTENT_R2_SECRET_ACCESS_KEY);
    expect(full.output).not.toContain(contentEnv.CF_ACCESS_CLIENT_SECRET);
    expect(full.output).not.toContain(contentEnv.CONTENT_R2_ACCESS_KEY_ID);
  });

  test('an absent storage or consent group fails closed at use and changes no media or operation state', async () => {
    const targetRoute = 0x5c20;
    const mediaId = newId(targetRoute);
    const containerId = newId(targetRoute);
    const uploaderId = newId(targetRoute + 1);
    const operationId = newId(targetRoute);
    const threadId = newId(targetRoute);
    const anchorPostId = newId(targetRoute);
    const revisionId = newId(targetRoute);
    const accountId = newId(0x1010);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const transport = async (_request: Request): Promise<Response> => {
      throw new Error('content transport must not be called');
    };
    try {
      await runCommand(
        pool,
        { partition: partitionOf(targetRoute), deadline: Date.now() + 10_000 },
        async (tx, context) => {
          await tx.query(
            `INSERT INTO content.media (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,actual_byte_count,sha256,state,key,transaction_id)
           VALUES ($1,$2,$3,$4,$5,'post-image','image/png',$6,$6,$7,'uploaded',$8,$9)`,
            [
              targetRoute,
              mediaId,
              containerId,
              uploaderId,
              randomUUID(),
              bytes.byteLength,
              digest,
              `m/${mediaId}/original`,
              context.transactionId,
            ],
          );
          return {
            value: mediaId,
            events: [
              {
                type: 'com.rezics.content.media.uploaded.v1',
                subject: mediaId,
                data: { mediaId, containerId, actorId: uploaderId },
              },
            ],
          };
        },
      );
      const anchorBody = Buffer.from(serializeDocument(fromPlainText('Content registration erasure fixture')));
      const setup = await pool.connect();
      try {
        await setup.query('BEGIN');
        await setup.query(
          `INSERT INTO content.thread
             (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
           VALUES ($1,$2,$3,$4,'Fixture','published',1,$5)`,
          [targetRoute, threadId, accountId, newId(targetRoute), randomUUID()],
        );
        await setup.query(
          `INSERT INTO content.post
             (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
           VALUES ($1,$2,$3,$4,$5,'published',1,$6)`,
          [targetRoute, threadId, anchorPostId, accountId, revisionId, randomUUID()],
        );
        await setup.query(
          `INSERT INTO content.revision
             (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
           VALUES ($1,$2,$3,$4,$5,sha256($5),'Content registration erasure fixture','CC0-1.0','{}',$6,'available',$7)`,
          [targetRoute, threadId, anchorPostId, revisionId, anchorBody, newId(targetRoute), randomUUID()],
        );
        await setup.query(
          `INSERT INTO content.operation
             (route,operation_id,initiator_account_id,author_account_id,thread_id,anchor_post_id,actor_kind,actor_account_id,
              actor_client_id,actor_scopes,actor_authn_epoch,empty_scope,requested_at,recorded_transaction_id)
           VALUES ($1,$2,$3,$3,$4,$5,'account',$3,'content-register-test',ARRAY['content:write'],1,true,now(),$6)`,
          [targetRoute, operationId, accountId, threadId, anchorPostId, randomUUID()],
        );
        await setup.query('COMMIT');
      } finally {
        await setup.query('ROLLBACK');
        setup.release();
      }
      const before = await contentState(pool, mediaId, operationId);
      expect(before.media).toEqual([
        { state: 'uploaded', decision: null, unclaimed: true, erased: false, collection_pending: false, variants: 0 },
      ]);
      expect(before.operation).toHaveLength(1);

      const dependencies = contentWorkDependencies({}, transport);
      expect(dependencies.config.storage).toBeNull();
      expect(dependencies.absentGroups.map((group) => group.name)).toContain('consent');
      expect(dependencies.fetchConfig.allowedHosts).toEqual([]);

      const image = await createImageJob(pool, dependencies.storage)
        .process(mediaId)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const consentRead = await dependencies
        .readConsent({ actorAccountId: accountId, clientId: 'content-register-test', deadline: Date.now() + 1_000 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const stored = await dependencies.storage.get(`m/${mediaId}/original`).then(
        () => undefined,
        (error: unknown) => error,
      );
      const written = await dependencies.storage.put(`m/${mediaId}/original`, bytes, { mediaType: 'image/png' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const deleted = await dependencies.storage.deletePrefix(`m/${mediaId}/`).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(image).toBeInstanceOf(ContentDependencyUnavailableError);
      expect(consentRead).toBeInstanceOf(ContentDependencyUnavailableError);
      expect(stored).toBeInstanceOf(ContentDependencyUnavailableError);
      expect(written).toBeInstanceOf(ContentDependencyUnavailableError);
      expect(deleted).toBeInstanceOf(ContentDependencyUnavailableError);
      for (const error of [image, consentRead, stored, written, deleted]) {
        expect((error as ContentDependencyUnavailableError).code).toBe('dependency_unavailable');
        expect((error as Error).message).toBe('dependency_unavailable');
      }
      expect(await contentState(pool, mediaId, operationId)).toEqual(before);
    } finally {
      await pool.end();
    }
  });
}

async function contentState(pool: pg.Pool, mediaId: string, operationId: string) {
  const media = await pool.query<{
    state: string;
    decision: string | null;
    unclaimed: boolean;
    erased: boolean;
    collection_pending: boolean;
    variants: number;
  }>(
    `SELECT state, decision, claimed_at IS NULL AS unclaimed, erased, collection_pending,
            (SELECT count(*)::int FROM content.media_variant v WHERE v.media_id = m.media_id) AS variants
     FROM content.media m WHERE m.media_id = $1`,
    [mediaId],
  );
  const operation = await pool.query<{ row: unknown }>(
    `SELECT to_jsonb(o) AS row FROM content.operation o WHERE o.operation_id = $1`,
    [operationId],
  );
  const terminal = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM core.outbox
     WHERE type IN ('com.rezics.content.media.available.v1', 'com.rezics.content.media.rejected.v1')`,
    [],
  );
  const partition = await pool.query<{ position: string }>(
    `SELECT position::text FROM core.partition WHERE partition_no = $1`,
    [partitionOf(0x5c20)],
  );
  return {
    media: media.rows,
    operation: operation.rows,
    terminal: terminal.rows[0]?.count ?? null,
    position: partition.rows[0]?.position ?? null,
  };
}
