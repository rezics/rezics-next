import { isForegroundOperation } from './support/operation-cost.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PoolClient } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { nativeId, shortId } from '../fixtures/author-credit.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { prideExample } from '../../../packages/wiki-toolkit/skill/examples/pride.ts';
import { submitWikiBundle } from '../../../packages/wiki-toolkit/src/submit.ts';
import { DATASET, GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { WorkReadUnavailable } from '../../../services/main/src/modules/work/read-session.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from '../../../services/main/src/modules/classification/global.ts';
import { type ResourceSummary } from '../../../services/main/src/modules/media/summary.ts';
import { type Static } from 'typebox';
import { subjectStatementPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import {
  readCurrentOccurrence,
  readExactDefinition,
} from '../../../services/main/src/modules/relation/change.ts';
import { systemDisclosure } from '../../../services/main/src/modules/target/disclosed-references.ts';
import { startMediaStack } from './media-support.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';

test('G-920: published franchise entities, contradictory claims and relations disclose evidence and names at the reader position', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-920-${randomUUID()}`);
  const f = await startMediaStack('g-920', { profileCredits: true });
  const nativeCommand = f.env.fuseki.command.bind(f.env.fuseki);
  f.env.fuseki.command = async envelope => {
    const result = await nativeCommand(envelope);
    if (result.status === 'invalid') {
      mkdirSync(resolve('.temp/goal'), {recursive: true});
      writeFileSync(resolve('.temp/goal/g920-native-refusal.json'), JSON.stringify({receipt: envelope.receipt,result},null,2));
    }
    return result;
  };
  const sourceIndex = f.env.fuseki.templateIndex.bind(f.env.fuseki);
  f.env.fuseki.templateIndex = (async (...args: Parameters<typeof sourceIndex>) => {
    try { return await sourceIndex(...args); }
    catch (error) {
      const input = args[0] as {operation:string};
      if (input.operation === 'statement-publication-page') {
        const response = await fetch(new URL('command',Bun.env.FUSEKI_URL!), {
          method: 'POST', headers: {'content-type':'application/json',authorization:`Bearer ${Bun.env.FUSEKI_COMMAND_TOKEN!}`},
          body: JSON.stringify({templateIndex: input}),
        });
        mkdirSync(resolve('.temp/goal'), {recursive: true});
        writeFileSync(resolve('.temp/goal/g920-native-source-refusal.json'),JSON.stringify({
          input,status: response.status,body: await response.text(),
        },null,2));
      }
      throw error;
    }
  }) as typeof f.env.fuseki.templateIndex;
  const holder = await f.member('holder');
  const reviewerA = await f.member('reviewer-a');
  const reviewerB = await f.member('reviewer-b');
  const outsider = await f.member('outsider');
  const tokens = new Map<string, { issuer: string; subject: string }>([
    [holder.token, holder.principal],
    [reviewerA.token, reviewerA.principal],
    [reviewerB.token, reviewerB.principal],
    [outsider.token, outsider.principal],
  ]);
  await grantRecordedPlatformUse(f.accessPool, holder.principalId, ['wiki-agents']);
  const objects = f.objects('semantic/structure/');
  await objects.initialize();
  const deps: MainWorkDependencies = {
    environment: f.env,
    access: f.access,
    account: {
      verify: async (request) => {
        const principal = tokens.get(
          request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
        );
        if (!principal) throw new Error('QA bearer is missing');
        return principal;
      },
    },
    platformAccess: new AccessExposure(f.accessPool),
    // The public statement page refuses until this index covers the graph
    // position. The media stack already owns the seek for this dataset.
    statementSeek: f.statementSeek,
    structureObjects: objects,
    wikiEvidence: new WikiEvidenceStore(f.contentPool),
    wikiQuotations: new WikiQuotationStore(f.contentPool),
    media: f.media,
    mediaAccess: f.mediaAccess,
    readingPositions: new ReadingPositionStore(f.contentPool),
    editorialReview: new EditorialReviewStore(f.accessPool),
    rights: { store: new RightsStore(f.contentPool, f.accessPool) },
    content: f.content,
    contentAuthoring: f.content,
  };
  const app = createMainApp(f.env.fuseki, deps);
  const call = (
    method: string,
    path: string,
    body?: object,
    token: string | null = holder.token,
    key = randomUUID(),
  ) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          'idempotency-key': key,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  async function textOf(response: Response, status: number): Promise<string> {
    const text = await response.text();
    if (response.status !== status)
      throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return text;
  }
  async function json<T>(response: Response, status = 200): Promise<T> {
    return JSON.parse(await textOf(response, status)) as T;
  }
  try {
    for (const person of [holder, reviewerA, reviewerB, outsider]) {
      await person.grant(`agent:self:${person.actor}`, 'agent.control');
    }
    await holder.grant('work:create:root', 'work.create');
    const createdWork = await json<{ work: string; mainVersion: string }>(
      await call('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        grain: 'new-creative-scope',
        authoring: 'own-work',
        title: 'Pride and Prejudice',
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: holder.actor,
      }),
      201,
    );
    await holder.grant(`work:read:${createdWork.work}`, 'work.read');
    await holder.grant(`work:edit:${createdWork.work}`, 'work.edit');
    expect((await call('GET',`/v1/resources/${shortId(createdWork.work)}`,undefined,null)).status).toBe(404);
    for (const reviewer of [reviewerA, reviewerB]) {
      await reviewer.grant(`work:read:${createdWork.work}`, 'work.read');
      await reviewer.grant(`work:edit:${createdWork.work}`, 'work.edit');
      await reviewer.grant(`work:review:${createdWork.work}`, 'work.review');
    }
    await holder.grant(`contribution:create:${createdWork.work}`, 'contribution.create');
    const draft = await json<{ contribution: string; draftRevision: string }>(
      await call('POST', '/v1/contributions', {
        profile: 'text-contribution-v1',
        work: createdWork.work,
        language: 'en',
        body: 'Chapter one of Pride and Prejudice.',
        actingSubject: holder.actor,
      }),
      201,
    );
    await holder.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
    await holder.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
    const decision = await json<{ publicationDecision: string }>(
      await call('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: holder.actor,
      }),
      201,
    );
    await holder.grant(`publication:select:${createdWork.mainVersion}`, 'publication.select');
    await json(
      await call('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1',
        context: { kind: 'main-version-default', id: createdWork.mainVersion },
        work: createdWork.work,
        contribution: draft.contribution,
        publicationDecision: decision.publicationDecision,
        expectedSelectionHead: null,
        selectionBasis: 'main-maintainer',
        actingSubject: holder.actor,
      }),
      201,
    );
    const structure = await json<{ structure: string; revision: string }>(
      await call('POST', '/v1/compositions', {
        profile: 'book-composition',
        work: createdWork.work,
        mainVersion: createdWork.mainVersion,
        actingSubject: holder.actor,
      }),
      201,
    );
    const chapter = await json<{ occurrences: string[] }>(
      await call('POST', `/v1/compositions/${shortId(structure.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: structure.revision,
        actingSubject: holder.actor,
        operations: [
          {
            op: 'insert',
            parent: structure.structure,
            position: 'last',
            role: 'chapter',
            target: 'https://schema.org/DigitalDocument',
            label: { value: 'Chapter one', language: 'en' },
          },
          {
            op: 'insert',
            parent: structure.structure,
            position: 'last',
            role: 'chapter',
            target: 'https://schema.org/DigitalDocument',
            label: { value: 'Chapter two', language: 'en' },
          },
        ],
      }),
    );
    const lateOccurrence = chapter.occurrences[1]!;
    const occurrence = chapter.occurrences[0];
    if (!occurrence) throw new Error('Book composition returned no chapter');
    await holder.grant('semantic:create:root', 'semantic.change');
    const predicate = await json<{ component: string; revision: string }>(
      await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: holder.actor,
        state: { component: 'definition', kind: 'property' },
      }),
      201,
    );
    await holder.grant(`semantic:read:${predicate.component}`, 'semantic.read');
    await reviewerB.grant(`semantic:read:${predicate.component}`, 'semantic.read');
    await reviewerB.grant('semantic:create:root', 'semantic.change');
    await reviewerB.grant(`statement:speak:${reviewerB.actor}`, 'statement.record');
    const relation = await json<{ component: string }>(
      await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: holder.actor,
        state: {
          component: 'definition',
          kind: 'relation',
          roles: ['subject', 'object'].map((key) => ({
            key,
            minParticipants: 1,
            maxParticipants: 1,
            ordered: false,
          })),
        },
      }),
      201,
    );
    await holder.grant(`semantic:read:${relation.component}`, 'semantic.read');
    await reviewerB.grant(`semantic:read:${relation.component}`, 'semantic.read');
    await reviewerB.grant('relation:create:root', 'relation.change');
    const collections: Record<string, string> = {};
    for (const segment of ['franchise', 'characters', 'places', 'events', 'chapters']) {
      const collection = nativeId();
      await holder.grant(`collection:edit:${collection}`, 'collection.edit');
      await holder.grant(`semantic:read:${collection}`, 'semantic.read');
      await reviewerB.grant(`collection:edit:${collection}`, 'collection.edit');
      const created = await json<{ structure: string; revision: string }>(
        await call('POST', '/v1/collections', {
          collection,
          name: segment,
          language: 'en',
          disclosure: 'public',
          actingSubject: holder.actor,
        }),
        201,
      );
      if (segment === 'franchise') {
        await json(
          await call('POST', `/v1/collections/${shortId(collection)}/changes`, {
            expectedHead: created.revision,
            actingSubject: holder.actor,
            operations: [
              {
                op: 'insert',
                role: 'member',
                parent: created.structure,
                position: 'last',
                target: createdWork.work,
              },
            ],
          }),
        );
      }
      collections[segment] = collection;
    }
    await holder.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(
      await call('POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'Pride wiki',
        capabilities: ['realm'],
        actingSubject: holder.actor,
      }),
      201,
    );
    const zone = nativeId();
    await holder.grant(`zone:edit:${zone}`, 'zone.edit');
    await holder.grant(`semantic:read:${zone}`, 'semantic.read');
    let navigation = await json<{ revision: string }>(
      await call('POST', '/v1/zones', {
        zone,
        space: space.space,
        disclosure: 'public',
        actingSubject: holder.actor,
      }),
      201,
    );
    const membership = await normalizeStoredMembership(f.env);
    expect(membership.complete).toBe(true);
    expect((await f.env.fuseki.membershipPreparationStatus()).needsPreparation).toBe(false);
    for (const [routeSegment, target] of Object.entries(collections)) {
      navigation = await json(
        await call('POST', `/v1/zones/${shortId(zone)}/mounts`, {
          expectedHead: navigation.revision,
          target,
          routeSegment,
          position: 'last',
          disclosure: 'public',
          actingSubject: holder.actor,
        }),
      );
    }
    const root = resolve(import.meta.dir, '../../..');
    mkdirSync(directory, { recursive: true });
    const file = resolve(directory, 'pride.txt');
    const pride = Buffer.from(
      JSON.parse(
        readFileSync(
          resolve(
            root,
            'tests/fixtures/gutenberg/6f7ec2a018dd7b7ddaed1e6117e299c25945faa082880fe63fb0b51a722b7ccb.json',
          ),
          'utf8',
        ),
      ).text,
    );
    writeFileSync(file, pride);
    const lines = execFileSync(
      'bun',
      [resolve(root, 'packages/wiki-toolkit/src/cli.ts'), 'units', file],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
    )
      .trim()
      .split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(61);
    const bundle = prideExample(readFileSync(file), {
      target: createdWork.work,
      zone,
      continuity: createdWork.work,
      occurrence,
      predicate: predicate.component,
    });
    const earlyUnit = bundle.units[0]!.id,
      lateUnit = 'chapter-two';
    bundle.units.push({
      id: lateUnit,
      ordinal: bundle.units[0]!.ordinal + 1,
      label: 'Chapter two',
      occurrence: lateOccurrence,
    });
    bundle.entities[0]!.names.push({
      value: 'Bennet revealed',
      language: 'ja',
      kind: 'primary',
      revealedAt: lateUnit,
    });
    for (const [id, type, name, unit] of [
      ['role', 'Role', 'Father', earlyUnit],
      ['place', 'Place', 'Longbourn', earlyUnit],
      ['event', 'Event', 'The late visit', lateUnit],
    ]) {
      bundle.entities.push({
        id: id!,
        type: `${type === 'Role' ? RV : 'https://schema.org/'}${type}`,
        names: [{ value: name!, language: 'en', kind: 'primary', revealedAt: unit! }],
      });
    }
    const original = bundle.claims[0]!;
    bundle.claims.push(
      {
        ...original,
        object: { kind: 'literal', value: 'Not Mr. Bennet', language: 'en' },
        revealedAt: lateUnit,
      },
      { ...original, predicate: relation.component, object: { kind: 'entity', ref: 'place' } },
      {
        ...original,
        predicate: relation.component,
        object: { kind: 'entity', ref: 'event' },
        revealedAt: lateUnit,
      },
    );
    const candidates = await json<{ items: { status: string }[] }>(
      await call('POST', '/v1/wiki/candidates', {
        target: createdWork.work,
        zone,
        actingSubject: holder.actor,
        names: [
          { value: 'Mr. Bennet', language: 'en', type: 'https://rezics.com/vocab/Character' },
        ],
      }),
    );
    expect(candidates.items[0]!.status).toBe('new');
    const quote = bundle.claims[0]!.evidence[0]!;
    const verified = JSON.parse(
      execFileSync(
        'bun',
        [
          resolve(root, 'packages/wiki-toolkit/src/cli.ts'),
          'verify',
          file,
          JSON.stringify(quote.locator),
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(verified.quote).toBe(quote.quote);
    expect(
      await json(
        await call('POST', '/v1/wiki/validations', { actingSubject: holder.actor, bundle }),
      ),
    ).toMatchObject({
      status: 'acceptable',
      entities: [
        { id: 'mr-bennet', action: 'create' },
        { id: 'role', action: 'create' },
        { id: 'place', action: 'create' },
        { id: 'event', action: 'create' },
      ],
      alignment: [{ status: 'aligned' }, { status: 'aligned' }],
    });
    const header = await json<{ revision: string; disclosure: string }>(
      await call(
        'GET',
        `/v1/works/${shortId(createdWork.work)}?actingSubject=${encodeURIComponent(holder.actor)}`,
      ),
    );
    expect(header.disclosure).toBe('public');
    const submitted = await submitWikiBundle(
      {
        send: async (request) => {
          const response = await app.handle(
            new Request(`http://main.local${request.path}`, {
              method: request.method,
              headers: request.headers,
              body: JSON.stringify(request.body),
            }),
          );
          return { status: response.status, body: JSON.parse(await response.text()) as unknown };
        },
      },
      {
        target: {
          resource: createdWork.work,
          revision: header.revision,
          context: 'urn:rezics:context:global',
        },
        bundle,
        baseHeads: [{ component: createdWork.work, head: header.revision }],
        evidence: [],
        actingSubject: holder.actor,
      },
      `Bearer ${holder.token}`,
      randomUUID(),
    );
    if (submitted.status !== 201)
      throw new Error(`Expected 201, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);
    const proposal = submitted.body as { proposal: string; outcome: string };
    expect(proposal.outcome).toBe('created');
    for (const reviewer of [reviewerA, reviewerB]) {
      const review = await json<{ outcome: string }>(
        await call(
          'POST',
          `/v1/editorial/proposals/${proposal.proposal}/reviews`,
          {
            profile: 'editorial-proposal-review-v1',
            revision: 1,
            outcome: 'approve',
            message: 'The Mr. Bennet citation matches the edition',
            actingSubject: reviewer.actor,
          },
          reviewer.token,
        ),
      );
      expect(review.outcome).toBe('approve');
    }
    const viewed = await json<{
      state: string;
      approvalIds: string[];
      allowedActions: string[];
      timeline: { actor: string; review: { outcome: string } | null }[];
    }>(
      await call(
        'GET',
        `/v1/editorial/proposals/${proposal.proposal}?actingSubject=${encodeURIComponent(reviewerB.actor)}`,
        undefined,
        reviewerB.token,
      ),
    );
    expect(viewed.state).toBe('approved');
    expect(viewed.allowedActions).toContain('apply');
    // The read returns at most the adapter's required approval. Both independent
    // approvals remain on the proposal timeline.
    expect(viewed.approvalIds.length).toBeGreaterThanOrEqual(1);
    expect(
      viewed.timeline
        .filter((event) => event.review?.outcome === 'approve')
        .map((event) => event.actor)
        .sort(),
    ).toEqual([reviewerA.actor, reviewerB.actor].sort());
    const applyKey = randomUUID();
    let receipt:
      | {
          commands?: { key: string; outcome: string; result: { component?: string } }[];
          owner: { evidence?: string[] };
        }
      | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await call(
        'POST',
        `/v1/editorial/proposals/${proposal.proposal}/decisions`,
        {
          profile: 'editorial-proposal-decide-v1',
          revision: 1,
          outcome: 'applied',
          approve: false,
          message: 'Citations match the edition',
          actingSubject: reviewerB.actor,
        },
        reviewerB.token,
        applyKey,
      );
      const text = await response.text();
      if (response.status !== 200 && response.status !== 202)
        throw new Error(`${response.status}: ${text}`);
      const result = JSON.parse(text) as { outcome: string; receipt?: typeof receipt };
      if (result.receipt) {
        receipt = result.receipt;
        break;
      }
      if (result.outcome !== 'apply_pending') throw new Error(text);
    }
    if (!receipt?.commands?.length) throw new Error('Bundle did not finish its bounded deliveries');
    expect(receipt.commands.every((command) => command.outcome === 'applied')).toBe(true);
    const component = (suffix: string) => {
      const row = receipt!.commands!.find((command) => command.key.endsWith(`:${suffix}`));
      if (row?.outcome !== 'applied' || !row.result.component) {
        throw new Error(`Missing applied ${suffix}: ${JSON.stringify(receipt!.commands)}`);
      }
      return row.result.component;
    };
    const entity = component('entity:mr-bennet');
    const statement = component('claim:0');
    const evidenceIds = receipt.owner.evidence ?? [];
    expect(evidenceIds).toHaveLength(4);
    const evidenceId = shortId(evidenceIds[0]!);
    const laterStatement = component('claim:1'),
      earlyRelation = component('claim:2'),
      lateRelation = component('claim:3');
    const place = component('entity:place'),
      event = component('entity:event'),
      role = component('entity:role');
    const at = (path: string, position: string | undefined, signed: boolean) =>
      call(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}${position ? `position=${encodeURIComponent(position)}&` : ''}${signed ? `actingSubject=${encodeURIComponent(holder.actor)}` : ''}`,
        undefined,
        signed ? holder.token : null,
      );
    const recordProposal = async (index: number) =>
      json(
        await call(
          'POST',
          '/v1/statements',
          {
            profile: 'statement-v1',
            speaker: { kind: 'personal' },
            subject: entity,
            predicate: predicate.component,
            relationDefinition: predicate.revision,
            value: {
              kind: 'literal',
              lexical: `Unaccepted proposal ${index}`,
              language: null,
              datatype: 'http://www.w3.org/2001/XMLSchema#string',
            },
            applicability: [],
            interpretation: { kind: 'selected' },
            evidence: [],
            actingSubject: reviewerB.actor,
          },
          reviewerB.token,
        ),
        201,
      );
    // Run the existing owner's local checkpoint steps, without starting another
    // worker or treating global raw replay as publication coverage.
    const sourcePages: Array<{examined: number;witnessTuples: number;complete: boolean;
      after: {storage: string;phase: number;key: string};references: number}> = [];
    const completePublication = async () => {
      const basis = await f.statementSeek.capturePublicationBasis(entity);
      expect(basis).not.toBeNull();
      if (!basis) throw new Error('Wiki fixture unexpectedly initialized Global');
      for (let step = 0; step < 40; step++) {
        try {
          await f.statementSeek.requirePublicationCoverage(basis);
          return basis;
        } catch (error) {
          if (!(error instanceof WorkReadUnavailable)) throw error;
        }
        const nativeIndex = f.env.fuseki.templateIndex.bind(f.env.fuseki);
        f.env.fuseki.templateIndex = (async (...args: Parameters<typeof nativeIndex>) => {
          const result = await nativeIndex(...args);
          if (args[0].operation === 'statement-publication-page') {
            const page = result as unknown as {examined: number;witnessTuples: number;complete: boolean;
              after: {storage: string;phase: number;key: string} | null;references: unknown[]};
            expect(page.examined).toBeGreaterThanOrEqual(0);
            expect(page.examined).toBeLessThanOrEqual(128);
            expect(page.witnessTuples).toBeGreaterThanOrEqual(0);
            expect(page.witnessTuples).toBeLessThanOrEqual(8192);
            expect(page.references.length).toBeLessThanOrEqual(127);
            if (page.complete) {
              expect(page.after?.phase).toBe(2);
              expect(page.after?.key).toBe('');
            }
            // Basis-only capture and sealed EOF rechecks do not advance the
            // physical stream; retain only traversal turns for lookahead totals.
            const requestedAfter = (args[0] as {after: 'basis' | {phase: number} | null}).after;
            if (requestedAfter !== 'basis' && requestedAfter?.phase !== 2) {
              if (!page.after) throw new Error('Native publication page has no physical continuation');
              sourcePages.push({examined: page.examined,witnessTuples: page.witnessTuples,
                complete: page.complete,after: page.after,references: page.references.length});
            }
          }
          return result;
        }) as typeof f.env.fuseki.templateIndex;
        try { expect(await f.statementSeek.projectPublicationOnce()).toBe(true); }
        finally { f.env.fuseki.templateIndex = nativeIndex; }
      }
      throw new Error('Publication reconstruction did not finish its bounded steps');
    };

    // A real owner write lands after the summary's first graph probe. Both
    // transports replay the read, retaining one Account verification.
    for (const method of ['GET', 'POST']) {
      const query = f.env.fuseki.query.bind(f.env.fuseki),
        verify = deps.account.verify;
      let raced = false,
        verifications = 0,
        summaries = 0;
      deps.account.verify = async (request, scopes) => {
        if (new URL(request.url).pathname.startsWith('/v1/resources')) verifications++;
        return verify(request, scopes);
      };
      f.env.fuseki.query = async (sparql, maxBytes) => {
        const result = await query(sparql, maxBytes);
        if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
          summaries++;
          if (!raced) {
            raced = true;
            await recordProposal(-1);
          }
        }
        return result;
      };
      try {
        const response =
          method === 'GET'
            ? await at(`/v1/resources/${shortId(createdWork.work)}`, undefined, true)
            : await call('POST', '/v1/resources/summaries', {
                profile: 'resource-summary-batch-v1',
                resources: [createdWork.work],
                actingSubject: holder.actor,
              });
        await json(response);
        expect(raced).toBe(true);
        expect(summaries).toBeGreaterThanOrEqual(2);
        expect(verifications).toBe(1);
      } finally {
        f.env.fuseki.query = query;
        deps.account.verify = verify;
      }
    }
    // Published claims are already in the graph. The page reads them from the
    // seek index at the current position, so catch that index up before the
    // first statement page and again after later statement writes.
    await f.statementSeek.rebuild();
    expect((await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false)).status).toBe(503);
    await completePublication();
    // Raw writes cannot manufacture default-only source storage. The native
    // controlled TDB preparation test covers that imported representation and
    // its missing named reference witness; preserve this transport refusal.
    await expect(f.env.fuseki.update(`INSERT DATA {
      ${iri(statement)} <${RV}defaultSourceFixture> true }`)).rejects.toThrow('Fuseki update returned');
    for (const signed of [false, true]) {
      expect((await at(`/v1/resources/${shortId(entity)}/page`, undefined, signed)).status).toBe(
        404,
      );
      const noPosition = await json<{ summaries: ResourceSummary[] }>(
        await call(
          'POST',
          '/v1/resources/summaries',
          {
            profile: 'resource-summary-batch-v1',
            resources: [entity, role, place, event],
            ...(signed ? { actingSubject: holder.actor } : {}),
          },
          signed ? holder.token : null,
        ),
      );
      expect(noPosition.summaries.map((item) => item.status)).toEqual(Array(4).fill('unavailable'));
      for (const position of [occurrence, lateOccurrence, 'all']) {
        const late = position !== occurrence;
        for (const resource of [entity, role, place, event])
          expect(
            (await at(`/v1/resources/${shortId(resource)}/page`, position, signed)).status,
          ).toBe(resource === event && !late ? 404 : 200);
        const facts = await json<Static<typeof subjectStatementPage>>(
          await at(`/v1/resources/${shortId(entity)}/statements`, position, signed),
        );
        const statements = facts.groups
          .flatMap((group) => group.items)
          .filter((item) => item.kind === 'statement');
        expect(statements.map((item) => item.statement).sort()).toEqual(
          (late ? [statement, laterStatement] : [statement]).sort(),
        );
        for (const item of statements) {
          expect(item.acceptance).toBeNull();
          expect(item.publication).toEqual({ kind: 'wiki-bundle', works: [createdWork.work] });
          expect(item.evidence).toHaveLength(1);
          expect(item.evidence![0]).toMatchObject({
            quote: 'My dear Mr. Bennet',
            quoteWithheld: false,
            sourceWork: createdWork.work,
          });
          expect(item.evidence![0]!.locator).toEqual(bundle.claims[0]!.evidence[0]!.locator);
        }
        const relations = await json<{
          items: { relation: string; citations: { quote: string | null }[] }[];
        }>(await at(`/v1/resources/${shortId(entity)}/relations`, position, signed));
        const occurrences = relations.items.filter((item) =>
          [earlyRelation, lateRelation].includes(item.relation),
        );
        expect(occurrences.map((item) => item.relation).sort()).toEqual(
          (late ? [earlyRelation, lateRelation] : [earlyRelation]).sort(),
        );
        expect(occurrences.every((item) => item.citations[0]?.quote === 'My dear Mr. Bennet')).toBe(
          true,
        );
        const batch = await json<{ summaries: ResourceSummary[] }>(
          await call(
            'POST',
            '/v1/resources/summaries',
            {
              profile: 'resource-summary-batch-v1',
              resources: [entity, role, place, event],
              position,
              language: 'ja',
              ...(signed ? { actingSubject: holder.actor } : {}),
            },
            signed ? holder.token : null,
          ),
        );
        expect(batch.summaries.map((item) => item.status)).toEqual([
          'available',
          'available',
          'available',
          late ? 'available' : 'unavailable',
        ]);
        expect(batch.summaries[0]?.status === 'available' && batch.summaries[0].name.value).toBe(
          late ? 'Bennet revealed' : 'Mr. Bennet',
        );
        const query = f.env.fuseki.query.bind(f.env.fuseki),
          types: string[] = [],
          summaryBatches: string[] = [];
        f.env.fuseki.query = async (sparql, maxBytes) => {
          if (sparql.includes('SELECT DISTINCT ?resource ?type')) types.push(sparql);
          if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r ?type'))
            summaryBatches.push(sparql);
          return query(sparql, maxBytes);
        };
        try {
          const index = await json<{ items: { id: string; name: { value: string } }[] }>(
            await at(`/v1/zones/${shortId(zone)}/routes?path=%2Fcharacters`, position, signed),
          );
          expect(index.items.map((item) => item.id).sort()).toEqual([entity, role].sort());
          expect(index.items.every((item) => item.name?.value)).toBe(true);
          expect(types).toHaveLength(1);
          expect(types[0]).toContain(`<${entity}>`);
          expect(types[0]).toContain(`<${role}>`);
          const names = summaryBatches.filter((query) => query.includes(`<${entity}>`));
          expect(names).toHaveLength(2);
          expect(names.every((query) => query.includes(`<${role}>`))).toBe(true);
        } finally {
          f.env.fuseki.query = query;
        }
      }
    }
    // An owner rights decision withholds quote and embedded fallback passage,
    // while retaining the published claim and its non-passage provenance.
    const withheld = deps.wikiEvidence!.withheld.bind(deps.wikiEvidence!);
    deps.wikiEvidence!.withheld = async (ids) => new Set(ids);
    try {
      const facts = await json<Static<typeof subjectStatementPage>>(
        await at(`/v1/resources/${shortId(entity)}/statements`, occurrence, false),
      );
      const claim = facts.groups
        .flatMap((group) => group.items)
        .find((item) => item.kind === 'statement');
      expect(claim?.kind === 'statement' && claim.evidence?.[0]?.quote).toBeNull();
      expect(claim?.kind === 'statement' && claim.evidence?.[0]?.quoteWithheld).toBe(true);
    } finally {
      deps.wikiEvidence!.withheld = withheld;
    }
    const hiddenPage = await call(
      'GET',
      `/v1/resources/${shortId(entity)}/page?position=start`,
      undefined,
      null,
    );
    expect(hiddenPage.status).toBe(404);
    await hiddenPage.text();
    for (const position of [occurrence, 'all']) {
      const page = await textOf(
        await call(
          'GET',
          `/v1/resources/${shortId(entity)}/page?position=${encodeURIComponent(position)}`,
          undefined,
          null,
        ),
        200,
      );
      expect(page).toContain(entity);
      expect(page).toContain(position === 'all' ? 'Bennet revealed' : 'Mr. Bennet');
    }
    const hiddenEvidence = await call(
      'GET',
      `/v1/wiki/evidence/${evidenceId}?position=start`,
      undefined,
      null,
    );
    expect(hiddenEvidence.status).toBe(404);
    await hiddenEvidence.text();
    for (const position of [occurrence, 'all']) {
      expect(
        await json(
          await call(
            'GET',
            `/v1/wiki/evidence/${evidenceId}?position=${encodeURIComponent(position)}`,
            undefined,
            null,
          ),
        ),
      ).toMatchObject({
        profile: 'wiki-evidence-v1',
        quote: 'My dear Mr. Bennet',
        claim: statement,
        claimKind: 'statement',
        quoteWithheld: false,
      });
    }
    const hiddenStatement = await call(
      'GET',
      `/v1/statements/${shortId(statement)}?position=start`,
      undefined,
      null,
    );
    expect(hiddenStatement.status).toBe(404);
    await hiddenStatement.text();
    for (const position of [occurrence, 'all']) {
      expect(
        await json(
          await call(
            'GET',
            `/v1/statements/${shortId(statement)}?position=${encodeURIComponent(position)}`,
            undefined,
            null,
          ),
        ),
      ).toMatchObject({
        profile: 'statement-v1',
        subject: entity,
        predicate: predicate.component,
        value: { kind: 'literal', lexical: 'Mr. Bennet', language: 'en' },
        state: 'active',
      });
    }
    const positions = await json<{ resolved: string; items: { occurrence: string }[] }>(
      await call(
        'GET',
        `/v1/reading-positions/${shortId(createdWork.work)}?position=all`,
        undefined,
        null,
      ),
    );
    expect(positions.resolved).toBe('all');
    expect(positions.items.some((item) => item.occurrence === occurrence)).toBe(true);
    const routes = await textOf(
      await call(
        'GET',
        `/v1/zones/${shortId(zone)}/routes?path=${encodeURIComponent(`/characters/${shortId(entity)}`)}&position=all`,
        undefined,
        null,
      ),
      200,
    );
    expect(routes).toContain(entity);
    // Pages retain every disclosed contradictory claim; changing the position
    // cannot reuse a cursor from an earlier disclosure basis.
    // Unaccepted proposals are real API writes, but do not become hydration
    // candidates. Page cost stays independent of this subject's proposal count.
    const countRead = async () => {
      const query = f.env.fuseki.query.bind(f.env.fuseki);
      const nativeIndex = f.env.fuseki.templateIndex.bind(f.env.fuseki);
      const seek = f.statementSeek.seek.bind(f.statementSeek);
      const publicationSeek = f.statementSeek.seekPotentialPublication.bind(f.statementSeek);
      let calls = 0,
        inventories = 0,
        globalCoverageReads = 0,
        responseJsonBytes = 0;
      const rawBatches: { after: Parameters<typeof seek>[2]; rows: number; visited: number }[] = [];
      const publicationBatches: { rows: number; visited: number }[] = [];
      const rawSql: { text: string; values: unknown[] }[] = [];
      const originalQueries = new Map<PoolClient,PoolClient['query']>();
      const acquire = (client: PoolClient) => {
        const original = client.query;
        originalQueries.set(client,original);
        client.query = ((...args: unknown[]) => {
          if (isForegroundOperation() && typeof args[0] === 'string'
            && args[0].includes('FROM access.statement_seek_coverage WHERE')) globalCoverageReads++;
          if (isForegroundOperation() && typeof args[0] === 'string'
            && args[0].includes('FROM access.statement_seek WHERE')) {
            rawSql.push({text: args[0],values: [...args[1] as unknown[]]});
          }
          return Reflect.apply(original,client,args);
        }) as PoolClient['query'];
      };
      const release = (_error: Error | undefined,client: PoolClient) => {
        const original = originalQueries.get(client);
        if (original) client.query = original;
        originalQueries.delete(client);
      };
      f.accessPool.on('acquire',acquire);
      f.accessPool.on('release',release);
      f.statementSeek.seek = async (...args) => {
        const result = await seek(...args);
        if (isForegroundOperation()) rawBatches.push({ after: args[2], rows: result.candidates.length, visited: result.visitedRows });
        return result;
      };
      f.statementSeek.seekPotentialPublication = async (...args) => {
        const result = await publicationSeek(...args);
        if (isForegroundOperation()) publicationBatches.push({rows: result.candidates.length,visited: result.visitedRows});
        return result;
      };
      f.env.fuseki.query = async (sparql, maxBytes) => {
        if (isForegroundOperation()) {
          calls++;
          // Hydration is bounded to accepted or readable published claims.
          // Raw StatementSeek work is measured separately below.
          if (sparql.includes('GROUP_CONCAT(DISTINCT STR(?evidence)')) inventories++;
        }
        const result = await query(sparql, maxBytes);
        if (isForegroundOperation()) responseJsonBytes += Buffer.byteLength(JSON.stringify(result));
        return result;
      };
      f.env.fuseki.templateIndex = (async (...args: Parameters<typeof nativeIndex>) => {
        if (isForegroundOperation()) calls++;
        const result = await nativeIndex(...args);
        if (isForegroundOperation()) responseJsonBytes += Buffer.byteLength(JSON.stringify(result));
        return result;
      }) as typeof f.env.fuseki.templateIndex;
      try {
        const started = performance.now();
        const page = await json<Static<typeof subjectStatementPage>>(
          await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false),
        );
        expect(
          page.groups
            .flatMap((group) => group.items)
            .flatMap((item) => (item.kind === 'statement' ? [item.statement] : []))
            .sort(),
        ).toEqual([statement, laterStatement].sort());
        expect(calls).toBeLessThanOrEqual(160);
        expect(responseJsonBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        const elapsedMs = performance.now()-started;
        expect(elapsedMs).toBeLessThan(10_000);
        return { calls, inventories, rawBatches, rawSql,publicationBatches,globalCoverageReads,
          responseJsonBytes,elapsedMs,
          rawRows: rawBatches.reduce((sum,batch) => sum+batch.rows,0),
          rawVisited: rawBatches.reduce((sum,batch) => sum+batch.visited,0),
        };
      } finally {
        f.env.fuseki.query = query;
        f.env.fuseki.templateIndex = nativeIndex;
        f.statementSeek.seek = seek;
        f.statementSeek.seekPotentialPublication = publicationSeek;
        f.accessPool.off('acquire',acquire);
        f.accessPool.off('release',release);
        for (const [client,original] of originalQueries) client.query = original;
      }
    };
    // Keep the natural planner's baseline representative of a populated store;
    // these distant leaves never belong to this subject's candidate range.
    await f.accessPool.query(`INSERT INTO access.statement_seek
      (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs,
       statement_head,publication_source,publication_evidence)
      SELECT $1,$2,$3,'urn:rezics:meaning:' || lpad(n::text,64,'0'),id,'*','[]'::jsonb,
        $4,$5,false FROM unnest($6::text[]) WITH ORDINALITY AS item(id,n)`,
      [f.env.lineage.dataEpoch,nativeId(),predicate.component,nativeId(),createdWork.work,
        Array.from({length: 4096},() => nativeId())]);
    const beforeProposals = await countRead();
    const beforePhysical = await explainRead(beforeProposals);
    const beforeMembership = await f.statementSeek.capturePublicationBasis(entity);
    for (let index = 0; index < 320; index++) await recordProposal(index);
    expect(await f.statementSeek.capturePublicationBasis(entity)).toEqual(beforeMembership);
    // Leave global raw coverage behind the real source commits. Local coverage
    // is complete, so both old sequence gates must be bypassed on this channel.
    const afterProposals = await countRead();
    const afterPhysical = await explainRead(afterProposals);
    expect(afterProposals.inventories).toBe(1);
    expect(afterProposals.calls).toBeLessThanOrEqual(beforeProposals.calls + 2);
    for (const read of [beforeProposals,afterProposals]) {
      expect(read.rawBatches).toHaveLength(0);
      expect(read.globalCoverageReads).toBe(0);
      expect(read.publicationBatches).toEqual([{rows: 2,visited: 2}]);
      expect(read.rawSql).toHaveLength(1);
    }

    // Force this subject's existing local owner to reconstruct from the actual
    // native source after the 320 API writes. Ordinary proposals preserve the
    // membership head, so a warm seek alone would not exercise cold traversal.
    const sourcePopulation = await f.env.fuseki.query(`SELECT (COUNT(?statement) AS ?count) WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?statement <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> ${iri(entity)} }
    }`);
    const sourceCount = Number(sourcePopulation.results?.bindings[0]?.count?.value);
    expect(sourceCount).toBe(324);
    await f.accessPool.query(`DELETE FROM access.statement_publication_seek_coverage
      WHERE data_epoch=$1 AND subject=$2`,[f.env.lineage.dataEpoch,entity]);
    expect((await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false)).status).toBe(503);
    const coldStart = sourcePages.length;
    await completePublication();
    const coldSourcePages = sourcePages.slice(coldStart);
    expect(coldSourcePages.length).toBeGreaterThanOrEqual(3);
    expect(coldSourcePages.at(-1)?.complete).toBe(true);
    expect(coldSourcePages.filter(page => !page.complete).every(page => page.examined === 128)).toBe(true);
    expect(coldSourcePages.reduce((sum,page) => sum+page.examined,0)).toBe(
      sourceCount+coldSourcePages.filter(page => !page.complete).length);
    expect((await countRead()).publicationBatches).toEqual([{rows: 2,visited: 2}]);

    // Every current fact disables this optimization. Null active-policy matches
    // include withdrawn and malformed Global, so neither is an absence proof.
    for (const globalFacts of [
      `a <${RV}ClassificationContext> ; <${RV}contextState> <${RV}Active> ;
        <${RV}inheritancePolicy> ${iri(CLASSIFICATION_ISOLATE_POLICY)}`,
      `a <${RV}ClassificationContext> ; <${RV}contextState> <${RV}Withdrawn>`,
      `<${RV}malformedFixture> true`,
    ]) {
      await f.env.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ${globalFacts} } }`);
      try {
        expect(await f.statementSeek.capturePublicationBasis(entity)).toBeNull();
        expect((await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false)).status).toBe(503);
      } finally {
        await f.env.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ?predicate ?object } }`);
      }
    }
    await f.env.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} <${RV}restoreHold> true } }`);
    try {
      await expect(f.statementSeek.capturePublicationBasis(entity)).rejects.toBeInstanceOf(WorkReadUnavailable);
      expect((await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false)).status).toBe(503);
    } finally {
      await f.env.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} <${RV}restoreHold> ?hold } }`);
    }

    // Replay actual Statement source effects through the existing projector.
    // Force the ordinary raw cursor before these revisions as an isolated SQL
    // fixture; local membership/completed coverage retain their exact basis.
    const revisions = (await f.env.fuseki.query(`SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.current)} { VALUES ?statement { ${iri(statement)} ${iri(laterStatement)} }
        ?statement <${RV}head> ?head }
      GRAPH ${iri(GRAPHS.revisions)} { ?head <${RV}sequence> ?sequence }
    }`)).results?.bindings ?? [];
    expect(revisions).toHaveLength(2);
    const earliest = revisions.reduce((min,row) => {
      const value = BigInt(row.sequence!.value); return value < min ? value : min;
    },BigInt(revisions[0]!.sequence!.value));
    await f.accessPool.query(`UPDATE access.statement_seek_coverage SET through_sequence=$2
      WHERE data_epoch=$1`,[f.env.lineage.dataEpoch,(earliest-1n).toString()]);
    expect(await f.statementSeek.projectOnce()).toBe(true);
    expect((await countRead()).publicationBatches).toEqual([{rows: 2,visited: 2}]);

    // A moved final source position rolls the whole raw rebuild back, including
    // its metadata snapshot/delete/restore. Fault injection changes only the
    // second read result; it does not weaken any production fence.
    const positionQuery = f.env.fuseki.query.bind(f.env.fuseki);
    let positionReads = 0;
    f.env.fuseki.query = async (sparql,maxBytes) => {
      const result = await positionQuery(sparql,maxBytes);
      if (sparql.includes('SELECT ?sequence WHERE') && sparql.includes('rv:dataEpoch')) {
        positionReads++;
        if (positionReads === 2) {
          const sequence = result.results?.bindings[0]?.sequence;
          if (!sequence) throw new Error('Raw rebuild fixture position is missing');
          sequence.value = (BigInt(sequence.value)+1n).toString();
        }
      }
      return result;
    };
    try {
      await expect(f.statementSeek.rebuild()).rejects.toBeInstanceOf(WorkReadUnavailable);
      expect(positionReads).toBe(2);
    } finally { f.env.fuseki.query = positionQuery; }
    expect((await countRead()).publicationBatches).toEqual([{rows: 2,visited: 2}]);

    // Raw projection replay must preserve the independently covered metadata.
    await f.statementSeek.rebuild();
    const replayed = await countRead();
    const replayPhysical = await explainRead(replayed);
    expect(replayed.publicationBatches).toEqual(afterProposals.publicationBatches);
    expect(await f.statementSeek.capturePublicationBasis(entity)).toEqual(beforeMembership);

    // Scale the real Access owner's raw neighborhood and distant partial-index
    // leaves. The 320 source operations above use the native command lifecycle;
    // these additional rows are SQL fixture population, not native source proof.
    const scaleStatements = Array.from({length: 4096},() => nativeId());
    const distantSubject = nativeId();
    await f.accessPool.query(`INSERT INTO access.statement_seek
      (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs,
       statement_head,publication_source,publication_evidence)
      SELECT $1,$2,$3,'urn:rezics:meaning:' || lpad(n::text,64,'0'),id,'*','[]'::jsonb,
        $4,NULL,false FROM unnest($5::text[]) WITH ORDINALITY AS item(id,n)`,
      [f.env.lineage.dataEpoch,entity,predicate.component,nativeId(),scaleStatements]);
    await f.accessPool.query(`INSERT INTO access.statement_seek
      (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs,
       statement_head,publication_source,publication_evidence)
      SELECT $1,$2,$3,'urn:rezics:meaning:' || lpad(n::text,64,'0'),id,'*','[]'::jsonb,
        $4,$5,false FROM unnest($6::text[]) WITH ORDINALITY AS item(id,n)`,
      [f.env.lineage.dataEpoch,distantSubject,predicate.component,nativeId(),createdWork.work,
        Array.from({length: 4096},() => nativeId())]);
    const scaled = await countRead();
    const scalePhysical = await explainRead(scaled);
    expect(scaled.inventories).toBe(1);
    expect(scaled.rawBatches).toHaveLength(0);
    expect(scaled.globalCoverageReads).toBe(0);
    expect(scaled.publicationBatches).toEqual([{rows: 2,visited: 2}]);
    expect(scaled.rawSql).toHaveLength(1);

    // EXPLAIN the exact SQL captured from each actual application request, with
    // natural planner choices. Do not infer physical locality from LIMIT alone.
    async function explainRead(read: Awaited<ReturnType<typeof countRead>>) {
      const rawPlans: unknown[] = [];
      const physical: {executorRows: number;filteredRows: number;recheckedRows: number;buffers: number}[] = [];
      for (const sql of read.rawSql) {
      const result = await f.accessPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${sql.text}`,sql.values);
      rawPlans.push(result.rows[0]!['QUERY PLAN']);
      type Plan = {'Node Type': string;'Index Name'?: string;'Actual Rows': number;'Actual Loops': number;
        'Rows Removed by Filter'?: number;'Rows Removed by Index Recheck'?: number;'Shared Hit Blocks'?: number;
        'Shared Read Blocks'?: number;Plans?: Plan[]};
      const top = result.rows[0]!['QUERY PLAN'][0].Plan as Plan;
      const nodes: Plan[] = [];
      const visit = (node: Plan) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
      visit(top);
      const scan = nodes.find(node => node['Index Name'] === 'statement_publication_subject_seek');
      expect(scan).toBeDefined();
      expect(nodes.some(node => node['Node Type'].includes('Sort'))).toBe(false);
      if (!scan) throw new Error('Application publication seek did not use its partial B-tree');
      const metric = {executorRows: scan['Actual Rows'] * scan['Actual Loops'],
        filteredRows: nodes.reduce((sum,node) => sum+(node['Rows Removed by Filter'] ?? 0)*node['Actual Loops'],0),
        recheckedRows: nodes.reduce((sum,node) => sum+(node['Rows Removed by Index Recheck'] ?? 0)*node['Actual Loops'],0),
        buffers: (top['Shared Hit Blocks'] ?? 0)+(top['Shared Read Blocks'] ?? 0)};
      expect(metric.executorRows).toBe(2);
      expect(metric.filteredRows).toBe(0);
      expect(metric.recheckedRows).toBe(0);
      expect(metric.buffers).toBeLessThanOrEqual(32);
      physical.push(metric);
      }
      return {rawPlans,physical};
    }
    mkdirSync(resolve(root,'.temp/goal'),{recursive: true});
    const locality = { before: { graphCalls: beforeProposals.calls, hydrations: beforeProposals.inventories,
        seekBatches: beforeProposals.rawBatches.length, rawRows: beforeProposals.rawRows, visitedRows: beforeProposals.rawVisited },
      after: { graphCalls: afterProposals.calls, hydrations: afterProposals.inventories,
        seekBatches: afterProposals.rawBatches.length, rawRows: afterProposals.rawRows, visitedRows: afterProposals.rawVisited },
      physical: [beforePhysical,afterPhysical,replayPhysical,scalePhysical],scaled: {graphCalls: scaled.calls,hydrations: scaled.inventories,
        candidateRows: scaled.publicationBatches.reduce((sum,batch) => sum+batch.rows,0),
        responseJsonBytes: scaled.responseJsonBytes,elapsedMs: scaled.elapsedMs},
      nativeSourceProposals: 320,coldNativeSourcePopulation: sourceCount,coldSourcePages,
      additionalRawSqlFixtureRows: 4096,
      baselineDistantPositiveSqlFixtureRows: 4096,additionalDistantPositiveSqlFixtureRows: 4096 };
    // Persist outside the fixture directory, which its finally block removes.
    writeFileSync(resolve(root,'.temp/goal/statement-subject-locality.json'),JSON.stringify(locality,null,2));
    console.log(`subject Statement locality ${JSON.stringify({before: locality.before,after: locality.after})}`);

    // Legacy/delta Statements have citation evidence without a rv:source hint.
    // They remain potential before Content's claim binding arrives. The binding
    // is live authority, so no membership/index update is needed to disclose it.
    const delayedEvidence = nativeId();
    await f.contentPool.query(`INSERT INTO wiki.evidence
      (id,representation_sha256,locator,quote,method,submitter,rights_basis,source_work,
       applied_receipt,modality,claim,claim_kind)
      SELECT $1,representation_sha256,locator,quote,method,submitter,rights_basis,source_work,
        applied_receipt || ':delayed',modality,NULL,NULL FROM wiki.evidence WHERE id=$2`,
      [delayedEvidence,evidenceIds[0]]);
    const legacy = await json<{statement: string;revision: string}>(await call('POST','/v1/statements',{
      profile: 'statement-v1',speaker: {kind: 'personal'},subject: entity,
      predicate: predicate.component,relationDefinition: predicate.revision,
      value: {kind: 'literal',lexical: 'Evidence-only delayed citation',language: 'en',datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'},
      applicability: [],interpretation: {kind: 'selected'},evidence: [delayedEvidence],
      actingSubject: reviewerB.actor,
    },reviewerB.token),201);
    expect((await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false)).status).toBe(503);
    const legacyBasis = await completePublication();
    const legacyRows = (await f.accessPool.query<{publication_source: string | null;publication_evidence: boolean}>(
      `SELECT publication_source,publication_evidence FROM access.statement_seek
       WHERE data_epoch=$1 AND subject=$2 AND statement_id=$3 AND frame_key='*'`,
      [f.env.lineage.dataEpoch,entity,legacy.statement])).rows;
    expect(legacyRows).toEqual([{publication_source: null,publication_evidence: true}]);
    const statementIds = async () => (await json<Static<typeof subjectStatementPage>>(
      await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false),
    )).groups.flatMap(group => group.items).flatMap(item => item.kind === 'statement' ? [item.statement] : []).sort();
    expect(await statementIds()).toEqual([statement,laterStatement].sort());
    // A continuation minted behind the late bind's frontier cannot outlive it.
    const delayedPath = `/v1/resources/${shortId(entity)}/statements?limit=1`;
    const beforeBind = await json<Static<typeof subjectStatementPage>>(await at(delayedPath,'all',false));
    expect(beforeBind.nextCursor).toBeString();
    const beforeBindCursor = `${delayedPath}&cursor=${encodeURIComponent(beforeBind.nextCursor!)}`;
    expect((await at(beforeBindCursor,'all',false)).status).toBe(200);
    await deps.wikiEvidence!.reveal(createdWork.work,[],[
      {evidence: [delayedEvidence],claim: legacy.statement,kind: 'statement'},
    ],[]);
    expect((await at(beforeBindCursor,'all',false)).status).toBe(400);
    expect(await f.statementSeek.capturePublicationBasis(entity)).toEqual(legacyBasis);
    expect(await statementIds()).toEqual([statement,laterStatement,legacy.statement].sort());
    await reviewerB.grant(`statement:speak:${reviewerB.actor}`, 'statement.withdraw');
    await json(await call('POST',`/v1/statements/${shortId(legacy.statement)}/withdrawals`,{
      profile: 'statement-v1',expectedHead: legacy.revision,speaker: {kind: 'personal'},
      actingSubject: reviewerB.actor,
    },reviewerB.token),201);
    expect((await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false)).status).toBe(503);
    await completePublication();
    expect(await statementIds()).toEqual([statement,laterStatement].sort());

    const statementPath = `/v1/resources/${shortId(entity)}/statements?limit=1`;
    const first = await json<Static<typeof subjectStatementPage>>(
      await at(statementPath, occurrence, false),
    );
    expect(first.nextCursor).toBeString();
    expect(
      (
        await at(
          `${statementPath}&cursor=${encodeURIComponent(first.nextCursor!)}`,
          lateOccurrence,
          false,
        )
      ).status,
    ).toBe(400);
    for (const position of [occurrence, lateOccurrence]) {
      const found: string[] = [];
      let cursor: string | null = null;
      for (let count = 0; count < 8; count++) {
        const page = await json<Static<typeof subjectStatementPage>>(
          await at(
            `${statementPath}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
            position,
            false,
          ),
        );
        found.push(
          ...page.groups
            .flatMap((group) => group.items)
            .flatMap((item) => (item.kind === 'statement' ? [item.statement] : [])),
        );
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect(found.sort()).toEqual(
        (position === occurrence ? [statement] : [statement, laterStatement]).sort(),
      );
    }
    // Replacing a relation's citation severs its old publication proof. Neither
    // the page nor the evidence endpoint can disclose the changed occurrence
    // under a citation retained for its earlier state.
    const current = (await readCurrentOccurrence(f.env, earlyRelation))!;
    const meaning = (await readExactDefinition(f.env, current.state.definition, systemDisclosure))!;
    const participations = current.state.participations.map(({ role, participant, position }) => ({
      role: meaning.roleKeys[role]!,
      participant,
      ...(position === undefined ? {} : { position }),
    }));
    await reviewerB.grant(`relation:edit:${earlyRelation}`, 'relation.change');
    const changed = await json<{ revision: string }>(
      await call(
        'POST',
        '/v1/relations/changes',
        {
          profile: 'relation-change-v1',
          occurrence: earlyRelation,
          expectedHead: current.head,
          actingSubject: reviewerB.actor,
          definition: current.state.definition,
          participations,
          applicability: current.state.applicability,
        },
        reviewerB.token,
      ),
    );
    const changedPage = await json<{ items: { relation: string }[] }>(
      await at(`/v1/resources/${shortId(entity)}/relations`, 'all', false),
    );
    expect(changedPage.items.some((item) => item.relation === earlyRelation)).toBe(false);
    expect((await at(`/v1/wiki/evidence/${shortId(evidenceIds[2]!)}`, 'all', false)).status).toBe(
      404,
    );
    await json(
      await call(
        'POST',
        '/v1/relations/changes',
        {
          profile: 'relation-change-v1',
          occurrence: earlyRelation,
          expectedHead: changed.revision,
          actingSubject: reviewerB.actor,
          definition: current.state.definition,
          participations,
          applicability: current.state.applicability,
          evidence: current.state.evidence,
        },
        reviewerB.token,
      ),
    );
    const restored = await json<typeof changedPage>(
      await at(`/v1/resources/${shortId(entity)}/relations`, 'all', false),
    );
    expect(restored.items.some((item) => item.relation === earlyRelation)).toBe(true);
    const active = await json<{ revision: string }>(
      await at(`/v1/statements/${shortId(statement)}`, 'all', false),
    );
    await reviewerB.grant(`statement:speak:${reviewerB.actor}`, 'statement.withdraw');
    await json(
      await call(
        'POST',
        `/v1/statements/${shortId(statement)}/withdrawals`,
        {
          profile: 'statement-v1',
          expectedHead: active.revision,
          speaker: { kind: 'personal' },
          actingSubject: reviewerB.actor,
        },
        reviewerB.token,
      ),
      201,
    );
    const afterWithdrawalBasis = await f.statementSeek.capturePublicationBasis(entity);
    expect(afterWithdrawalBasis?.membershipHead).not.toBe(beforeMembership?.membershipHead);
    expect((await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false)).status).toBe(503);
    await f.statementSeek.rebuild();
    await completePublication();
    const withdrawn = await json<Static<typeof subjectStatementPage>>(
      await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false),
    );
    expect(
      withdrawn.groups
        .flatMap((group) => group.items)
        .flatMap((item) => (item.kind === 'statement' ? [item.statement] : [])),
    ).toEqual([laterStatement]);
    expect((await at(`/v1/wiki/evidence/${evidenceId}`, 'all', false)).status).toBe(404);

    // A replacement public decision has not been selected yet: the old default
    // is no longer a public Work proof. Work grants retain private wiki reads.
    await json(
      await call('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1',
        contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: decision.publicationDecision,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
        actingSubject: holder.actor,
      }),
      201,
    );
    const privateEvidence = `/v1/wiki/evidence/${shortId(evidenceIds[1]!)}`;
    expect((await at(privateEvidence, 'all', false)).status).toBe(404);
    expect(
      (
        await call(
          'GET',
          `${privateEvidence}?position=all&actingSubject=${encodeURIComponent(outsider.actor)}`,
          undefined,
          outsider.token,
        )
      ).status,
    ).toBe(404);
    await holder.grant(`semantic:read:${entity}`, 'semantic.read');
    const granted = await json<{ sourceWork: string; claim: string }>(
      await at(privateEvidence, 'all', true),
    );
    expect(granted.sourceWork).toBe(createdWork.work);
    expect(granted.claim).toBe(laterStatement);
    expect((await at(privateEvidence, 'start', true)).status).toBe(404);
  } finally {
    await f.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
