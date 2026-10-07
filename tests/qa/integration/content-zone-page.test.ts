import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createAgentGraph } from '../../../services/main/src/modules/agent/graph.ts';
import { agentProvisionDigest } from '../../../services/main/src/modules/agent/provision.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { pinAdmittedZonePageContent } from '../../../services/main/src/modules/content-publication/publish-admitted.ts';
import {
  ContentPublicationConflict,
  settleZonePageContentPublication,
} from '../../../services/main/src/modules/content-publication/publish.ts';
import {
  readZoneConfiguration,
  type ZoneSitePublicationReceipt,
} from '../../../services/main/src/modules/zone/configuration.ts';
import { isZonePublishedPageRevision } from '../../../services/main/src/modules/zone/publication.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

interface SavedDraft {
  resourceId: string;
  variantId: string;
  revisionId: string;
  predecessor: string | null;
  byteDigest: string;
  sourcePosition: { dataEpoch: string; sequence: string };
  replayed: boolean;
}

interface ExactRevision {
  reference: { resourceId: string; variantId: string; revisionId: string; byteDigest: string };
  serializedJson: string;
  body: { body: string; document?: DocumentSnapshot };
}

const opaquePayload = { future: [null, { preserved: true, coordinates: [121.5, 25] }] };
function pageDocument(text: string) {
  const document = structuredClone(fromPlainText(text, 'blocks'));
  document.doc.content!.push({
    type: 'extensionBlock',
    attrs: {
      id: 'future-map',
      dir: null,
      lang: null,
      definition: 'https://example.org/unknown-map',
      version: '42',
      fallback: 'Place map',
      payload: opaquePayload,
    },
  });
  return document;
}

async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `content-zone-page-${randomUUID()}`),
    'openid work:create work:edit work:read space:create zone:edit',
  );
  try {
    const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
    try {
      await accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [
        f.account.a.id,
      ]);
    } finally {
      await accountPool.end();
    }
    f.account.tokenA = await f.account.tokenFor(f.account.a);
    f.access.configureBaseline(f.env.fuseki);
    const objects = new S3ImmutableObjects({
      endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!,
      region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/',
    });
    await objects.initialize();
    const content = new ContentCore(f.pool);
    let revokeAtClaim = false;
    let deniedClaimId: string | null = null;
    let zoneSpace: string | null = null;
    const access = new Proxy(f.access, {
      get(target, property) {
        if (property === 'claim')
          return async (...args: Parameters<typeof target.claim>) => {
            if (revokeAtClaim) {
              revokeAtClaim = false;
              deniedClaimId = args[0];
              const newOwner = `https://rezics.com/id/${randomUUID()}`;
              const profile = { kind: 'person' as const, displayName: 'Replacement site owner' };
              await createAgentGraph(f.env, {
                id: randomUUID(),
                agent: newOwner,
                ...profile,
                digest: agentProvisionDigest(profile),
              });
              await f.env.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
                DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(zoneSpace!)} rv:owner ${iri(f.actor)} } }
                INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(zoneSpace!)} rv:owner ${iri(newOwner)} } }
                WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(zoneSpace!)} rv:owner ${iri(f.actor)} } }`);
            }
            return target.claim(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = createMainApp(f.env.fuseki, {
      environment: f.env,
      account: f.account.verifier,
      access,
      catalogueIntake: f.catalogueIntake,
      structureObjects: objects,
      content,
      contentAuthoring: content,
    });
    const call = (
      method: string,
      path: string,
      body?: object,
      key = randomUUID(),
      token: string | null = f.account.tokenA,
    ) =>
      app.handle(
        new Request(`http://main.local${path}`, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'idempotency-key': key,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const json = async <T>(response: Response, status: number): Promise<T> => {
      if (response.status !== status)
        throw new Error(`${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };
    await f.grant('space:create:root', 'space.create');
    const created = await json<{ space: string; zone: string; navigationRevision: string }>(
      await call('POST', '/v1/spaces', {
        profile: 'space-zone-v1',
        name: 'Content document site',
        capabilities: ['zone'],
        actingSubject: f.actor,
      }),
      201,
    );
    zoneSpace = created.space;
    await f.grant(`zone:edit:${created.zone}`, 'zone.edit');
    // The Content bridge proves stewardship through Space creation and live Agent control.
    const controlId = randomUUID();
    await f.accessPool.query(
      `INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity'::timestamptz)`,
      [controlId, f.principalId, f.actor],
    );
    await f.authoredBody({ actingSubject: f.actor });
    await f.accessPool.query(
      `INSERT INTO access.agent_provision
      (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
        display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
      VALUES ($1,$2,$3,$4,$5,'person','QA fixture author',0,'active',$6,0,$7)`,
      [
        randomUUID(),
        f.principalId,
        randomUUID(),
        'a'.repeat(64),
        f.actor,
        f.env.lineage.dataEpoch,
        controlId,
      ],
    );
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draftBody = (
      document: DocumentSnapshot,
      expectedHead: string | null,
      resourceId = created.zone,
      variant = variantId,
      language = 'en',
    ) => ({
      profile: 'content-text-v1',
      resourceId,
      variantId: variant,
      language: { kind: 'tag', tag: language, originalTag: language },
      direction: 'ltr',
      expectedHead,
      document,
      actingSubject: f.actor,
    });
    const save = async (
      document: DocumentSnapshot,
      expectedHead: string | null,
      resourceId = created.zone,
      variant = variantId,
      language = 'en',
      key = randomUUID(),
    ) =>
      json<SavedDraft>(
        await call(
          'POST',
          '/v1/content-drafts',
          draftBody(document, expectedHead, resourceId, variant, language),
          key,
        ),
        201,
      );
    const exactPath = (revisionId: string, editor = false) =>
      `/v1/content-revisions/${revisionId}${editor ? `?actingSubject=${encodeURIComponent(f.actor)}` : ''}`;
    const publicationBody = (
      saved: SavedDraft,
      expectedPublicationHead: string | null = null,
      preparationId = `zone-page-${randomUUID()}`,
    ) => ({
      profile: 'content-publication-v1',
      preparationId,
      resourceId: saved.resourceId,
      variantId: saved.variantId,
      revisionId: saved.revisionId,
      expectedDigest: saved.byteDigest,
      expectedContentEpoch: saved.sourcePosition.dataEpoch,
      expectedPublicationHead,
      actingSubject: f.actor,
    });
    const publishSite = async (saved: SavedDraft) => {
      const state = await readZoneConfiguration(
        { ...f.env, structureObjects: objects },
        created.zone,
      );
      return json<ZoneSitePublicationReceipt>(
        await call('POST', `/v1/zones/${shortId(created.zone)}/site-publications`, {
          pages: [{ page: created.zone, variantId: saved.variantId, revisionId: saved.revisionId }],
          routesRevision: created.navigationRevision,
          navigationRevision: created.navigationRevision,
          expectedHead: state.revision,
          actingSubject: f.actor,
        }),
        201,
      );
    };
    return {
      ...f,
      ...created,
      content,
      call,
      json,
      variantId,
      draftBody,
      save,
      exactPath,
      publicationBody,
      publishSite,
      environment: { ...f.env, structureObjects: objects },
      revokeBeforeClaim: () => {
        revokeAtClaim = true;
      },
      deniedClaim: () => deniedClaimId,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('Zone Blocks documents retain opaque payloads, draft CAS and language variants; exact pins become public only in the site bundle', async () => {
  const f = await fixture();
  try {
    const initial = await f.save(pageDocument('Welcome'), null);
    const revisedDocument = pageDocument('Welcome to the revised home');
    const second = await f.save(revisedDocument, initial.revisionId);
    expect(second.predecessor).toBe(initial.revisionId);
    const concurrent = await Promise.all([
      f.call('POST', '/v1/content-drafts', f.draftBody(revisedDocument, second.revisionId)),
      f.call('POST', '/v1/content-drafts', f.draftBody(revisedDocument, second.revisionId)),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);
    const revised = await f.json<SavedDraft>(
      concurrent.find((response) => response.status === 201)!,
      201,
    );
    expect(revised.predecessor).toBe(second.revisionId);
    const stale = await f.json<{ code: string; currentHead: string }>(
      await f.call(
        'POST',
        '/v1/content-drafts',
        f.draftBody(pageDocument('Stale home'), initial.revisionId),
      ),
      409,
    );
    expect(stale).toMatchObject({ code: 'stale_head', currentHead: revised.revisionId });
    const translated = await f.save(
      pageDocument('歡迎'),
      null,
      f.zone,
      `urn:rezics:variant:${randomUUID()}`,
      'zh-Hant',
    );
    expect(translated.variantId).not.toBe(revised.variantId);
    const draft = await f.json<ExactRevision>(
      await f.call('GET', f.exactPath(revised.revisionId, true)),
      200,
    );
    expect(draft.reference).toMatchObject({
      resourceId: f.zone,
      variantId: f.variantId,
      revisionId: revised.revisionId,
      byteDigest: revised.byteDigest,
    });
    expect(draft.body.document).toEqual(revisedDocument);
    expect(draft.body.document!.doc.content!.at(-1)!.attrs!.payload).toEqual(opaquePayload);
    expect(JSON.parse(draft.serializedJson)).toEqual(draft.body);
    expect(
      (await f.call('GET', f.exactPath(revised.revisionId), undefined, randomUUID(), null)).status,
    ).toBe(404);

    const { profile: _profile, ...sitePinInput } = f.publicationBody(revised);
    const sitePin = await pinAdmittedZonePageContent(
      f.environment,
      f.content,
      f.account.verifier,
      f.access,
      new Request('http://main.local', {
        headers: { authorization: `Bearer ${f.account.tokenA}` },
      }),
      sitePinInput,
    );
    expect(sitePin).toMatchObject({
      status: 'pending',
      pinActive: true,
      reference: { resourceId: f.zone, revisionId: revised.revisionId },
    });
    const publicationInput = f.publicationBody(revised);
    const publicationKey = randomUUID();
    const publication = await f.json<{ status: string; receipt: string; replayed: boolean }>(
      await f.call('POST', '/v1/content-publications', publicationInput, publicationKey),
      201,
    );
    expect(publication.status).toBe('active');
    expect(
      await f.json(
        await f.call('POST', '/v1/content-publications', publicationInput, publicationKey),
        200,
      ),
    ).toEqual({ ...publication, replayed: true });
    const pin = await f.pool.query(
      `SELECT revision_id, status, pin_active, graph_receipt
      FROM content.publication_preparation WHERE operation_id = $1`,
      [publicationInput.preparationId],
    );
    expect(pin.rows).toEqual([
      {
        revision_id: revised.revisionId,
        status: 'active',
        pin_active: true,
        graph_receipt: publication.receipt,
      },
    ]);
    expect(
      (await f.call('GET', f.exactPath(revised.revisionId), undefined, randomUUID(), null)).status,
    ).toBe(404);
    const foreignCut = await f.publishSite(translated);
    await expect(
      settleZonePageContentPublication(
        f.environment,
        f.content,
        sitePinInput.preparationId,
        foreignCut.receipt,
      ),
    ).rejects.toBeInstanceOf(ContentPublicationConflict);
    expect((await f.content.readPublicationPreparation(sitePinInput.preparationId))?.status).toBe(
      'pending',
    );
    const site = await f.publishSite(revised);
    expect(site.pages).toEqual([
      { page: f.zone, variantId: f.variantId, revisionId: revised.revisionId },
    ]);
    expect(
      await isZonePublishedPageRevision(f.environment, f.zone, f.zone, revised.revisionId),
    ).toBe(true);
    const settled = await settleZonePageContentPublication(
      f.environment,
      f.content,
      sitePinInput.preparationId,
      site.receipt,
    );
    expect(settled).toMatchObject({ status: 'active', pinActive: true, replayed: false });
    expect(
      await settleZonePageContentPublication(
        f.environment,
        f.content,
        sitePinInput.preparationId,
        site.receipt,
      ),
    ).toMatchObject({ status: 'active', pinActive: true, replayed: true });
    const publicExact = await f.json<ExactRevision>(
      await f.call('GET', f.exactPath(revised.revisionId), undefined, randomUUID(), null),
      200,
    );
    expect(publicExact).toEqual(draft);
    expect(JSON.parse(publicExact.serializedJson)).toEqual(draft.body);
    const later = await f.save(pageDocument('Unpublished follow-up'), revised.revisionId);
    for (const saved of [initial, second, translated, later]) {
      expect(
        (await f.call('GET', f.exactPath(saved.revisionId), undefined, randomUUID(), null)).status,
      ).toBe(404);
    }
    expect(
      (await f.call('GET', f.exactPath(revised.revisionId), undefined, randomUUID(), null)).status,
    ).toBe(200);
    const originalRead = f.content.readExactBatch.bind(f.content);
    let movedDuringRead = false;
    f.content.readExactBatch = async (...args: Parameters<ContentCore['readExactBatch']>) => {
      const result = await originalRead(...args);
      if (!movedDuringRead && args[0].includes(revised.revisionId)) {
        movedDuringRead = true;
        await f.publishSite(later);
      }
      return result;
    };
    try {
      expect(
        (await f.call('GET', f.exactPath(revised.revisionId), undefined, randomUUID(), null))
          .status,
      ).toBe(404);
      expect(movedDuringRead).toBe(true);
    } finally {
      f.content.readExactBatch = originalRead;
    }
    expect(
      (await f.call('GET', f.exactPath(revised.revisionId), undefined, randomUUID(), null)).status,
    ).toBe(404);
    expect(
      (await f.call('GET', f.exactPath(later.revisionId), undefined, randomUUID(), null)).status,
    ).toBe(200);
    expect(
      await settleZonePageContentPublication(
        f.environment,
        f.content,
        sitePinInput.preparationId,
        site.receipt,
      ),
    ).toMatchObject({ status: 'active', pinActive: true, replayed: true });
  } finally {
    await f.close();
  }
}, 120_000);

test('Zone Content refuses non-editor saves and publication, and rechecks revoked stewardship at claim before custody', async () => {
  const f = await fixture();
  try {
    const body = f.draftBody(pageDocument('Only editors'), null);
    expect(
      (await f.call('POST', '/v1/content-drafts', body, randomUUID(), f.account.tokenB)).status,
    ).toBe(403);
    expect(await f.content.readDraftHead(f.zone, f.variantId)).toBeNull();
    const saved = await f.save(pageDocument('Editor draft'), null);
    expect(
      (
        await f.call(
          'GET',
          f.exactPath(saved.revisionId, true),
          undefined,
          randomUUID(),
          f.account.tokenB,
        )
      ).status,
    ).toBe(404);
    const refusedPublication = await f.call(
      'POST',
      '/v1/content-publications',
      f.publicationBody(saved),
      randomUUID(),
      f.account.tokenB,
    );
    expect([403, 404]).toContain(refusedPublication.status);
    expect(
      (
        await f.pool.query('SELECT 1 FROM content.publication_preparation WHERE revision_id = $1', [
          saved.revisionId,
        ])
      ).rowCount,
    ).toBe(0);
    f.revokeBeforeClaim();
    expect(
      (
        await f.call(
          'POST',
          '/v1/content-drafts',
          f.draftBody(pageDocument('Revoked before claim'), saved.revisionId),
        )
      ).status,
    ).toBe(403);
    expect(f.deniedClaim()).not.toBeNull();
    expect(await f.content.readDraftReceipt(`content-draft:${f.deniedClaim()}`)).toBeNull();
    expect((await f.content.readDraftHead(f.zone, f.variantId))?.revisionId).toBe(saved.revisionId);
  } finally {
    await f.close();
  }
}, 120_000);

test('existing Work Content still saves, revises, publishes and exports exact revisions', async () => {
  const f = await fixture();
  try {
    const work = await f.json<{ work: string }>(
      await f.call(
        'POST',
        '/v1/works',
        await f.authoredBody({
          profile: 'metadata-only-v1',
          language: 'en',
          title: 'Existing Work Content',
          actingSubject: f.actor,
        }),
      ),
      201,
    );
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`content:draft:${work.work}`, 'content.draft');
    await f.grant(`content:publish:${work.work}`, 'content.publish');
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const initial = await f.save(fromPlainText('Work body'), null, work.work, variant);
    const revised = await f.save(
      fromPlainText('Revised Work body'),
      initial.revisionId,
      work.work,
      variant,
    );
    const publication = await f.json<{ status: string }>(
      await f.call('POST', '/v1/content-publications', f.publicationBody(revised)),
      201,
    );
    expect(publication.status).toBe('active');
    const exact = await f.json<ExactRevision>(
      await f.call('GET', f.exactPath(revised.revisionId, true)),
      200,
    );
    expect(exact.reference).toMatchObject({
      resourceId: work.work,
      variantId: variant,
      revisionId: revised.revisionId,
      byteDigest: revised.byteDigest,
    });
    expect(exact.body.body).toBe('Revised Work body');
    expect(JSON.parse(exact.serializedJson)).toEqual(exact.body);
  } finally {
    await f.close();
  }
}, 120_000);
