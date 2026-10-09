import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../support/postgres-cluster.ts';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import {
  activateMetadataWork,
  metadataWorkRequestDigest,
} from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const language = { kind: 'tag' as const, tag: 'en', originalTag: 'en' };

interface DraftWrite {
  resourceId: string;
  variantId: string;
  revisionId: string;
  predecessor: string | null;
  byteDigest: string;
  sourcePosition: { owner: 'content'; dataEpoch: string; sequence: string };
  replayed: boolean;
}

interface PublicationWrite {
  status: 'active' | 'rejected' | 'pending';
  receipt: string;
  decision: string | null;
  graphDataEpoch: string | null;
  graphSequence: string | null;
  replayed: boolean;
}

interface ExactRevision {
  reference: { revisionId: string; byteDigest: string; predecessor: string | null };
  serializedJson: string;
  body: { body: string; document?: DocumentSnapshot };
}

async function responseJson<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  if (response.status !== status) {
    throw new Error(`HTTP ${response.status}, expected ${status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

test('an author restores a published Content document from an earlier revision', async () => {
  if (
    !Bun.env.REZICS_QA_RUN_ID ||
    !Bun.env.FUSEKI_URL ||
    !Bun.env.MAIN_DATA_EPOCH ||
    !Bun.env.MAIN_ROUTING_EPOCH ||
    !Bun.env.ACCESS_DATABASE_URL
  ) {
    throw new Error('Run this test through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `content-recovery-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 8 });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const lineage = {
      dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH,
    };
    const env = { fuseki, lineage, objectDirectory: join(state, 'objects') };
    const title = `Content recovery ${randomUUID()}`;
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const created = await activateMetadataWork(env, {
      title,
      language: 'en',
      admission: {
        id: randomUUID(),
        scope: 'work:create:root',
        action: 'work.create',
        idempotencyKey: `content-work-${randomUUID()}`,
        requestDigest: metadataWorkRequestDigest(title, [], 'en'),
        authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const principal = { issuer: 'https://qa-content-recovery.test', subject: randomUUID() };
    const principalId = randomUUID();
    await accessPool.query(
      'INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject],
    );
    await accessPool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [
      actor,
      'agent',
    ]);
    const grant = async (scope: string, action: string) => {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await accessPool.query(
        `INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
        [randomUUID(), principalId, actor, action],
      );
      await accessPool.query(
        `INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
        [randomUUID(), actor, scope, action],
      );
    };
    await grant(`content:draft:${created.work}`, 'content.draft');
    await grant(`content:publish:${created.work}`, 'content.publish');
    await grant(`work:read:${created.work}`, 'work.read');
    const app = createMainApp(fuseki, {
      environment: env,
      account: { verify: async () => principal },
      access: new AccessAdmissionRegistry(accessPool),
      content,
      contentAuthoring: content,
    });
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const goodDocument = fromPlainText(
      'Kept chapter opening\nThe paragraph that should return.',
      'blocks',
    );
    const badDocument = fromPlainText('A bad edit that should not stay published.', 'blocks');
    const post = (path: string, body: object, key: string) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer qa',
            'idempotency-key': key,
          },
          body: JSON.stringify(body),
        }),
      );
    const draftBody = (document: DocumentSnapshot, expectedHead: string | null) => ({
      profile: 'content-text-v1',
      resourceId: created.work,
      variantId,
      language,
      direction: 'ltr' as const,
      expectedHead,
      document,
      actingSubject: actor,
    });
    const save = async (document: DocumentSnapshot, expectedHead: string | null, key: string) => {
      const response = await post('/v1/content-drafts', draftBody(document, expectedHead), key);
      const text = await response.text();
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`content draft HTTP ${response.status}: ${text}`);
      }
      return { status: response.status, body: JSON.parse(text) as DraftWrite };
    };
    const publish = async (
      draft: DraftWrite,
      expectedPublicationHead: string | null,
      key: string,
    ) => {
      const response = await post(
        '/v1/content-publications',
        {
          profile: 'content-publication-v1',
          preparationId: `publish-${randomUUID()}`,
          revisionId: draft.revisionId,
          expectedDigest: draft.byteDigest,
          expectedContentEpoch: draft.sourcePosition.dataEpoch,
          resourceId: created.work,
          variantId,
          expectedPublicationHead,
          actingSubject: actor,
        },
        key,
      );
      return responseJson<PublicationWrite>(response, 201);
    };
    const readRevision = (revisionId: string) =>
      app
        .handle(
          new Request(
            `http://main.local/v1/content-revisions/${revisionId}?actingSubject=${encodeURIComponent(actor)}`,
            { headers: { authorization: 'Bearer qa' } },
          ),
        )
        .then((response) => responseJson<ExactRevision>(response, 200));

    const goodSave = await save(goodDocument, null, `good-${randomUUID()}`);
    expect(goodSave.status).toBe(201);
    expect(goodSave.body).toMatchObject({ predecessor: null, replayed: false });
    const goodPublication = await publish(goodSave.body, null, `publish-good-${randomUUID()}`);
    expect(goodPublication).toMatchObject({ status: 'active', replayed: false });
    if (!goodPublication.decision || !goodPublication.receipt) {
      throw new Error(`good publication is incomplete: ${JSON.stringify(goodPublication)}`);
    }

    const badSave = await save(badDocument, goodSave.body.revisionId, `bad-${randomUUID()}`);
    expect(badSave.status).toBe(201);
    expect(badSave.body).toMatchObject({
      predecessor: goodSave.body.revisionId,
      replayed: false,
    });
    expect(badSave.body.byteDigest).not.toBe(goodSave.body.byteDigest);
    const badPublication = await publish(
      badSave.body,
      goodPublication.decision,
      `publish-bad-${randomUUID()}`,
    );
    expect(badPublication).toMatchObject({ status: 'active', replayed: false });
    if (!badPublication.decision || !badPublication.receipt) {
      throw new Error(`bad publication is incomplete: ${JSON.stringify(badPublication)}`);
    }
    expect(badPublication.decision).not.toBe(goodPublication.decision);
    expect(badPublication.receipt).not.toBe(goodPublication.receipt);

    const goodRead = await readRevision(goodSave.body.revisionId);
    const badRead = await readRevision(badSave.body.revisionId);
    expect(goodRead.body.document).toEqual(goodDocument);
    expect(badRead.body.document).toEqual(badDocument);
    expect(goodRead.serializedJson).not.toBe(badRead.serializedJson);
    expect(goodRead.reference.byteDigest).toBe(goodSave.body.byteDigest);
    expect(badRead.reference.byteDigest).toBe(badSave.body.byteDigest);
    if (!goodRead.body.document) throw new Error('good revision has no document');

    const restoreKey = `restore-${randomUUID()}`;
    const restored = await save(goodRead.body.document, badSave.body.revisionId, restoreKey);
    expect(restored.status).toBe(201);
    expect(restored.body.revisionId).not.toBe(goodSave.body.revisionId);
    expect(restored.body.revisionId).not.toBe(badSave.body.revisionId);
    expect(restored.body).toMatchObject({
      predecessor: badSave.body.revisionId,
      replayed: false,
      byteDigest: goodSave.body.byteDigest,
    });
    const restoredAgain = await save(goodRead.body.document, badSave.body.revisionId, restoreKey);
    expect(restoredAgain.status).toBe(200);
    expect(restoredAgain.body).toEqual({ ...restored.body, replayed: true });

    const restoredPublication = await publish(
      restored.body,
      badPublication.decision,
      `publish-restore-${randomUUID()}`,
    );
    expect(restoredPublication).toMatchObject({ status: 'active', replayed: false });
    if (!restoredPublication.decision || !restoredPublication.receipt) {
      throw new Error(`restored publication is incomplete: ${JSON.stringify(restoredPublication)}`);
    }
    expect(restoredPublication.receipt).not.toBe(goodPublication.receipt);
    expect(restoredPublication.receipt).not.toBe(badPublication.receipt);
    expect(restoredPublication.decision).not.toBe(badPublication.decision);
    expect(BigInt(restored.body.sourcePosition.sequence)).toBeGreaterThan(
      BigInt(badSave.body.sourcePosition.sequence),
    );

    const published = await readRevision(restored.body.revisionId);
    expect(published.serializedJson).toBe(goodRead.serializedJson);
    expect(published.body).toEqual(goodRead.body);
    expect(published.reference.byteDigest).toBe(goodRead.reference.byteDigest);
    expect(published.reference.revisionId).toBe(restored.body.revisionId);
    expect(await readRevision(goodSave.body.revisionId)).toEqual(goodRead);
    expect(await readRevision(badSave.body.revisionId)).toEqual(badRead);

    // The original revision is stale once the restored revision is the draft head.
    const staleKey = `stale-${randomUUID()}`;
    const staleRequest = draftBody(
      fromPlainText('An edit that still names the first revision.', 'blocks'),
      goodSave.body.revisionId,
    );
    const refused = await post('/v1/content-drafts', staleRequest, staleKey);
    const refusedText = await refused.text();
    expect(refused.status, refusedText).toBe(409);
    const refusedBody = JSON.parse(refusedText) as { code?: string; currentHead?: string | null };
    expect(refusedBody).toMatchObject({
      type: 'https://rezics.com/problems/stale_head',
      status: 409,
      code: 'stale_head',
      currentHead: restored.body.revisionId,
    });
    const retried = await post('/v1/content-drafts', staleRequest, staleKey);
    const retriedText = await retried.text();
    expect(retried.status, retriedText).toBe(409);
    expect(JSON.parse(retriedText)).toEqual(refusedBody);
    expect(await readRevision(goodSave.body.revisionId)).toEqual(goodRead);
    expect(await readRevision(badSave.body.revisionId)).toEqual(badRead);
    expect(await readRevision(restored.body.revisionId)).toEqual(published);
  } finally {
    await accessPool.end();
    await pool.end();
    cluster.remove();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
