import { Elysia, ParseError, ValidationError, t } from 'elysia';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable } from './modules/access/admission.ts';
import type { AccessAdmissionRegistry } from './modules/access/admission.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from './modules/account/verify-assertion.ts';
import type { AccountAssertionVerifier } from './modules/account/verify-assertion.ts';
import { createAdmittedMetadataWork, PendingAdmittedWork } from './modules/work/create-admitted.ts';
import { editAdmittedMetadataWork } from './modules/work/edit-admitted.ts';
import { StaleWorkHead, WorkEditUnavailable } from './modules/work/edit.ts';
import { readExactWorkRevision, RevisionCorrupt, RevisionNotFound,
  RevisionUnavailable } from './modules/work/history.ts';
import { assertGraphAdmissionOpen, RecoveryHold } from './modules/work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict, iri, type WorkActivationEnvironment } from './modules/work/activate.ts';
import { createAdmittedTextContribution } from './modules/contribution/create-admitted.ts';
import { ContributionWorkUnavailable, InvalidContributionInput } from './modules/contribution/draft.ts';
import { readExactContributionDraft } from './modules/contribution/history.ts';
import { editAdmittedTextContribution } from './modules/contribution/edit-admitted.ts';
import { ContributionEditUnavailable, StaleContributionDraftHead } from './modules/contribution/edit.ts';
import { publishAdmittedTextContribution } from './modules/contribution/publish-admitted.ts';
import { InvalidPublicationInput, PublicationUnavailable,
  StalePublicationHead } from './modules/contribution/publish.ts';
import { selectAdmittedMainDefault } from './modules/work/select-main-admitted.ts';
import { selectAdmittedRealmLocal } from './modules/work/select-realm-admitted.ts';
import { InvalidRealmSelectionInput, RealmSelectionUnavailable, StaleRealmSelection,
  realmSelectionSlotIri } from './modules/work/select-realm.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from './modules/space/create.ts';
import { InvalidMainSelectionInput, MainSelectionUnavailable, PUBLIC_SEARCH_GRAPH,
  StaleMainSelection } from './modules/work/select-main.ts';
import { InvalidPublicQuery, PublicQueryBudgetExceeded, PublicQueryUnavailable,
  PublicRealmUnavailable, queryPublicMainPhrase,
  queryPublicRealmPhrase } from './modules/work/search-public.ts';
import { createAdmittedRealmSpace } from './modules/space/create-admitted.ts';
import { InvalidSpaceInput } from './modules/space/create.ts';

export interface MainWorkDependencies {
  environment: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  access: Pick<AccessAdmissionRegistry,
    'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork' | 'canReadContributionDraft'>;
}

function problem(status: number, code: string, title: string, headers?: HeadersInit): Response {
  return Response.json({ type: `https://rezics.com/problems/${code}`, title, status, code }, {
    status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...headers },
  });
}

function commandError(error: unknown): Response {
  if (error instanceof PendingAdmittedWork) {
    return Response.json({ operationId: error.operationId, status: 'reconciling', phase: error.phase,
      result: null, retry: { allowed: true, afterMs: 1000 } }, {
      status: 202, headers: { 'cache-control': 'no-store', 'retry-after': '1' },
    });
  }
  if (error instanceof AccountAssertionDenied) {
    return problem(401, 'account_assertion_denied', 'Account assertion is invalid or inactive',
      { 'www-authenticate': 'Bearer' });
  }
  if (error instanceof AdmissionDenied) return problem(403, 'authority_denied', 'Authority is not admitted');
  if (error instanceof InvalidContributionInput || error instanceof InvalidPublicationInput
    || error instanceof InvalidMainSelectionInput || error instanceof InvalidPublicQuery
    || error instanceof InvalidSpaceInput || error instanceof InvalidRealmSelectionInput) {
    return problem(400, 'invalid_request', 'Request fields are invalid');
  }
  if (error instanceof AdmissionConflict || error instanceof IdempotencyConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
  }
  if (error instanceof CancelledActivation) return problem(409, 'operation_cancelled', 'Work operation was cancelled');
  if (error instanceof StaleWorkHead) return problem(409, 'stale_head', 'Expected Work revision is stale');
  if (error instanceof StaleContributionDraftHead) {
    return problem(409, 'stale_head', 'Expected Contribution draft revision is stale');
  }
  if (error instanceof StalePublicationHead) {
    return problem(409, 'stale_head', 'Expected Contribution publication state is stale');
  }
  if (error instanceof StaleMainSelection) {
    return problem(409, 'stale_head', 'Expected Main Version selection is stale');
  }
  if (error instanceof StaleRealmSelection) {
    return problem(409, 'stale_head', 'Expected Realm selection is stale');
  }
  if (error instanceof WorkEditUnavailable || error instanceof ContributionWorkUnavailable) {
    return problem(404, 'work_unavailable', 'Work is unavailable');
  }
  if (error instanceof ContributionEditUnavailable || error instanceof PublicationUnavailable) {
    return problem(404, 'contribution_unavailable', 'Contribution is unavailable');
  }
  if (error instanceof MainSelectionUnavailable) {
    return problem(404, 'selection_unavailable', 'Main Version selection is unavailable');
  }
  if (error instanceof RealmSelectionUnavailable) {
    return problem(404, 'selection_unavailable', 'Realm selection is unavailable');
  }
  if (error instanceof PublicQueryBudgetExceeded) {
    return problem(422, 'query_budget_exceeded', 'Public query exceeds the complete-result budget');
  }
  if (error instanceof PublicQueryUnavailable) {
    return problem(503, 'query_unavailable', 'Public query snapshot is unavailable');
  }
  if (error instanceof PublicRealmUnavailable) {
    return problem(404, 'realm_unavailable', 'Realm is unavailable');
  }
  if (error instanceof RevisionNotFound) return problem(404, 'revision_unavailable', 'Revision is unavailable');
  if (error instanceof RevisionUnavailable || error instanceof RevisionCorrupt) {
    return problem(503, 'revision_unavailable', 'Committed revision bytes are unavailable');
  }
  if (error instanceof RecoveryHold) {
    return problem(503, 'recovery_hold', 'Product access is held for recovery reconciliation');
  }
  if (error instanceof AccountAssertionUnavailable || error instanceof AdmissionUnavailable) {
    return problem(503, 'dependency_unavailable', 'A required authority service is unavailable',
      { 'retry-after': '1' });
  }
  return problem(503, 'dependency_unavailable', 'Work operation could not be completed', { 'retry-after': '1' });
}

export function createMainApp(fuseki: FusekiClient, work?: MainWorkDependencies) {
  const app = new Elysia()
    .error(({ error }) => {
      if (error instanceof ValidationError || error instanceof ParseError) {
        return problem(400, 'invalid_request', 'Request does not match the Work contract');
      }
      return problem(500, 'internal_error', 'Request could not be processed');
    })
    .get('/health/live', {
      response: t.Object({ status: t.Literal('ok') }),
    }, () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready') }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      try {
        const result = await fuseki.query('ASK {}');
        if (result.boolean !== true) throw new Error('unexpected Fuseki result');
        if (work) {
          await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        }
        return { status: 'ready' as const };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    });
  if (work) {
    app.post('/v1/spaces', {
      body: t.Object({ profile: t.Literal('space-realm-v1'),
        name: t.String({ minLength: 1, maxLength: 120,
          pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        capabilities: t.Tuple([t.Literal('realm')]),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedRealmSpace(work.environment, work.account, work.access,
          request, { name: body.name, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ space: receipt.space, realm: receipt.realm,
          spaceRevision: receipt.spaceRevision, realmRevision: receipt.realmRevision,
          owner: receipt.owner, capabilities: ['realm'],
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    });
    app.get('/v1/spaces/:space', {
      params: t.Object({ space: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const space = `https://rezics.com/id/${params.space}`;
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?realm ?owner ?name ?spaceRevision ?realmRevision
            ?selectionPolicy ?membershipPolicy ?reviewPolicy WHERE {
            GRAPH <urn:rezics:graph:current> {
              ${iri(space)} a rv:Space ; rv:disclosure rv:Public ; rv:realmCapability ?realm ;
                rv:owner ?owner ; rdfs:label ?name ; rv:head ?spaceRevision .
              ?realm a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active ;
                rv:head ?realmRevision ; rv:selectionPolicy ?selectionPolicy ;
                rv:membershipPolicy ?membershipPolicy ; rv:reviewPolicy ?reviewPolicy .
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.realm || !rows[0]?.owner || !rows[0]?.name
          || !rows[0]?.spaceRevision || !rows[0]?.realmRevision || !rows[0]?.selectionPolicy
          || !rows[0]?.membershipPolicy || !rows[0]?.reviewPolicy) {
          return problem(404, 'space_unavailable', 'Space is unavailable');
        }
        const row = rows[0]!;
        return Response.json({ space, realm: row.realm!.value, owner: row.owner!.value,
          name: row.name!.value, capabilities: ['realm'], state: 'active',
          spaceRevision: row.spaceRevision!.value, realmRevision: row.realmRevision!.value,
          selectionPolicy: row.selectionPolicy!.value,
          membershipPolicy: row.membershipPolicy!.value,
          reviewPolicy: row.reviewPolicy!.value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
    app.post('/v1/queries', {
      body: t.Union([t.Object({ profile: t.Literal('public-main-phrase-v1'),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]) }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-phrase-v1'),
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]) }, { additionalProperties: false })]),
    }, async ({ body }) => {
      try {
        const result = body.profile === 'public-realm-phrase-v1'
          ? await queryPublicRealmPhrase(work.environment, body)
          : await queryPublicMainPhrase(work.environment, body);
        return Response.json(result, {
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    });
    app.post('/v1/publication-selections', {
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
        expectedSelectionHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        selectionBasis: t.Literal('realm-manager-review'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false })]),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        if (body.profile === 'realm-local-selection-v1') {
          const receipt = await selectAdmittedRealmLocal(work.environment, work.account,
            work.access, request, { context: body.context, work: body.work,
              mainVersion: body.mainVersion, contribution: body.contribution,
              publicationDecision: body.publicationDecision,
              expectedSelectionHead: body.expectedSelectionHead,
              selectionBasis: body.selectionBasis, actingSubject: body.actingSubject,
              idempotencyKey });
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
          contribution: receipt.contribution, publicationDecision: receipt.publicationDecision,
          selectedDraft: receipt.selectedDraft, selection: receipt.selection,
          matchUnit: receipt.matchUnit, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    });
    app.get('/v1/realms/:realm/main-versions/:mainVersion/selection', {
      params: t.Object({ realm: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
    }, async ({ params }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const realm = `https://rezics.com/id/${params.realm}`;
        const main = `https://rezics.com/id/${params.mainVersion}`;
        const slot = realmSelectionSlotIri(realm, main);
        const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
          SELECT ?work ?selection ?contribution ?draft ?language ?body ?reason ?effectiveContext WHERE {
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
            GRAPH <urn:rezics:graph:revisions> {
              ?selection a rv:PublicationSelection ; rv:work ?work ;
                rv:mainVersion ${iri(main)} ; rv:contribution ?contribution ;
                rv:selectedDraft ?draft ; rv:matchUnit ?unit .
            }
            GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
              ?unit a rv:MatchUnit ; rv:selection ?selection ;
                rv:mainVersion ${iri(main)} ; rv:context ?effectiveContext ;
                rv:disclosure rv:Public ; rv:language ?language ; rv:searchBody ?body .
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.work || !rows[0]?.selection
          || !rows[0]?.contribution || !rows[0]?.draft || !rows[0]?.language
          || !rows[0]?.body || !rows[0]?.reason || !rows[0]?.effectiveContext) {
          return problem(404, 'selection_unavailable', 'Realm selection is unavailable');
        }
        const row = rows[0]!;
        return Response.json({ work: row.work!.value, mainVersion: main, realm,
          effectiveContext: row.effectiveContext!.value, reason: row.reason!.value,
          selection: row.selection!.value, contribution: row.contribution!.value,
          selectedDraft: row.draft!.value, language: row.language!.value,
          body: row.body!.value }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
    app.get('/v1/main-versions/:mainVersion/selection', {
      params: t.Object({ mainVersion: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
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
    app.post('/v1/contribution-publications', {
      body: t.Object({
        profile: t.Literal('text-publication-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedDraftHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedPublicationHead: t.Union([
          t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }), t.Null(),
        ]),
        rightsBasis: t.Literal('original-contribution'),
        disclosure: t.Literal('public'),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await publishAdmittedTextContribution(work.environment, work.account,
          work.access, request, { contribution: body.contribution,
            expectedDraftHead: body.expectedDraftHead,
            expectedPublicationHead: body.expectedPublicationHead,
            rightsBasis: body.rightsBasis, disclosure: body.disclosure,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          publicationDecision: receipt.publicationDecision,
          selectedDraft: receipt.selectedDraft, predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    });
    app.post('/v1/contribution-edits', {
      body: t.Object({
        profile: t.Literal('text-contribution-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        body: t.String({ minLength: 1, maxLength: 65536 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedTextContribution(work.environment, work.account,
          work.access, request, { contribution: body.contribution, expectedHead: body.expectedHead,
            body: body.body, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          draftRevision: receipt.draftRevision, predecessor: receipt.expectedHead,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    });
    app.post('/v1/contributions', {
      body: t.Object({
        profile: t.Literal('text-contribution-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        language: t.String({ minLength: 2, maxLength: 35,
          pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }),
        body: t.String({ minLength: 1, maxLength: 65536 }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedTextContribution(work.environment, work.account,
          work.access, request, { work: body.work, language: body.language,
            body: body.body, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ contribution: receipt.contribution,
          draftRevision: receipt.draftRevision, work: receipt.work,
          language: receipt.language, author: receipt.author,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch,
            sequence: receipt.sequence }, replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) { return commandError(error); }
    });
    app.get('/v1/contributions/:contribution/drafts/:revision', {
      params: t.Object({ contribution: t.String({ pattern: '^[0-9a-f-]{36}$' }),
        revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const contribution = `https://rezics.com/id/${params.contribution}`;
        const revision = await readExactContributionDraft(work.environment, contribution,
          `https://rezics.com/id/${params.revision}`, async target => {
            if (!await work.access.canReadContributionDraft(
              principal, query.actingSubject, target)) return false;
            const current = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
              PREFIX schema: <https://schema.org/> ASK {
                GRAPH <urn:rezics:graph:current> {
                  ${iri(target)} a rv:TextContribution ; rv:work ?work .
                  ?work a schema:CreativeWork .
                }
              }`);
            return current.boolean === true;
          });
        return Response.json(revision, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
    app.post('/v1/works', {
      body: t.Object({
        profile: t.Literal('metadata-only-v1'),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await createAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { title: body.title, actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ work: receipt.work, mainVersion: receipt.mainVersion,
          workRevision: receipt.workRevision, mainRevision: receipt.mainRevision,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: receipt.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    });
    app.post('/v1/content-edits', {
      body: t.Object({
        profile: t.Literal('metadata-only-v1'),
        work: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        title: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }),
    }, async ({ request, body }) => {
      const idempotencyKey = request.headers.get('idempotency-key');
      if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const receipt = await editAdmittedMetadataWork(work.environment, work.account, work.access,
          request, { work: body.work, expectedHead: body.expectedHead, title: body.title,
            actingSubject: body.actingSubject, idempotencyKey });
        return Response.json({ work: receipt.work, revision: receipt.revision,
          predecessor: receipt.predecessor,
          sourcePosition: { datasetId: 'product', dataEpoch: receipt.dataEpoch, sequence: receipt.sequence },
          replayed: receipt.replayed }, {
          status: 200, headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return commandError(error);
      }
    });
    app.get('/v1/revisions/:revision', {
      params: t.Object({ revision: t.String({ pattern: '^[0-9a-f-]{36}$' }) }),
      query: t.Object({ actingSubject: t.String({
        pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
      }) }, { additionalProperties: false }),
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const revision = await readExactWorkRevision(work.environment,
          `https://rezics.com/id/${params.revision}`, async workId => {
            if (!await work.access.canReadWork(principal, query.actingSubject, workId)) return false;
            const current = await fuseki.query(`PREFIX schema: <https://schema.org/>
              ASK { GRAPH <urn:rezics:graph:current> { ${iri(workId)} a schema:CreativeWork } }`);
            return current.boolean === true;
          });
        return Response.json(revision, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return commandError(error);
      }
    });
  }
  return app;
}
