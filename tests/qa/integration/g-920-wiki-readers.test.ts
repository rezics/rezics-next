import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { nativeId, shortId } from '../fixtures/author-credit.ts';
import { prideExample } from '../../../packages/wiki-toolkit/skill/examples/pride.ts';
import { submitWikiBundle } from '../../../packages/wiki-toolkit/src/submit.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';
import { type ResourceSummary } from '../../../services/main/src/modules/media/summary.ts';
import { type Static } from 'typebox';
import { subjectStatementPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import { readCurrentOccurrence, readExactDefinition } from '../../../services/main/src/modules/relation/change.ts';
import { startMediaStack } from './media-support.ts';

test('G-920: published franchise entities, contradictory claims and relations disclose evidence and names at the reader position', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-920-${randomUUID()}`);
  const f = await startMediaStack('g-920');
  const holder = await f.member('holder');
  const reviewerA = await f.member('reviewer-a');
  const reviewerB = await f.member('reviewer-b');
  const tokens = new Map<string, { issuer: string; subject: string }>([
    [holder.token, holder.principal],
    [reviewerA.token, reviewerA.principal],
    [reviewerB.token, reviewerB.principal],
  ]);
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
    structureObjects: objects,
    wikiEvidence: new WikiEvidenceStore(f.contentPool),
    wikiQuotations: new WikiQuotationStore(f.contentPool),
    media: f.media,
    mediaAccess: f.mediaAccess,
    readingPositions: new ReadingPositionStore(f.contentPool),
    editorialReview: new EditorialReviewStore(f.accessPool),
    rights: { store: new RightsStore(f.contentPool, f.accessPool) },
    catalogueIntake: new CatalogueIntakeStore(f.accessPool, f.env),
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
    for (const person of [holder, reviewerA, reviewerB]) {
      await person.grant(`agent:self:${person.actor}`, 'agent.control');
    }
    await holder.grant('work:create:root', 'work.create');
    const { candidateReceipt } = await json<{ candidateReceipt: string }>(
      await call('POST', '/v1/catalogue/candidates', {
        profile: 'catalogue-candidates-v1',
        originalTitle: { value: 'Pride and Prejudice', language: 'en' },
        aliases: [],
        romanizations: [],
        creators: [],
        dates: [],
        identifiers: [],
      }),
    );
    const createdWork = await json<{ work: string; mainVersion: string }>(
      await call('POST', '/v1/works', {
        profile: 'metadata-only-v1',
        grain: 'new-creative-scope',
        candidateReceipt,
        title: 'Pride and Prejudice',
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: holder.actor,
      }),
      201,
    );
    await holder.grant(`work:read:${createdWork.work}`, 'work.read');
    await holder.grant(`work:edit:${createdWork.work}`, 'work.edit');
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
    const predicate = await json<{ component: string }>(
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
    const meaning = (await readExactDefinition(f.env, current.state.definition))!;
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
    const withdrawn = await json<Static<typeof subjectStatementPage>>(
      await at(`/v1/resources/${shortId(entity)}/statements`, 'all', false),
    );
    expect(
      withdrawn.groups
        .flatMap((group) => group.items)
        .flatMap((item) => (item.kind === 'statement' ? [item.statement] : [])),
    ).toEqual([laterStatement]);
    expect((await at(`/v1/wiki/evidence/${evidenceId}`, 'all', false)).status).toBe(404);
  } finally {
    await f.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
