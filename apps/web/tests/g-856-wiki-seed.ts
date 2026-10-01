// Query 7: reuse the franchise wiki seed, then publish contradictory claims
// through the same catalogue fixture helper the API acceptance journey uses.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import {
  activateMetadataWork,
  metadataWorkRequestDigest,
} from '../../../services/main/src/modules/work/activate.ts';
import {
  mainSelectionDigest,
  selectMainDefault,
} from '../../../services/main/src/modules/work/select-main.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import {
  cataloguePositions,
  publishCatalogueFact,
} from '../../../tests/fixtures/catalogue/acceptance.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { seedWiki } from './g-849-records.ts';

if (!process.env.REZICS_QA_RUN_ID || !process.env.REZICS_WEB_AUTH_PRIVATE_PATH)
  throw new Error('Use the browser QA stack');
const reader = JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH, 'utf8')) as {
  principalId: string;
  actingSubject: string;
};
const f = await startMediaStack('g856-q7', { agents: true, rights: true, library: true });
const workObjects = f.objects('semantic/work/');
await workObjects.initialize();
Object.assign(f.env, { objectDirectory: process.env.MAIN_OBJECT_DIRECTORY, workObjects });
try {
  const seed = await seedWiki(f, reader);
  const holderPrincipal = seed.tokens.get(seed.holderToken)!;
  const holderId = (
    await f.accessPool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_issuer=$1 AND account_subject=$2',
      [holderPrincipal.issuer, holderPrincipal.subject],
    )
  ).rows[0]!.id;
  const steward = await f.member('g856-q7-steward');
  seed.tokens.set(steward.token, steward.principal);
  const objects = f.objects('semantic/structure/');
  await objects.initialize();
  const deps: MainWorkDependencies = {
    environment: f.env,
    access: f.access,
    account: {
      verify: async (request) => {
        const principal = seed.tokens.get(
          request.headers.get('authorization')?.replace('Bearer ', '') ?? '',
        );
        if (!principal) throw new Error('QA bearer missing');
        return principal;
      },
    },
    structureObjects: objects,
    editorialReview: new EditorialReviewStore(f.accessPool),
    readingPositions: new ReadingPositionStore(f.contentPool),
    wikiEvidence: new WikiEvidenceStore(f.contentPool),
    wikiQuotations: new WikiQuotationStore(f.contentPool),
    rights: { store: new RightsStore(f.contentPool, f.accessPool) },
    media: f.media,
    mediaAccess: f.mediaAccess,
  };
  const app = createMainApp(f.fuseki, deps);
  const grant = async (principalId: string, actor: string, scope: string, action: string) => {
    await f.accessPool.query(
      'INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [scope],
    );
    await f.accessPool.query(
      `INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,'infinity')`,
      [randomUUID(), principalId, actor, action],
    );
    await f.accessPool.query(
      `INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,'infinity')`,
      [randomUUID(), actor, scope, action],
    );
  };
  const port = (token: string, actor: string, principalId: string) => ({
    actingSubject: actor,
    grant: (scope: string, action: string) => grant(principalId, actor, scope, action),
    request: async (method: string, path: string, body?: unknown, key = randomUUID()) => {
      // Resolve retryable HTTP outcomes with the same bounded command intent.
      for (let attempt = 0; attempt < 40; attempt++) {
        const response = await app.handle(
          new Request(`http://main.local${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              'idempotency-key': key,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
        const text = await response.text();
        const result = {
          status: response.status,
          body: text ? (JSON.parse(text) as unknown) : null,
        };
        if (![202, 503].includes(response.status) || attempt === 39) return result;
        await new Promise((done) => setTimeout(done, 300));
      }
      throw new Error('Fixture command did not resolve');
    },
  });
  const holder = port(seed.holderToken, seed.holderActor, holderId),
    reviewer = port(steward.token, steward.actor, steward.principalId);
  for (const action of ['work.read', 'work.edit', 'work.review'])
    await reviewer.grant(`work:${action.slice(5)}:${seed.work}`, action);
  await reviewer.grant(`agent:self:${steward.actor}`, 'agent.control');
  await reviewer.grant('semantic:create:root', 'semantic.change');
  await reviewer.grant(`statement:speak:${steward.actor}`, 'statement.record');
  const indexResponse = await seed.read(
    `/v1/zones/${seed.zone.slice(-36)}/routes?path=%2Fchapters&position=all`,
  );
  const index = (await indexResponse.json()) as { mount: { target: string } };
  await reviewer.grant(`collection:edit:${index.mount.target}`, 'collection.edit');
  const changed = await holder.request('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1',
    expectedHead: null,
    actingSubject: seed.holderActor,
    state: { component: 'definition', kind: 'property' },
  });
  if (changed.status !== 201) throw new Error(`Predicate: ${JSON.stringify(changed)}`);
  const predicate = (changed.body as { component: string }).component;
  for (const p of [holder, reviewer])
    for (const id of [predicate, seed.entities.elizabeth!])
      await p.grant(`semantic:read:${id}`, 'semantic.read');
  const facts: { statement: string; text: string; continuity: string; position: string }[] = [];
  for (const [text, occurrences] of [
    ['Synthetic claim: she lives in Longbourn', seed.chapters.slice(0, 1)],
    ['Synthetic contrary claim: she does not live in Longbourn', seed.chapters],
  ] as const) {
    const statement = await publishCatalogueFact(holder, reviewer, {
      work: seed.work,
      zone: seed.zone,
      subject: seed.entities.elizabeth!,
      predicate,
      text,
      occurrences,
    });
    facts.push({ statement, text, continuity: seed.work, position: occurrences.at(-1)! });
  }
  const namedWork = async (
    language: string,
    title: string,
    semanticTypes: readonly string[] = [],
  ) => {
    const created = await activateMetadataWork(f.env, {
      title,
      language,
      semanticTypes,
      admission: f.admission(
        seed.holderActor,
        'work:create:root',
        'work.create',
        metadataWorkRequestDigest(title, semanticTypes, language),
      ),
    });
    const contribution = await f.contribution(
      created.work,
      seed.holderActor,
      language,
      'Synthetic language fixture',
    );
    const selection = {
      context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work,
      contribution: contribution.contribution,
      publicationDecision: contribution.decision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const,
      actingSubject: seed.holderActor,
    };
    const selected = await selectMainDefault(
      f.env,
      f.admission(
        seed.holderActor,
        `publication:select:${created.mainVersion}`,
        'publication.select',
        mainSelectionDigest(selection),
      ),
      selection,
    );
    if (selected.outcome !== 'succeeded') throw new Error('Language fixture selection failed');
    return { work: created.work, mainVersion: created.mainVersion };
  };
  const alternate = await namedWork('en', 'Synthetic alternate continuity', [
    'https://schema.org/Book',
  ]);
  for (const p of [holder, reviewer])
    for (const action of ['work.read', 'work.edit', 'work.review']) {
      await p.grant(`work:${action.slice(5)}:${alternate.work}`, action);
    }
  const franchiseRoute = await seed.read(
    `/v1/zones/${seed.zone.slice(-36)}/routes?path=%2Ffranchise&position=all`,
  );
  const franchise = ((await franchiseRoute.json()) as { mount: { target: string } }).mount.target;
  const members = await catalogueRequest<{ structure: string; revision: string }>(
    holder,
    'GET',
    `/v1/collections/${franchise.slice(-36)}?actingSubject=${encodeURIComponent(seed.holderActor)}&position=all`,
  );
  await catalogueRequest(holder, 'POST', `/v1/collections/${franchise.slice(-36)}/changes`, {
    expectedHead: members.revision,
    actingSubject: seed.holderActor,
    operations: [
      {
        op: 'insert',
        parent: members.structure,
        role: 'member',
        position: 'last',
        target: alternate.work,
      },
    ],
  });
  const alternateChapters = await cataloguePositions(holder, alternate.work, alternate.mainVersion);
  const alternateText = 'Synthetic alternate claim: she never lives in Longbourn';
  const alternateStatement = await publishCatalogueFact(holder, reviewer, {
    work: alternate.work,
    zone: seed.zone,
    subject: seed.entities.elizabeth!,
    predicate,
    text: alternateText,
    occurrences: alternateChapters.occurrences,
  });
  facts.push({
    statement: alternateStatement,
    text: alternateText,
    continuity: alternate.work,
    position: alternateChapters.occurrences.at(-1)!,
  });
  // The browser hard case reuses the exact composition owner and 16-entry
  // command bound of G-847. No imported chapter is discarded at a UI window.
  const current = await holder.request(
    'GET',
    `/v1/compositions/${seed.structure.slice(-36)}?actingSubject=${encodeURIComponent(seed.holderActor)}`,
  );
  let head = (current.body as { revision: string }).revision;
  for (let offset = 3; offset < 1000; offset += 16) {
    const changed = await holder.request(
      'POST',
      `/v1/compositions/${seed.structure.slice(-36)}/changes`,
      {
        profile: 'book-composition',
        expectedHead: head,
        actingSubject: seed.holderActor,
        operations: Array.from({ length: Math.min(16, 1000 - offset) }, (_, index) => ({
          op: 'insert',
          role: 'chapter',
          parent: seed.structure,
          position: 'last',
          target: 'https://schema.org/DigitalDocument',
          label: { value: `Chapter ${offset + index + 1}`, language: 'en' },
        })),
      },
    );
    if (changed.status !== 200) throw new Error(`Inventory: ${JSON.stringify(changed)}`);
    head = (changed.body as { revision: string }).revision;
  }
  const thai = await namedWork('th', 'เจ้าหญิงแห่งดวงจันทร์');
  const arabic = await namedWork('ar', 'اسم عربي للاختبار');
  const {
    read: _read,
    tokens: _tokens,
    holderToken: _token,
    holderActor: _actor,
    ...manifest
  } = seed;
  console.log(JSON.stringify({ ...manifest, facts, alternate, thai, arabic }));
} finally {
  await f.stop();
}
