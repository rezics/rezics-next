import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { prideExample } from '../../../packages/wiki-toolkit/skill/examples/pride.ts';
import { submitWikiBundle } from '../../../packages/wiki-toolkit/src/submit.ts';
import { startMediaStack } from './media-support.ts';

test('G-848: model-free skill units, alignment, candidates and validation produce an acceptable bundle on the local QA stack', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-848-${randomUUID()}`);
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid work:create work:edit work:read space:create zone:edit collection:edit semantic:read wiki:propose',
  );
  const objects = new S3ImmutableObjects({
    endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/',
  });
  await objects.initialize();
  const app = createMainApp(f.env.fuseki, {
    environment: f.env,
    account: f.account.verifier,
    access: f.access,
    structureObjects: objects,
    wikiQuotations: new WikiQuotationStore(f.pool),
    catalogueIntake: new CatalogueIntakeStore(f.accessPool, f.env),
  });
  const call = (path: string, body: object) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.account.tokenA}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(body),
      }),
    );
  async function json<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    if (response.status !== status)
      throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }
  try {
    const { candidateReceipt } = await json<{ candidateReceipt: string }>(
      await call('/v1/catalogue/candidates', {
        profile: 'catalogue-candidates-v1',
        originalTitle: { value: 'Pride and Prejudice', language: 'en' },
        aliases: [],
        romanizations: [],
        creators: [],
        dates: [],
        identifiers: [],
      }),
    );
    const work = await json<{ work: string; mainVersion: string }>(
      await call('/v1/works', {
        profile: 'metadata-only-v1',
        grain: 'new-creative-scope',
        candidateReceipt,
        title: 'Pride and Prejudice',
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    const structure = await json<{ structure: string; revision: string }>(
      await call('/v1/compositions', {
        profile: 'book-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: f.actor,
      }),
      201,
    );
    const chapter = await json<{ occurrences: string[] }>(
      await call(`/v1/compositions/${shortId(structure.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: structure.revision,
        actingSubject: f.actor,
        operations: [
          {
            op: 'insert',
            parent: structure.structure,
            position: 'last',
            role: 'chapter',
            target: 'https://schema.org/DigitalDocument',
            label: { value: 'Chapter one', language: 'en' },
          },
        ],
      }),
    );
    await f.grant('semantic:create:root', 'semantic.change');
    const predicate = await json<{ component: string }>(
      await call('/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: f.actor,
        state: { component: 'definition', kind: 'property' },
      }),
      201,
    );
    await f.grant(`semantic:read:${predicate.component}`, 'semantic.read');
    const franchise = nativeId();
    await f.grant(`collection:edit:${franchise}`, 'collection.edit');
    await f.grant(`semantic:read:${franchise}`, 'semantic.read');
    const collection = await json<{ structure: string; revision: string }>(
      await call('/v1/collections', {
        collection: franchise,
        name: 'Pride and Prejudice franchise',
        language: 'en',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    await json(
      await call(`/v1/collections/${shortId(franchise)}/changes`, {
        expectedHead: collection.revision,
        actingSubject: f.actor,
        operations: [
          {
            op: 'insert',
            role: 'member',
            parent: collection.structure,
            position: 'last',
            target: work.work,
          },
        ],
      }),
    );
    await f.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(
      await call('/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'Pride wiki',
        capabilities: ['realm'],
        actingSubject: f.actor,
      }),
      201,
    );
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    const navigation = await json<{ revision: string }>(
      await call('/v1/zones', {
        zone,
        space: space.space,
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    await json(
      await call(`/v1/zones/${shortId(zone)}/mounts`, {
        expectedHead: navigation.revision,
        target: franchise,
        routeSegment: 'franchise',
        position: 'last',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
    );
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
      target: work.work,
      zone,
      continuity: work.work,
      occurrence: chapter.occurrences[0]!,
      predicate: predicate.component,
    });
    const candidates = await json<{ items: { status: string }[] }>(
      await call('/v1/wiki/candidates', {
        target: work.work,
        zone,
        actingSubject: f.actor,
        names: [
          { value: 'Mr. Bennet', language: 'en', type: 'https://rezics.com/vocab/Character' },
        ],
      }),
    );
    expect(candidates.items[0]!.status).toBe('new');
    const evidence = bundle.claims[0]!.evidence[0]!;
    const verified = JSON.parse(
      execFileSync(
        'bun',
        [
          resolve(root, 'packages/wiki-toolkit/src/cli.ts'),
          'verify',
          file,
          JSON.stringify(evidence.locator),
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(verified.quote).toBe(evidence.quote);
    expect(
      await json(await call('/v1/wiki/validations', { actingSubject: f.actor, bundle })),
    ).toMatchObject({
      status: 'acceptable',
      entities: [{ id: 'mr-bennet', action: 'create' }],
      alignment: [{ status: 'aligned' }],
    });
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test('G-848: submit a wiki-bundle, two independent reviewers approve it, and published entities, claims and revelation positions read back', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-907-${randomUUID()}`);
  const f = await startMediaStack('g-907');
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
        const principal = tokens.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
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
  const call = (method: string, path: string, body?: object, token: string | null = holder.token, key = randomUUID()) =>
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
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
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
        ],
      }),
    );
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
    const lines = execFileSync('bun', [resolve(root, 'packages/wiki-toolkit/src/cli.ts'), 'units', file], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
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
    const candidates = await json<{ items: { status: string }[] }>(
      await call('POST', '/v1/wiki/candidates', {
        target: createdWork.work,
        zone,
        actingSubject: holder.actor,
        names: [{ value: 'Mr. Bennet', language: 'en', type: 'https://rezics.com/vocab/Character' }],
      }),
    );
    expect(candidates.items[0]!.status).toBe('new');
    const quote = bundle.claims[0]!.evidence[0]!;
    const verified = JSON.parse(
      execFileSync(
        'bun',
        [resolve(root, 'packages/wiki-toolkit/src/cli.ts'), 'verify', file, JSON.stringify(quote.locator)],
        { encoding: 'utf8' },
      ),
    );
    expect(verified.quote).toBe(quote.quote);
    expect(await json(await call('POST', '/v1/wiki/validations', { actingSubject: holder.actor, bundle }))).toMatchObject({
      status: 'acceptable',
      entities: [{ id: 'mr-bennet', action: 'create' }],
      alignment: [{ status: 'aligned' }],
    });
    const header = await json<{ revision: string; disclosure: string }>(
      await call('GET', `/v1/works/${shortId(createdWork.work)}?actingSubject=${encodeURIComponent(holder.actor)}`),
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
        target: { resource: createdWork.work, revision: header.revision, context: 'urn:rezics:context:global' },
        bundle,
        baseHeads: [{ component: createdWork.work, head: header.revision }],
        evidence: [],
        actingSubject: holder.actor,
      },
      `Bearer ${holder.token}`,
      randomUUID(),
    );
    if (submitted.status !== 201) throw new Error(`Expected 201, got ${submitted.status}: ${JSON.stringify(submitted.body)}`);
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
    let receipt: {
      commands?: { key: string; outcome: string; result: { component?: string } }[];
      owner: { evidence?: string[] };
    } | undefined;
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
      if (response.status !== 200 && response.status !== 202) throw new Error(`${response.status}: ${text}`);
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
    expect(evidenceIds).toHaveLength(1);
    const evidenceId = shortId(evidenceIds[0]!);
    const hiddenPage = await call('GET', `/v1/resources/${shortId(entity)}/page?position=start`, undefined, null);
    expect(hiddenPage.status).toBe(404);
    await hiddenPage.text();
    for (const position of [occurrence, 'all']) {
      const page = await textOf(
        await call('GET', `/v1/resources/${shortId(entity)}/page?position=${encodeURIComponent(position)}`, undefined, null),
        200,
      );
      expect(page).toContain(entity);
      expect(page).toContain('Mr. Bennet');
    }
    const hiddenEvidence = await call('GET', `/v1/wiki/evidence/${evidenceId}?position=start`, undefined, null);
    expect(hiddenEvidence.status).toBe(404);
    await hiddenEvidence.text();
    for (const position of [occurrence, 'all']) {
      expect(
        await json(
          await call('GET', `/v1/wiki/evidence/${evidenceId}?position=${encodeURIComponent(position)}`, undefined, null),
        ),
      ).toMatchObject({
        profile: 'wiki-evidence-v1',
        quote: 'My dear Mr. Bennet',
        claim: statement,
        claimKind: 'statement',
        quoteWithheld: false,
      });
    }
    const hiddenStatement = await call('GET', `/v1/statements/${shortId(statement)}?position=start`, undefined, null);
    expect(hiddenStatement.status).toBe(404);
    await hiddenStatement.text();
    for (const position of [occurrence, 'all']) {
      expect(
        await json(
          await call('GET', `/v1/statements/${shortId(statement)}?position=${encodeURIComponent(position)}`, undefined, null),
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
      await call('GET', `/v1/reading-positions/${shortId(createdWork.work)}?position=all`, undefined, null),
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
  } finally {
    await f.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test.skip('G-848: later-chapter deltas — G-693', () => {});
