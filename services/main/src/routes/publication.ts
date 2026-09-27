import { Elysia, t } from 'elysia';
import { ObjectIntegrityError, ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { readRealmMediaSet, RealmMediaUnavailable } from '../modules/content-publication/realm-media.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { AdmissionUnavailable } from '../modules/access/admission.ts';
import { rejectAdmittedOrganizationPublication }
  from '../modules/work/reject-organization-admitted.ts';
import { organizationRejectionBody, organizationRejectionResult }
  from '../modules/work/organization-rejection-schemas.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import { iri } from '../modules/work/activate.ts';
import { selectAdmittedMainDefault } from '../modules/work/select-main-admitted.ts';
import { selectAdmittedRealmLocal } from '../modules/work/select-realm-admitted.ts';
import { rejectAdmittedRealmLocal } from '../modules/work/reject-realm-admitted.ts';
import { realmSelectionSlotIri } from '../modules/work/select-realm.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from '../modules/space/create.ts';
import { PUBLIC_SEARCH_GRAPH } from '../modules/work/select-main.ts';
import { listEligibleNativeVariants, NativeVariantUnavailable, readEligibleNativeVariant,
  readMainDefaultVariant, readNativeMainWork } from '../modules/work/native-variants.ts';
import { readRealmAdoptedVariant, readRealmVariantDecision }
  from '../modules/work/realm-variant-recommendation.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { authorizedReadProblems, mainSelectionReadResult, publicationRejectionWriteResult,
  publicationSelectionWriteResult, readProblems, realmSelectionReadResult, writeProblems }
  from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const nativeVariantRef = t.Object({ contribution: t.String(), publicationDecision: t.String(),
  selectedDraft: t.String(), language: t.String(), author: t.String() });

const readerPreferenceRef = t.Nullable(t.Object({ contribution: t.String(), revision: t.String() }));

const nativeVariantSelection = t.Object({ profile: t.Literal('reader-native-variant-selection-v1'),
  work: t.String(), mainVersion: t.String(), mainSelection: t.Nullable(t.String()),
  reason: t.Union([t.Literal('personal-preference'), t.Literal('main-default'),
    t.Literal('preferred-ineligible')]), preference: readerPreferenceRef,
  chosen: t.Object({ ...nativeVariantRef.properties, body: t.String() }),
});

const realmRecommendationRef = t.Nullable(t.Object({ contribution: t.String(), revision: t.String() }));

const realmNativeVariantSelection = t.Union([
  t.Object({ profile: t.Literal('reader-realm-native-variant-selection-v1'),
    status: t.Literal('suppressed'), work: t.String(), mainVersion: t.String(),
    realm: t.String(), rejection: t.String() }),
  t.Object({ profile: t.Literal('reader-realm-native-variant-selection-v1'),
    status: t.Literal('selected'), work: t.String(), mainVersion: t.String(), realm: t.String(),
    mainSelection: t.Nullable(t.String()), realmSelection: t.Nullable(t.String()),
    reason: t.Union([t.Literal('realm-adoption'), t.Literal('personal-preference'),
      t.Literal('realm-recommendation'), t.Literal('main-default'),
      t.Literal('preferred-ineligible'), t.Literal('recommended-ineligible'),
      t.Literal('preferred-and-recommended-ineligible')]),
    preference: readerPreferenceRef, recommendation: realmRecommendationRef,
    chosen: t.Object({ ...nativeVariantRef.properties, body: t.String() }),
  }),
]);

export function publicationRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/publication-selections', {
      body: t.Union([t.Object({
        profile: t.Literal('main-default-selection-v1'),
        context: t.Object({ kind: t.Literal('main-version-default'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        publicationDecision: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedSelectionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        selectionBasis: t.Literal('main-maintainer'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('realm-local-selection-v1'),
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        publicationDecision: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        media: t.Optional(t.Object({
          variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
          publicationDecision: t.String({ pattern: '^urn:rezics:content-publication:[0-9a-f]{64}$' }),
        }, { additionalProperties: false })),
        expectedSelectionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        selectionBasis: t.Literal('realm-manager-review'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false })]),
      response: { 200: publicationSelectionWriteResult, 201: publicationSelectionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        if (body.profile === 'realm-local-selection-v1') {
          if (body.media && !work.content) {
            return problem(503, 'selection_unavailable', 'Content owner is unavailable');
          }
          const receipt = await selectAdmittedRealmLocal(work.environment, work.account,
            work.access, request, { context: body.context, work: body.work,
              mainVersion: body.mainVersion, contribution: body.contribution,
              publicationDecision: body.publicationDecision,
              ...(body.media ? { media: body.media } : {}),
              expectedSelectionHead: body.expectedSelectionHead,
              selectionBasis: body.selectionBasis, actingSubject: body.actingSubject,
              idempotencyKey }, work.content);
          return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
            realm: receipt.realm, slot: receipt.slot,
            contribution: receipt.contribution, publicationDecision: receipt.publicationDecision,
            selectedDraft: receipt.selectedDraft, selection: receipt.selection,
            matchUnit: receipt.matchUnit, predecessor: receipt.expectedHead,
            sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
              sequence: receipt.sequence }, replayed: receipt.replayed }, {
            status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
          });
        }
        const receipt = await selectAdmittedMainDefault(work.environment, work.account,
          work.access, request, { context: body.context, work: body.work,
            contribution: body.contribution, publicationDecision: body.publicationDecision,
            expectedSelectionHead: body.expectedSelectionHead,
            selectionBasis: body.selectionBasis, actingSubject: body.actingSubject,
            idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          mainRevision: receipt.mainRevision,
          contribution: receipt.contribution, publicationDecision: receipt.publicationDecision,
          selectedDraft: receipt.selectedDraft, selection: receipt.selection,
          matchUnit: receipt.matchUnit, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/organization-publication-rejections', {
      body: organizationRejectionBody,
      response: { 200: organizationRejectionResult, 201: organizationRejectionResult,
        202: pendingOperation, ...writeProblems },
    }, async ({ request, body }) => {
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        if (!work.organizationModeration) throw new AdmissionUnavailable('moderation owner unavailable');
        const receipt = await rejectAdmittedOrganizationPublication(work.environment, work.account,
          work.organizationModeration, work.access, request, body, key);
        return Response.json({ profile: body.profile, work: receipt.work, mainVersion: receipt.mainVersion,
          realm: receipt.realm, slot: receipt.slot, rejection: receipt.rejection,
          reasonCode: receipt.reasonCode, predecessor: receipt.expectedHead,
          organizationSubject: body.organizationSubject, participationId: body.participationId,
          participationGeneration: body.participationGeneration, proposalId: body.proposalId,
          contribution: body.contribution, publicationDecision: body.publicationDecision,
          selectedDraft: body.selectedDraft, expectedWorkHead: body.expectedWorkHead,
          authorityProofDigest: receipt.authorityProofDigest,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, { status: receipt.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .post('/v1/publication-rejections', {
      body: t.Object({
        profile: t.Literal('realm-local-rejection-v1'),
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedSelectionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        decisionBasis: t.Literal('realm-manager-review'),
        reasonCode: t.Literal('not-approved'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: publicationRejectionWriteResult, 201: publicationRejectionWriteResult,
        202: pendingOperation, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await rejectAdmittedRealmLocal(work.environment, work.account,
          work.access, request, { context: body.context, work: body.work,
            mainVersion: body.mainVersion, expectedSelectionHead: body.expectedSelectionHead,
            decisionBasis: body.decisionBasis, reasonCode: body.reasonCode,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          realm: receipt.realm, slot: receipt.slot, rejection: receipt.rejection,
          reasonCode: receipt.reasonCode, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/realms/:realm/main-versions/:mainVersion/selection', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: realmSelectionReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const realm = `https://rezics.com/id/${params.realm}`;
        const main = `https://rezics.com/id/${params.mainVersion}`;
        const slot = realmSelectionSlotIri(realm, main);
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?work ?selection ?contribution ?draft ?language ?body ?reason
            ?mediaVariant ?mediaDecision ?mediaRevision ?mediaDigest ?mediaProof
            ?effectiveContext ?suppressed WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
              ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
              ${iri(main)} a rv:MainVersion ; rv:work ?work .
              OPTIONAL { ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
                rv:mainVersion ${iri(main)} ; rv:selectionHead ?local }
              OPTIONAL { ${iri(main)} rv:selectionHead ?fallback }
            }
            BIND(COALESCE(?local, ?fallback) AS ?selection)
            BIND(IF(BOUND(?local), ${iri(realm)}, ${iri(main)}) AS ?effectiveContext)
            BIND(IF(BOUND(?local), "realm-adoption", "main-fallback") AS ?reason)
            OPTIONAL {
              GRAPH <urn:rezics:graph:revisions> {
                ?selection a rv:RealmPublicationRejection ; rv:slot ${iri(slot)} ;
                  rv:work ?work ; rv:mainVersion ${iri(main)} ;
                  rv:reasonCode rv:NotApproved .
              }
              BIND(true AS ?suppressed)
            }
            OPTIONAL {
              FILTER(!BOUND(?suppressed))
              GRAPH <urn:rezics:graph:revisions> {
                ?selection a rv:PublicationSelection ; rv:work ?work ;
                  rv:mainVersion ${iri(main)} ; rv:contribution ?contribution ;
                  rv:selectedDraft ?draft ; rv:matchUnit ?unit .
                OPTIONAL { ?selection rv:mediaVariant ?mediaVariant ;
                  rv:mediaPublicationDecision ?mediaDecision ;
                  rv:mediaRevision ?mediaRevision ; rv:mediaDigest ?mediaDigest . }
                OPTIONAL { FILTER(BOUND(?mediaDecision))
                  ?mediaDecision a rv:ContentPublicationDecision ;
                  rv:component ?mediaVariant ; rv:resource ?work ;
                  rv:contentModel "media-set-v1" ; rv:contentRevision ?mediaRevision ;
                  rv:byteDigest ?mediaDigest . BIND(true AS ?mediaProof) }
              }
              GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
                ?unit a rv:MatchUnit ; rv:selection ?selection ;
                  rv:mainVersion ${iri(main)} ; rv:context ?effectiveContext ;
                  rv:disclosure rv:Public ; rv:language ?language ; rv:searchBody ?body .
              }
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.selection) {
          return problem(404, 'selection_unavailable', 'Realm selection is unavailable');
        }
        const row = rows[0]!;
        if (row.suppressed?.value === 'true') {
          return Response.json({ status: 'suppressed', reason: 'realm-rejection',
            work: row.work!.value, mainVersion: main, realm,
            effectiveContext: realm, rejection: row.selection!.value,
            reasonCode: 'not-approved' }, { headers: { 'cache-control': 'no-store' } });
        }
        if (!row.contribution || !row.draft || !row.language
          || !row.body || !row.reason || !row.effectiveContext) {
          return problem(404, 'selection_unavailable', 'Realm selection is unavailable');
        }
        let media: { variantId: string; publicationDecision: string; revisionId: string;
          items: Array<{ use: string; mediaType: string; width: number; height: number; url: string }> } | undefined;
        if (row.mediaVariant || row.mediaDecision || row.mediaRevision || row.mediaDigest) {
          const revision = /^urn:rezics:content:revision:([0-9a-f-]{36})$/
            .exec(row.mediaRevision?.value ?? '');
          if (!work.content || !row.mediaVariant || !row.mediaDecision || !revision
            || row.mediaProof?.value !== 'true'
            || !row.mediaDigest) {
            return problem(503, 'selection_unavailable', 'Realm media selection is unavailable');
          }
          const reference = { variantId: row.mediaVariant.value,
            publicationDecision: row.mediaDecision.value, revisionId: revision[1]!,
            byteDigest: row.mediaDigest.value };
          const items = await readRealmMediaSet(work.content, row.work!.value, reference);
          media = { variantId: reference.variantId, publicationDecision: reference.publicationDecision,
            revisionId: reference.revisionId,
            items: items.map(item => ({ use: item.use, mediaType: item.mediaType,
              width: item.width, height: item.height,
              url: `/v1/realms/${params.realm}/main-versions/${params.mainVersion}`
                + `/selections/${row.selection!.value.slice('https://rezics.com/id/'.length)}`
                + `/media/${item.use}` })) };
        }
        return Response.json({ work: row.work!.value, mainVersion: main, realm,
          effectiveContext: row.effectiveContext!.value, reason: row.reason!.value,
          selection: row.selection!.value, contribution: row.contribution!.value,
          selectedDraft: row.draft!.value, language: row.language!.value,
          body: row.body!.value, ...(media ? { media } : {}) },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof RealmMediaUnavailable) {
          return problem(503, 'selection_unavailable', 'Realm media selection is unavailable');
        }
        return commandError(error);
      }
    })
    .get('/v1/realms/:realm/main-versions/:mainVersion/selections/:selection/media/:use', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        selection: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        use: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: t.Any(), ...readProblems },
    }, async ({ params }: { params: { realm: string; mainVersion: string;
      selection: string; use: string } }) => {
      if (!work.content || !work.media) {
        return problem(503, 'selection_unavailable', 'Realm media selection is unavailable');
      }
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const realm = `https://rezics.com/id/${params.realm}`;
        const main = `https://rezics.com/id/${params.mainVersion}`;
        const selection = `https://rezics.com/id/${params.selection}`;
        const slot = realmSelectionSlotIri(realm, main);
        const rows = (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?work ?variant ?decision ?revision ?digest WHERE {
            GRAPH <urn:rezics:graph:current> {
              ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
              ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
                rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
              ${iri(main)} a rv:MainVersion ; rv:work ?work .
              ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
                rv:mainVersion ${iri(main)} ; rv:work ?work ; rv:selectionHead ${iri(selection)} . }
            GRAPH <urn:rezics:graph:revisions> {
              ${iri(selection)} a rv:PublicationSelection ; rv:slot ${iri(slot)} ;
                rv:work ?work ; rv:mainVersion ${iri(main)} ;
                rv:mediaVariant ?variant ; rv:mediaPublicationDecision ?decision ;
                rv:mediaRevision ?revision ; rv:mediaDigest ?digest . }
            GRAPH <urn:rezics:graph:revisions> {
              ?decision a rv:ContentPublicationDecision ; rv:component ?variant ;
                rv:resource ?work ; rv:contentModel "media-set-v1" ;
                rv:contentRevision ?revision ; rv:byteDigest ?digest . }
          }`)).results?.bindings ?? [];
        const row = rows[0];
        const revision = /^urn:rezics:content:revision:([0-9a-f-]{36})$/
          .exec(row?.revision?.value ?? '');
        if (rows.length !== 1 || !row?.work || !row.variant || !row.decision
          || !revision || !row.digest) {
          return problem(404, 'selection_unavailable', 'Realm media selection is unavailable');
        }
        const items = await readRealmMediaSet(work.content, row.work.value,
          { variantId: row.variant.value, publicationDecision: row.decision.value,
            revisionId: revision[1]!, byteDigest: row.digest.value });
        const selected = items.find(item => item.use === params.use);
        if (!selected) return problem(404, 'selection_unavailable', 'Realm media item is unavailable');
        const basis = await work.media.store.itemDelivery(params.use);
        if (!basis || basis.target !== row.work.value || basis.sha256 !== selected.sha256
          || basis.mediaType !== selected.mediaType || basis.width !== selected.width
          || basis.height !== selected.height || basis.availability !== 'available'
          || basis.disclosure !== 'public' || basis.moderation !== 'none'
          || basis.lifecycle !== 'active') {
          return problem(404, 'selection_unavailable', 'Realm media item is unavailable');
        }
        const bytes = await work.media.objects(basis.objectNamespace).get(basis.sha256);
        return new Response(new Uint8Array(bytes), { headers: { 'content-type': basis.mediaType,
          etag: `"${basis.sha256}"`, 'x-content-type-options': 'nosniff',
          'cache-control': 'public, no-cache' } });
      } catch (error) {
        if (error instanceof RealmMediaUnavailable) {
          return problem(503, 'selection_unavailable', 'Realm media selection is unavailable');
        }
        if (error instanceof ObjectUnavailable || error instanceof ObjectIntegrityError) {
          return problem(503, 'media_unavailable', 'Media bytes are unavailable');
        }
        return commandError(error);
      }
    })
    .get('/v1/main-versions/:mainVersion/native-variants', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ language: t.Optional(t.String({ minLength: 2, maxLength: 35 })) },
        { additionalProperties: false }),
      response: { 200: t.Object({ work: t.String(), mainVersion: t.String(),
        complete: t.Literal(true), variants: t.Array(nativeVariantRef) }),
      ...readProblems, 422: problemResult(422) },
    }, async ({ params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const result = await listEligibleNativeVariants(work.environment, mainVersion, query.language);
        return Response.json({ work: result.work, mainVersion,
          complete: true, variants: result.variants }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .put('/v1/me/main-versions/:mainVersion/variant-preference', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('reader-native-variant-preference-v1'),
        contribution: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
      }, { additionalProperties: false }),
      response: { 200: t.Object({ mainVersion: t.String(), preference: readerPreferenceRef,
        replayed: t.Boolean() }), 201: t.Object({ mainVersion: t.String(),
        preference: readerPreferenceRef, replayed: t.Boolean() }),
      ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ params, body, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.readerPreferences) {
          return problem(503, 'dependency_unavailable', 'Reader preference owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['work:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Reader principal is inactive');
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const input = { mainVersion, contribution: body.contribution,
          expectedRevision: body.expectedRevision, idempotencyKey: key };
        const replay = await work.readerPreferences.replay(principalId, input);
        if (replay) return Response.json({ mainVersion, ...replay },
          { headers: { 'cache-control': 'no-store' } });
        if (body.contribution) {
          const candidate = await readEligibleNativeVariant(work.environment,
            mainVersion, body.contribution);
          if (!candidate) return problem(404, 'variant_unavailable', 'Native variant is unavailable');
        } else {
          await readNativeMainWork(work.environment, mainVersion);
        }
        const result = await work.readerPreferences.set(principalId, input);
        return Response.json({ mainVersion, ...result }, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/me/main-versions/:mainVersion/selection', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: nativeVariantSelection, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ params, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.readerPreferences) {
          return problem(503, 'dependency_unavailable', 'Reader preference owner is unavailable');
        }
        const principal = await work.account.verify(request, ['work:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Reader principal is inactive');
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const preference = await work.readerPreferences.read(principalId, mainVersion);
        if (preference) {
          const preferred = await readEligibleNativeVariant(work.environment,
            mainVersion, preference.contribution);
          if (preferred) {
            return Response.json({ profile: 'reader-native-variant-selection-v1',
              work: preferred.work, mainVersion, mainSelection: null,
              reason: 'personal-preference', preference,
              chosen: { ...preferred.variant, body: preferred.body } },
            { headers: { 'cache-control': 'no-store' } });
          }
        }
        const fallback = await readMainDefaultVariant(work.environment, mainVersion);
        return Response.json({ profile: 'reader-native-variant-selection-v1',
          work: fallback.work, mainVersion, mainSelection: fallback.selection,
          reason: preference ? 'preferred-ineligible' : 'main-default', preference,
          chosen: { ...fallback.variant, body: fallback.body } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .put('/v1/realms/:realm/main-versions/:mainVersion/variant-recommendation', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      body: t.Object({ profile: t.Literal('realm-native-variant-recommendation-v1'),
        contribution: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
      response: { 200: t.Object({ realm: t.String(), mainVersion: t.String(),
        recommendation: realmRecommendationRef, replayed: t.Boolean() }),
      201: t.Object({ realm: t.String(), mainVersion: t.String(),
        recommendation: realmRecommendationRef, replayed: t.Boolean() }),
      ...writeProblems, 404: problemResult(404), 422: problemResult(422) },
    }, async ({ params, body, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.realmRecommendations) {
          return problem(503, 'dependency_unavailable', 'Realm recommendation owner is unavailable');
        }
        const key = request.headers.get('idempotency-key');
        if (!key) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key is required');
        const principal = await work.account.verify(request, ['realm:adopt']);
        const realm = `https://rezics.com/id/${params.realm}`;
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const input = { realm, mainVersion, contribution: body.contribution,
          expectedRevision: body.expectedRevision, actingSubject: body.actingSubject,
          idempotencyKey: key };
        await readRealmVariantDecision(work.environment, realm, mainVersion);
        const eligible = async () => {
          const decision = await readRealmVariantDecision(work.environment, realm, mainVersion);
          if (decision.kind !== 'none') return false;
          if (body.contribution === null) return true;
          const [fallback, candidate] = await Promise.all([
            readMainDefaultVariant(work.environment, mainVersion),
            readEligibleNativeVariant(work.environment, mainVersion, body.contribution),
          ]);
          return !!candidate && candidate.work === decision.work
            && candidate.variant.language === fallback.variant.language;
        };
        const result = await work.realmRecommendations.set(principal, input, eligible);
        return Response.json({ realm, mainVersion, ...result }, {
          status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/me/realms/:realm/main-versions/:mainVersion/selection', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: realmNativeVariantSelection, ...authorizedReadProblems,
        422: problemResult(422) },
    }, async ({ params, request }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        if (!work.readerPreferences || !work.realmRecommendations) {
          return problem(503, 'dependency_unavailable', 'Reader selection owner is unavailable');
        }
        const principal = await work.account.verify(request, ['work:read']);
        const principalId = await work.access.activePrincipalId(principal);
        if (!principalId) return problem(403, 'authority_denied', 'Reader principal is inactive');
        const realm = `https://rezics.com/id/${params.realm}`;
        const mainVersion = `https://rezics.com/id/${params.mainVersion}`;
        const decision = await readRealmVariantDecision(work.environment, realm, mainVersion);
        const profile = 'reader-realm-native-variant-selection-v1';
        const ensureNoRealmDecision = async () => {
          const current = await readRealmVariantDecision(work.environment, realm, mainVersion);
          if (current.kind !== 'none' || current.work !== decision.work) {
            throw new NativeVariantUnavailable('Realm decision changed during reader selection');
          }
        };
        if (decision.kind === 'rejected') {
          return Response.json({ profile, status: 'suppressed', work: decision.work,
            mainVersion, realm, rejection: decision.selection },
          { headers: { 'cache-control': 'no-store' } });
        }
        const [preference, recommendation] = await Promise.all([
          work.readerPreferences.read(principalId, mainVersion),
          work.realmRecommendations.read(realm, mainVersion),
        ]);
        if (decision.kind === 'adopted') {
          const chosen = await readRealmAdoptedVariant(work.environment, realm, mainVersion,
            decision.work, decision.selection!);
          return Response.json({ profile, status: 'selected', work: decision.work,
            mainVersion, realm, mainSelection: null, realmSelection: decision.selection,
            reason: 'realm-adoption', preference, recommendation, chosen },
          { headers: { 'cache-control': 'no-store' } });
        }
        if (preference) {
          const preferred = await readEligibleNativeVariant(work.environment,
            mainVersion, preference.contribution);
          if (preferred) {
            await ensureNoRealmDecision();
            return Response.json({ profile, status: 'selected', work: preferred.work,
              mainVersion, realm, mainSelection: null, realmSelection: null,
              reason: 'personal-preference', preference, recommendation,
              chosen: { ...preferred.variant, body: preferred.body } },
            { headers: { 'cache-control': 'no-store' } });
          }
        }
        const fallback = await readMainDefaultVariant(work.environment, mainVersion);
        if (recommendation) {
          const recommended = await readEligibleNativeVariant(work.environment,
            mainVersion, recommendation.contribution);
          if (recommended && recommended.variant.language === fallback.variant.language) {
            await ensureNoRealmDecision();
            return Response.json({ profile, status: 'selected', work: recommended.work,
              mainVersion, realm, mainSelection: null, realmSelection: null,
              reason: 'realm-recommendation', preference, recommendation,
              chosen: { ...recommended.variant, body: recommended.body } },
            { headers: { 'cache-control': 'no-store' } });
          }
        }
        await ensureNoRealmDecision();
        return Response.json({ profile, status: 'selected', work: fallback.work,
          mainVersion, realm, mainSelection: fallback.selection, realmSelection: null,
          reason: preference && recommendation ? 'preferred-and-recommended-ineligible'
            : preference ? 'preferred-ineligible'
            : recommendation ? 'recommended-ineligible' : 'main-default',
          preference, recommendation, chosen: { ...fallback.variant, body: fallback.body } },
        { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    })
    .get('/v1/main-versions/:mainVersion/selection', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      response: { 200: mainSelectionReadResult, ...readProblems },
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const main = `https://rezics.com/id/${params.mainVersion}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?work ?selection ?contribution ?draft ?language ?body WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(main)} a rv:MainVersion ; rv:work ?work ; rv:selectionHead ?selection .
            }
            GRAPH <urn:rezics:graph:revisions> {
              ?selection a rv:PublicationSelection ; rv:component ${iri(main)} ;
                rv:contribution ?contribution ; rv:selectedDraft ?draft ; rv:matchUnit ?unit .
            }
            GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
              ?unit a rv:MatchUnit ; rv:selection ?selection ;
                rv:mainVersion ${iri(main)} ; rv:disclosure rv:Public ;
                rv:language ?language ; rv:searchBody ?body .
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.selection
          || !rows[0]?.contribution || !rows[0]?.draft || !rows[0]?.language
          || !rows[0]?.body) {
          return problem(404, 'selection_unavailable', 'Main Version selection is unavailable');
        }
        const row = rows[0]!;
        return Response.json({ work: row.work!.value, mainVersion: main,
          selection: row.selection!.value, contribution: row.contribution!.value,
          selectedDraft: row.draft!.value, language: row.language!.value,
          body: row.body!.value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
