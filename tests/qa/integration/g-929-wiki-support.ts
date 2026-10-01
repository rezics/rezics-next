import { randomUUID } from 'node:crypto';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { SuitabilityStore } from '../../../services/main/src/modules/suitability/store.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
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
import { nativeId, shortId } from '../fixtures/author-credit.ts';
import { startMediaStack } from './media-support.ts';

import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
export async function checked<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status)
    throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

/** Real reviewed publication, graph owners and disclosure store. Account only
 * maps fixture bearers to principals; no age evidence is supplied. */
export async function publishedWiki(options: { reference?: boolean } = {}) {
  const f = await startMediaStack('g-922-wiki', { profileCredits: true });
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
      structureObjects: objects,
      editorialReview: new EditorialReviewStore(f.accessPool),
      wikiEvidence: new WikiEvidenceStore(f.contentPool),
      wikiQuotations: new WikiQuotationStore(f.contentPool),
      readingPositions: new ReadingPositionStore(f.contentPool),
      rights: { store: new RightsStore(f.contentPool, f.accessPool) },
      suitability: new SuitabilityStore(f.accessPool, f.access),
      governance: { store: governance },
      exports: new ExportStore(f.contentPool),
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
    const title = 'G922 reviewed wiki',
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
      'G922 wiki source chapters',
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
    if (options.reference) await steward.grant('relation:create:root', 'relation.change');
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
    const relation = options.reference
      ? await checked<{ component: string }>(
          await call('POST', '/v1/semantic/changes', {
            profile: 'semantic-change-v1',
            expectedHead: null,
            actingSubject: holder.actor,
            state: {
              component: 'definition',
              kind: 'relation',
              roles: [
                { key: 'subject', minParticipants: 1, maxParticipants: 1, ordered: false },
                { key: 'object', minParticipants: 1, maxParticipants: 1, ordered: false },
              ],
            },
          }),
          201,
        )
      : null;
    if (relation) await holder.grant(`semantic:read:${relation.component}`, 'semantic.read');
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
        name: 'G922 wiki',
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
        method: { agent: 'G922 holder', model: 'local', inference: 'local' },
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
    if (relation) {
      bundle.entities.push({
        id: 'witness',
        type: `${RV}Character`,
        names: [{ value: 'Hidden witness', language: 'en', kind: 'primary', revealedAt: 'ch1' }],
      });
      bundle.claims.push({
        ...bundle.claims[0]!,
        predicate: relation.component,
        object: { kind: 'entity', ref: 'witness' },
      });
    }
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
    const reference = receipt.commands!.find((command) => command.key.endsWith(':entity:witness'))
      ?.result as { component: string; revision: string } | undefined;
    return {
      f,
      deps,
      holder,
      steward,
      reader,
      call,
      work,
      zone,
      entity,
      chapters,
      governance,
      reference,
    };
  } catch (error) {
    await f.stop();
    throw error;
  }
}
