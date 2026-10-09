import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry,
  type RegisteredAdmission,
} from '../../../services/main/src/modules/access/admission.ts';
import {
  ContentDraftDenied,
  saveAdmittedContentDraft,
} from '../../../services/main/src/modules/content-publication/draft.ts';
import {
  ContentEligibilityDenied,
  type ContentSearchEligibilityInput,
  contentSearchEligibilityDigest,
  selectPublicContentSearch,
} from '../../../services/main/src/modules/content-publication/eligibility.ts';
import {
  contentPublicationDigest,
  publishPinnedContent,
} from '../../../services/main/src/modules/content-publication/publish.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import {
  PUBLIC_DOMAIN_TEXT_USE,
  publicDomainWorkMaterial,
  RightsStore,
} from '../../../services/main/src/modules/rights/store.ts';
import {
  activateMetadataWork,
  metadataWorkRequestDigest,
} from '../../../services/main/src/modules/work/activate.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

test('PUBLIC-DOMAIN: accepted Work assessment admits sourced text; withdrawal suppresses search and reads', async () => {
  if (
    !Bun.env.REZICS_QA_RUN_ID ||
    !Bun.env.FUSEKI_URL ||
    !Bun.env.MAIN_DATA_EPOCH ||
    !Bun.env.MAIN_ROUTING_EPOCH
  ) {
    throw new Error('Use the QA integration tier');
  }
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'content'], 'owner');
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 4 });
  const contentPool = new Pool({ connectionString: databases.urls.content, max: 4 });
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const rights = new RightsStore(contentPool, accessPool);
    const registry = new AccessAdmissionRegistry(accessPool);
    const principal = { issuer: 'https://qa-public-domain.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const account = { verify: async () => principal };
    const env = {
      fuseki: new FusekiClient(Bun.env.FUSEKI_URL),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: '.temp',
    };
    const title = `Public domain proof ${randomUUID()}`;
    const work = (
      await activateMetadataWork(env, {
        title,
        admission: {
          id: randomUUID(),
          scope: 'work:create:root',
          action: 'work.create',
          idempotencyKey: `pd-work-${randomUUID()}`,
          requestDigest: metadataWorkRequestDigest(title),
          authorityEpoch: '0',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })
    ).work;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await accessPool.query(
      `INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3)`,
      [principalId, principal.issuer, principal.subject],
    );
    await accessPool.query(
      `INSERT INTO access.authority_subject (id, kind)
        VALUES ($1,'agent')`,
      [actor],
    );
    async function grant(scope: string, action: string) {
      await accessPool.query(
        'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await accessPool.query(
        `INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), principalId, actor, action],
      );
      await accessPool.query(
        `INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`,
        [randomUUID(), actor, scope, action],
      );
    }
    await grant('rights:assess', 'rights.assess');
    await grant(`content:draft:${work}`, 'content.draft');
    await grant(`content:search-eligibility:${variantId}`, 'content.search-eligibility');
    await grant(`content:search-eligibility:${work}`, 'content.search-eligibility');
    const commandApp = createMainApp(env.fuseki, { environment: env, account, access: registry,
      content, contentAuthoring: content, rights: { store: rights } });
    const material = publicDomainWorkMaterial(work);
    const assessment = {
      actingSubject: actor,
      material,
      expressionKind: 'expression' as const,
      ...PUBLIC_DOMAIN_TEXT_USE,
      basis: 'public_domain' as const,
      outcome: 'supported' as const,
      licenseInstrument: null,
      exceptionKind: null,
      rationale: null,
      extent: {},
      evidence: { source: 'Project Gutenberg catalog and work review' },
      obligations: [],
      expectedAssessment: null,
      idempotencyKey: `pd-assess-${randomUUID()}`,
    };
    const source = {
      provider: 'project-gutenberg',
      identifier: 'ebook/1342',
      url: 'https://www.gutenberg.org/ebooks/1342',
      byteDigest: 'a'.repeat(64),
      retrievedAt: new Date().toISOString(),
    };
    const marker = `publicdomain${randomUUID().replaceAll('-', '')}`;
    const draft = {
      resourceId: work,
      variant: {
        id: variantId,
        resourceId: work,
        language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' },
        direction: 'ltr' as const,
      },
      expectedHead: null,
      body: `A short ${marker} passage.`,
      actingSubject: actor,
      publicDomain: { assessmentId: randomUUID(), source },
      idempotencyKey: `pd-missing-${randomUUID()}`,
    };
    const request = new Request('http://main.local/v1/content-drafts', {
      method: 'POST',
      headers: { authorization: 'Bearer qa' },
    });
    await expect(
      saveAdmittedContentDraft(env, content, account, registry, request, draft, rights),
    ).rejects.toBeInstanceOf(ContentDraftDenied);
    const missingResponse = await commandApp.handle(new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': `pd-missing-http-${randomUUID()}` },
      body: JSON.stringify({ profile: 'content-public-domain-text-v1', resourceId: work, variantId,
        language: draft.variant.language, direction: draft.variant.direction, expectedHead: null,
        body: draft.body, actingSubject: actor, assessmentId: draft.publicDomain.assessmentId, source }),
    }));
    expect(missingResponse.status).toBe(403);
    expect(await missingResponse.json()).toMatchObject({ code: 'public_domain_assessment_required' });
    const accepted = await rights.assess(principal, assessment);
    const draftKey = `pd-draft-${randomUUID()}`;
    const savedResponse = await commandApp.handle(new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': draftKey },
      body: JSON.stringify({ profile: 'content-public-domain-text-v1', resourceId: work, variantId,
        language: draft.variant.language, direction: draft.variant.direction, expectedHead: null,
        body: draft.body, actingSubject: actor, assessmentId: accepted.assessmentId, source }),
    }));
    expect(savedResponse.status, await savedResponse.clone().text()).toBe(201);
    const savedPayload = await savedResponse.json() as { revisionId: string; byteDigest: string;
      sourcePosition: { dataEpoch: string } };
    const saved = { ...savedPayload, position: savedPayload.sourcePosition };
    if (!saved.revisionId) throw new Error('public-domain draft has no revision');
    const exact = (
      await content.readExactBatch([saved.revisionId], async (ids) => new Set(ids))
    )[0];
    if (exact?.status !== 'available') throw new Error('public-domain draft bytes are unavailable');
    expect(exact.reference.provenance).toMatchObject({
      kind: 'admitted-public-domain-v1',
      rightsBasis: 'public-domain',
      transcriber: actor,
      rightsAssessmentId: accepted.assessmentId,
      source,
    });
    expect(exact.reference.provenance).not.toHaveProperty('author');
    const publication = {
      preparationId: `pd-publish-${randomUUID()}`,
      revisionId: saved.revisionId,
      expectedDigest: saved.byteDigest,
      expectedContentEpoch: saved.position.dataEpoch,
      resourceId: work,
      variantId,
      expectedPublicationHead: null,
    };
    const publicationAdmission: RegisteredAdmission = {
      id: randomUUID(),
      principalId,
      actingSubject: actor,
      scope: `content:publish:${variantId}`,
      action: 'content.publish',
      idempotencyKey: `pd-publish-${randomUUID()}`,
      requestDigest: contentPublicationDigest(publication),
      authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed',
      dispatchEligible: true,
      replayed: false,
    };
    const published = await publishPinnedContent(env, content, publicationAdmission, publication);
    expect(published.status).toBe('active');
    const eligibility: ContentSearchEligibilityInput = {
      profile: 'content-search-eligibility-v2',
      resourceId: work,
      variantId,
      publicationDecision: published.decision!,
      expectedEligibilityHead: null,
      actingSubject: actor,
      rightsBasis: 'public-domain',
      assessmentId: accepted.assessmentId,
      disclosure: 'public',
    };
    const selectedResponse = await commandApp.handle(new Request('http://main.local/v1/content-search-eligibility', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': `pd-eligibility-${randomUUID()}` },
      body: JSON.stringify(eligibility),
    }));
    expect(selectedResponse.status, await selectedResponse.clone().text()).toBe(201);
    const selected = await selectedResponse.json() as { outcome: string; decision: string };
    expect(selected.outcome).toBe('succeeded');
    const cursor = new ContentProjectionCursor(contentPool);
    const consumer = `pd-${randomUUID()}`;
    await cursor.initialize(consumer);
    while (
      BigInt((await cursor.read(consumer)).sequence) <
      BigInt((await content.ownerPosition()).sequence)
    ) {
      if (!(await relayContentProjectionOnce(env, content, cursor, consumer))) {
        throw new Error('Content relay stopped early');
      }
    }
    expect(
      (
        await queryPublicContentPhrase(
          env,
          content,
          cursor,
          consumer,
          { phrase: marker, language: 'en' },
          rights,
        )
      ).total,
    ).toBe(1);
    // The read authorization is isolated here; this assertion exercises the separate rights fence.
    registry.canReadWork = async () => true;
    const app = createMainApp(env.fuseki, {
      environment: env,
      account,
      access: registry,
      content,
      contentAuthoring: content,
      contentProjection: { content, cursor, consumer },
      rights: { store: rights },
    });
    const read = () =>
      app.handle(
        new Request(
          `http://main.local/v1/content-revisions/${saved.revisionId}` +
            `?actingSubject=${encodeURIComponent(actor)}`,
          { headers: { authorization: 'Bearer qa' } },
        ),
      );
    const search = () => app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-content-phrase-v1', phrase: marker, language: 'en' }),
    }));
    expect((await read()).status).toBe(200);
    expect(await (await search()).json()).toMatchObject({ complete: true, total: 1 });
    const withdrawn = await rights.assess(principal, {
      ...assessment,
      outcome: 'not_supported',
      expectedAssessment: accepted.assessmentId,
      idempotencyKey: `pd-withdraw-${randomUUID()}`,
    });
    expect(withdrawn.predecessor).toBe(accepted.assessmentId);
    expect(await rights.currentPublicDomainAssessment(work, accepted.assessmentId)).toBe(false);
    await expect(content.preparePublication(`pd-after-withdraw-${randomUUID()}`,
      saved.revisionId, saved.byteDigest, true, saved.position.dataEpoch))
      .rejects.toThrow('public-domain assessment is not current');
    const replay = await commandApp.handle(new Request('http://main.local/v1/content-drafts', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': draftKey },
      body: JSON.stringify({ profile: 'content-public-domain-text-v1', resourceId: work, variantId,
        language: draft.variant.language, direction: draft.variant.direction, expectedHead: null,
        body: draft.body, actingSubject: actor, assessmentId: accepted.assessmentId, source }),
    }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ revisionId: saved.revisionId, replayed: true });
    await expect(
      saveAdmittedContentDraft(
        env,
        content,
        account,
        registry,
        request,
        {
          ...draft,
          expectedHead: saved.revisionId,
          publicDomain: {
            assessmentId: accepted.assessmentId,
            source,
          },
          idempotencyKey: `pd-withdrawn-${randomUUID()}`,
        },
        rights,
      ),
    ).rejects.toBeInstanceOf(ContentDraftDenied);
    const later = await registry.register({
      principal,
      actingSubject: actor,
      scope: `content:search-eligibility:${variantId}`,
      action: 'content.search-eligibility',
      idempotencyKey: `pd-later-${randomUUID()}`,
      requestDigest: contentSearchEligibilityDigest({
        ...eligibility,
        expectedEligibilityHead: selected.decision,
      }),
    });
    await expect(
      selectPublicContentSearch(
        env,
        content,
        registry,
        await registry.claim(later.id, later.requestDigest),
        { ...eligibility, expectedEligibilityHead: selected.decision },
        rights,
      ),
    ).rejects.toBeInstanceOf(ContentEligibilityDenied);
    expect(
      (
        await queryPublicContentPhrase(
          env,
          content,
          cursor,
          consumer,
          { phrase: marker, language: 'en' },
          rights,
        )
      ).total,
    ).toBe(0);
    expect(await (await search()).json()).toMatchObject({ complete: true, total: 0 });
    expect((await read()).status).toBe(404);
  } finally {
    await Promise.all([accessPool.end(), contentPool.end()]);
    await databases.close();
  }
}, 120_000);
