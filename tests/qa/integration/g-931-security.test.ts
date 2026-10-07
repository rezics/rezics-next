import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import {
  activateMetadataWork,
  metadataWorkRequestDigest,
  GRAPHS,
  RV,
} from '../../../services/main/src/modules/work/activate.ts';
import {
  selectMainDefault,
  mainSelectionDigest,
} from '../../../services/main/src/modules/work/select-main.ts';
import { LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { ReaderLibraryImportStore } from '../../../services/main/src/modules/library-import/reader-import.ts';
import { PostgresRateLimitStore } from '../../../services/main/src/modules/rate-limit/store.ts';
import {
  principalClasses,
  rateLimitBudgets,
} from '../../../services/main/src/modules/rate-limit/budgets.ts';
import { nativeId, shortId } from '../fixtures/author-credit.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { startMediaStack } from './media-support.ts';
import { startHomeStack } from './feed-read-support.ts';

async function checked<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

/** Real reviewed publication, graph owners and disclosure store. Account only
 * maps fixture bearers to principals; no age evidence is supplied. */
async function publishedWiki() {
  const f = await startMediaStack('g-931-wiki', { profileCredits: true });
  try {
    const holder = await f.member('holder'),
      steward = await f.member('steward'),
      reader = await f.member('reader');
    const people = [holder, steward, reader];
    for (const person of people) await person.grant(`agent:self:${person.actor}`, 'agent.control');
    const tokens = new Map(people.map((person) => [person.token, person.principal]));
    const objects = f.objects('semantic/structure/');
    await objects.initialize();
    const governance = new GovernanceStore(
      f.accessPool,
      {
        capture: async () => {
          throw new Error('Evidence capture is unused');
        },
      },
      { current: async () => null },
      { current: async () => null },
    );
    const deps: MainWorkDependencies = {
      environment: f.env,
      access: f.access,
      account: {
        verify: async (request) => {
          const principal = tokens.get(
            request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
          );
          if (!principal) throw new Error('Unknown QA bearer');
          return principal;
        },
      },
      platformAccess: new AccessExposure(f.accessPool),
      structureObjects: objects,
      editorialReview: new EditorialReviewStore(f.accessPool),
      wikiEvidence: new WikiEvidenceStore(f.contentPool),
      wikiQuotations: new WikiQuotationStore(f.contentPool),
      readingPositions: new ReadingPositionStore(f.contentPool),
      agentProvisioning: new AgentProvisioning(f.accessPool, f.env),
      rights: { store: new RightsStore(f.contentPool, f.accessPool) },
      suitability: new SuitabilityStore(f.accessPool, f.access),
      governance: { store: governance },
    };
    const app = createMainApp(f.fuseki, deps);
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
            ...(body ? { 'content-type': 'application/json' } : {}),
            'idempotency-key': key,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const title = 'G931 reviewed wiki',
      types = ['https://schema.org/Book'];
    const work = await activateMetadataWork(f.env, {
      title,
      language: 'en',
      semanticTypes: types,
      admission: f.admission(
        holder.actor,
        'work:create:root',
        'work.create',
        metadataWorkRequestDigest(title, types, 'en'),
      ),
    });
    const publication = await f.contribution(
      work.work,
      holder.actor,
      'en',
      'G931 wiki source chapters',
    );
    const selected = {
      context: { kind: 'main-version-default' as const, id: work.mainVersion },
      work: work.work,
      contribution: publication.contribution,
      publicationDecision: publication.decision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const,
      actingSubject: holder.actor,
    };
    await selectMainDefault(
      f.env,
      f.admission(
        holder.actor,
        `publication:select:${work.mainVersion}`,
        'publication.select',
        mainSelectionDigest(selected),
      ),
      selected,
    );
    for (const person of [holder, steward]) {
      await person.grant(`work:read:${work.work}`, 'work.read');
      await person.grant(`work:edit:${work.work}`, 'work.edit');
    }
    await reader.grant(`work:read:${work.work}`, 'work.read');
    await steward.grant(`work:review:${work.work}`, 'work.review');
    const composition = await checked<{ structure: string; revision: string }>(
      await call('POST', '/v1/compositions', {
        profile: 'book-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: holder.actor,
      }),
      201,
    );
    const chapters = await checked<{ occurrences: string[] }>(
      await call('POST', `/v1/compositions/${shortId(composition.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: composition.revision,
        actingSubject: holder.actor,
        operations: [1, 2].map((n) => ({
          op: 'insert',
          parent: composition.structure,
          role: 'chapter',
          position: 'last',
          target: 'https://schema.org/DigitalDocument',
          label: { value: `Chapter ${n}`, language: 'en' },
        })),
      }),
    );
    await holder.grant('semantic:create:root', 'semantic.change');
    await steward.grant('semantic:create:root', 'semantic.change');
    await steward.grant(`statement:speak:${steward.actor}`, 'statement.record');
    const property = await checked<{ component: string }>(
      await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: holder.actor,
        state: { component: 'definition', kind: 'property' },
      }),
      201,
    );
    await holder.grant(`semantic:read:${property.component}`, 'semantic.read');
    const collections: Record<string, string> = {};
    for (const segment of ['franchise', 'characters', 'chapters']) {
      const collection = nativeId();
      await holder.grant(`collection:edit:${collection}`, 'collection.edit');
      await steward.grant(`collection:edit:${collection}`, 'collection.edit');
      await holder.grant(`semantic:read:${collection}`, 'semantic.read');
      const made = await checked<{ structure: string; revision: string }>(
        await call('POST', '/v1/collections', {
          collection,
          name: segment,
          language: 'en',
          disclosure: 'public',
          actingSubject: holder.actor,
        }),
        201,
      );
      if (segment === 'franchise')
        await checked(
          await call('POST', `/v1/collections/${shortId(collection)}/changes`, {
            expectedHead: made.revision,
            actingSubject: holder.actor,
            operations: [
              {
                op: 'insert',
                parent: made.structure,
                position: 'last',
                role: 'member',
                target: work.work,
              },
            ],
          }),
        );
      collections[segment] = collection;
    }
    await holder.grant('space:create:root', 'space.create');
    const space = await checked<{ space: string }>(
      await call('POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'G931 wiki',
        capabilities: ['realm'],
        actingSubject: holder.actor,
      }),
      201,
    );
    const zone = nativeId();
    await holder.grant(`zone:edit:${zone}`, 'zone.edit');
    await holder.grant(`semantic:read:${zone}`, 'semantic.read');
    let navigation = await checked<{ revision: string }>(
      await call('POST', '/v1/zones', {
        zone,
        space: space.space,
        disclosure: 'public',
        actingSubject: holder.actor,
      }),
      201,
    );
    for (const [routeSegment, target] of Object.entries(collections))
      navigation = await checked(
        await call('POST', `/v1/zones/${shortId(zone)}/mounts`, {
          expectedHead: navigation.revision,
          target,
          routeSegment,
          position: 'last',
          disclosure: 'public',
          actingSubject: holder.actor,
        }),
      );
    const quote = 'The masked traveller arrived.';
    const bundle: WikiExtraction = {
      profile: 'wiki-extraction-v1',
      target: work.work,
      continuity: work.work,
      zone,
      source: {
        representationSha256: '9'.repeat(64),
        mediaType: 'text/plain',
        language: 'en',
        rightsBasis: 'public_domain',
        method: { agent: 'G931 holder', model: 'local', inference: 'local' },
      },
      units: chapters.occurrences.map((occurrence, index) => ({
        id: `ch${index + 1}`,
        ordinal: index,
        label: `Chapter ${index + 1}`,
        occurrence,
      })),
      entities: [
        {
          id: 'traveller',
          type: `${RV}Character`,
          names: [
            { value: 'Masked traveller', language: 'en', kind: 'primary', revealedAt: 'ch1' },
            { value: 'Secret royal heir', language: 'en', kind: 'alias', revealedAt: 'ch2' },
          ],
        },
        {
          id: 'later-traveller',
          type: `${RV}Character`,
          names: [{ value: 'Masked traveller', language: 'en', kind: 'primary', revealedAt: 'ch2' }],
        },
      ],
      claims: [
        {
          subject: 'traveller',
          predicate: property.component,
          object: { kind: 'literal', value: 'Royal identity' },
          modality: 'narrated',
          continuity: work.work,
          revealedAt: 'ch2',
          evidence: [
            {
              quote,
              locator: {
                version: 'rezics-locator-v1',
                source: {
                  type: 'external',
                  representationSha256: '9'.repeat(64),
                  mediaType: 'text/plain',
                },
                selector: { type: 'TextQuoteSelector', exact: quote },
              },
            },
          ],
        },
      ],
    };
    const head = (
      await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH <${GRAPHS.current}> {
      <${work.work}> rv:head ?head } }`)
    ).results!.bindings[0]!.head!.value;
    const proposal = await checked<{ proposal: string }>(
      await call('POST', '/v1/editorial/proposals', {
        profile: 'editorial-proposal-create-v1',
        kind: 'wiki-bundle',
        target: { resource: work.work, revision: head, context: 'urn:rezics:context:global' },
        candidate: bundle,
        baseHeads: [{ component: work.work, head }],
        evidence: [],
        actingSubject: holder.actor,
      }),
      201,
    );
    const key = randomUUID();
    let receipt: OwnerReceipt | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const response = await call(
        'POST',
        `/v1/editorial/proposals/${proposal.proposal}/decisions`,
        {
          profile: 'editorial-proposal-decide-v1',
          revision: 1,
          outcome: 'applied',
          approve: true,
          message: 'Checked source and chapter positions',
          actingSubject: steward.actor,
        },
        steward.token,
        key,
      );
      const result = await checked<{ receipt?: OwnerReceipt }>(
        response,
        response.status === 202 ? 202 : 200,
      );
      if (result.receipt) {
        receipt = result.receipt;
        break;
      }
    }
    if (!receipt || receipt.commands?.some((command) => command.outcome !== 'applied'))
      throw new Error('Wiki publication did not finish');
    const entity = (
      receipt.commands!.find((command) => command.key.endsWith(':entity:traveller'))!.result as {
        component: string;
      }
    ).component;
    const laterEntity = (
      receipt.commands!.find((command) => command.key.endsWith(':entity:later-traveller'))!.result as {
        component: string;
      }
    ).component;
    return { f, deps, holder, reader, call, work, zone, entity, laterEntity, chapters, composition };
  } catch (error) {
    await f.stop();
    throw error;
  }
}

// Owner: library file import (G-854), principal budgets (G-543).
test('G931-M1: library files consume the principal upload budget before parsing or retention', async () => {
  const home = await startHomeStack('g-931-upload');
  let limits: PostgresRateLimitStore | undefined;
  try {
    const agent = await home.provision('G922 importing reader', home.reader.token);
    const options = {
      secret: 'g922-upload-budget-secret-at-least-32-characters',
      serviceClientIds: new Set<string>(),
      trustedProxyPeers: new Set<string>(),
      clientIpHeader: 'x-rezics-client-ip',
    };
    limits = new PostgresRateLimitStore(home.stack.accessPool, options);
    const app = createMainApp(home.stack.fuseki, {
      ...home.deps,
      libraryFiles: new LibraryFileStore(home.stack.contentPool),
      libraryImport: new ReaderLibraryImportStore(home.stack.contentPool),
      rateLimit: {
        options,
        store: limits,
        budgets: rateLimitBudgets(
          JSON.stringify(
            Object.fromEntries(
              principalClasses.map((name) => [
                name,
                { upload: { maximum: 1, seconds: 86400 }, write: { maximum: 10, seconds: 60 } },
              ]),
            ),
          ),
        ),
      },
    });
    const upload = (title: string) =>
      app.handle(
        new Request('http://main.local/v1/me/library-imports', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${home.reader.token}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({
            actingSubject: agent,
            format: 'generic-csv',
            file: `Title\n${title}`,
            mapping: { title: 'Title', statuses: {} },
          }),
        }),
      );
    await checked(await upload('First private source'), 201);
    const response = await upload('Second private source');
    const body = (await response.json()) as { family?: string };
    const retained = (
      await home.stack.contentPool.query(
        'SELECT id FROM reader.library_import_file WHERE agent=$1',
        [agent],
      )
    ).rows;
    expect({ status: response.status, family: body.family, retained: retained.length }).toEqual({
      status: 429,
      family: 'upload',
      retained: 1,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    // Invalid CSV would fail parsing if the exhausted upload were admitted.
    const invalid = await upload('"unterminated');
    expect(invalid.status).toBe(429);
    expect(await invalid.json()).toMatchObject({ family: 'upload' });
    expect((await home.stack.contentPool.query(
      'SELECT id FROM reader.library_import_file WHERE agent=$1', [agent],
    )).rows).toHaveLength(1);
  } finally {
    await limits?.stopExpirySweep();
    await home.stop();
  }
}, 180_000);

// Owner: wiki candidate lookup (G-898), reading-position boundary (G-920).
test('G931-M2: wiki candidate matching cannot identify a later alias at the reader default position', async () => {
  const wiki = await publishedWiki();
  try {
    await grantRecordedPlatformUse(wiki.f.accessPool, wiki.reader.principalId, ['wiki-agents']);
    const { call, work, zone, reader, entity } = wiki;
    expect(
      (
        await call(
          'GET',
          `/v1/resources/${shortId(entity)}/page?actingSubject=${encodeURIComponent(reader.actor)}`,
          undefined,
          reader.token,
        )
      ).status,
    ).toBe(404);
    const result = await checked<{ items: { status: string; candidates: string[] }[] }>(
      await call(
        'POST',
        '/v1/wiki/candidates',
        {
          target: work.work,
          zone,
          actingSubject: reader.actor,
          names: [
            { value: 'Secret royal heir', language: 'en' },
            { value: 'Unknown candidate', language: 'en' },
          ],
        },
        reader.token,
      ),
    );
    expect(
      result.items[0]?.status,
      'Hidden aliases must not alter status, identities or ambiguity',
    ).toBe(result.items[1]?.status);
    expect(result.items[0]?.candidates).toEqual(result.items[1]?.candidates);

    // A verified owner advances and rewinds through the same default-position
    // operation; an early entity must not make its later alias match early.
    const verified = { ...reader.principal, emailVerified: true as const };
    const verify = wiki.deps.account.verify.bind(wiki.deps.account);
    wiki.deps.account.verify = async (request, scopes) => {
      const principal = await verify(request, scopes);
      return principal.subject === reader.principal.subject
        ? { ...verified, currentAssertion: async () => verified } : principal;
    };
    const person = await checked<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'G931 progressing reader',
    }, reader.token), 201);
    expect(await wiki.f.access.canReadAsBaselineMember(verified, person.agent)).toBe(true);
    const candidateRequest = () => call('POST', '/v1/wiki/candidates', {
        target: work.work, zone, actingSubject: person.agent,
        names: ['Masked traveller', 'Secret royal heir', 'Unknown candidate'].map(value => ({ value, language: 'en' })),
      }, reader.token);
    const lookup = async () => checked<{ items: { status: string; candidates: string[] }[] }>(
      await candidateRequest(),
    );
    const progress = new StructureProgressStore(wiki.f.contentPool);
    const write = (chapter: number, completed: boolean, expectedVersion: number) => progress.write({
      principal: verified, structure: wiki.composition.structure,
      occurrence: wiki.chapters.occurrences[chapter]!, completed, expectedVersion,
      position: null, idempotencyKey: randomUUID(),
    });
    await write(0, true, 0);
    const early = await lookup();
    expect(early.items[0]).toMatchObject({ status: 'matched', candidates: [entity] });
    expect(early.items[1]).toMatchObject({ status: 'new', candidates: [] });
    await write(1, true, 0);
    const later = await lookup();
    expect(later.items[1]).toMatchObject({ status: 'matched', candidates: [entity] });
    expect(later.items[0]).toMatchObject({ status: 'ambiguous', candidates: [entity, wiki.laterEntity].sort() });
    await write(1, false, 1);
    expect(await lookup()).toEqual(early);
    const positions = wiki.deps.readingPositions!;
    const snapshot = positions.privateSnapshot.bind(positions);
    let moved = false;
    positions.privateSnapshot = async (...args) => {
      const before = await snapshot(...args);
      if (!moved) { moved = true; await write(1, true, 2); }
      return before;
    };
    try {
      const response = await candidateRequest();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'read_basis_changed' });
    } finally {
      positions.privateSnapshot = snapshot;
    }
    expect(await lookup()).toEqual(later);
    await write(1, false, 3);
    await write(0, false, 1);
    expect((await lookup()).items.every(item => item.status === 'new' && item.candidates.length === 0)).toBe(true);
  } finally {
    await wiki.f.stop();
  }
}, 180_000);
