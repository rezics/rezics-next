import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { discoverEditorialAdapters } from '../../../services/main/src/modules/editorial-review/adapters.ts';
import type { OwnerReceipt } from '../../../services/main/src/modules/editorial-review/contract.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
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
import { ExportStore } from '../../../services/main/src/modules/export/store.ts';
import type { WikiDelta } from '../../../services/main/src/modules/wiki/delta.ts';
import type { WikiHistory } from '../../../services/main/src/modules/wiki/history.ts';
import { startMediaStack } from './media-support.ts';
import { submitWikiBundle } from '../../../packages/wiki-toolkit/src/submit.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (iri: string) => iri.slice('https://rezics.com/id/'.length);
type Command = { proposal: string; revision: number; outcome: string; receipt?: OwnerReceipt };
const outcomeResult = (receipt: OwnerReceipt, suffix: string) => {
  const row = receipt.commands!.find((outcome) => outcome.key.endsWith(`:${suffix}`))!;
  return row.result as { component: string; revision: string };
};

export async function wikiDeltaJourney() {
  const f = await startMediaStack('g-693', { profileCredits: true });
  const holder = await f.member('holder'),
    steward = await f.member('steward');
  const tokenPrincipals = new Map([
    [holder.token, holder.principal],
    [steward.token, steward.principal],
  ]);
  const objects = f.objects('semantic/structure/');
  await objects.initialize();
  const reading = new ReadingPositionStore(f.contentPool),
    evidence = new WikiEvidenceStore(f.contentPool);
  const nativePublish = evidence.publish.bind(evidence);
  let pausePublication: string | null = null;
  evidence.publish = async (...args) => {
    if (args[1] === pausePublication) {
      pausePublication = null;
      throw new Error('Evidence owner interrupted before commit');
    }
    return nativePublish(...args);
  };
  const graph = f.env.fuseki;
  const diagnostics: string[] = [];
  const modules = discoverEditorialAdapters().then((installed) => {
    const native = installed.get('wiki-bundle')!;
    installed.set('wiki-bundle', {
      ...native,
      create(runtime) {
        const adapter = native.create(runtime);
        return {
          ...adapter,
          commands: async (input) =>
            (await adapter.commands!(input)).map((command) => ({
              ...command,
              execute: async (...args) => {
                try {
                  return await command.execute(...args);
                } catch (error) {
                  diagnostics.push(
                    `${command.key}: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  throw error;
                }
              },
            })),
        };
      },
    });
    return installed;
  });
  f.access.configureBaseline(graph);
  const deps: MainWorkDependencies = {
    environment: { ...f.env, fuseki: graph },
    access: f.access,
    account: {
      verify: async (request) => {
        const principal = tokenPrincipals.get(
          request.headers.get('authorization')?.replace('Bearer ', '') ?? '',
        );
        if (!principal) throw new Error('QA bearer is missing');
        return principal;
      },
    },
    structureObjects: objects,
    wikiEvidence: evidence,
    wikiQuotations: new WikiQuotationStore(f.contentPool),
    exports: new ExportStore(f.contentPool),
    media: f.media,
    mediaAccess: f.mediaAccess,
    readingPositions: reading,
    editorialReview: new EditorialReviewStore(f.accessPool, modules),
    rights: { store: new RightsStore(f.contentPool, f.accessPool) },
  };
  let app = createMainApp(graph, deps);
  const call = (
    method: string,
    path: string,
    body?: object,
    token: string | null = holder.token,
    key = randomUUID(),
  ) =>
    app.handle(
      new Request(
        `http://main.local${path}${method === 'GET' && token ? `${path.includes('?') ? '&' : '?'}actingSubject=${token === steward.token ? steward.actor : holder.actor}` : ''}`,
        {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'idempotency-key': key,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      ),
    );
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    if (response.status !== status)
      throw new Error(`${response.status} expected ${status}: ${text}`);
    return JSON.parse(text) as T;
  };
  const path = (proposal: string, suffix = '') => `/v1/editorial/proposals/${proposal}${suffix}`;
  const decide = (
    proposal: string,
    revision: number,
    key = randomUUID(),
    token = steward.token,
    actor = steward.actor,
  ) =>
    call(
      'POST',
      path(proposal, '/decisions'),
      {
        profile: 'editorial-proposal-decide-v1',
        revision,
        outcome: 'applied',
        approve: true,
        message: 'Checked chapter citations',
        actingSubject: actor,
      },
      token,
      key,
    );
  const apply = async (
    proposal: string,
    revision: number,
    key = randomUUID(),
    token = steward.token,
    actor = steward.actor,
  ) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await decide(proposal, revision, key, token, actor);
      const result = await json<Command>(response, response.status === 202 ? 202 : 200);
      if (result.receipt) return result.receipt;
    }
    throw new Error(
      `Bundle did not finish its bounded deliveries: ${diagnostics.slice(-5).join('; ')}`,
    );
  };
  const proposalFor = async (bundle: WikiExtraction) => {
    const rows =
      (
        await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH <${GRAPHS.current}> {
      <${bundle.target}> rv:head ?head } }`)
      ).results?.bindings ?? [];
    const head = rows[0]!.head!.value;
    return json<Command>(
      await call('POST', '/v1/editorial/proposals', {
        profile: 'editorial-proposal-create-v1',
        kind: 'wiki-bundle',
        target: { resource: bundle.target, revision: head, context: 'urn:rezics:context:global' },
        candidate: bundle,
        baseHeads: [{ component: bundle.target, head }],
        evidence: [],
        actingSubject: holder.actor,
      }),
      201,
    );
  };
  const setup = async (publicWork: boolean) => {
    const title = publicWork ? 'Pride and Prejudice' : 'Private Pride and Prejudice';
    const types = ['https://schema.org/Book'];
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
    if (publicWork) {
      const english = await f.contribution(
        work.work,
        holder.actor,
        'en',
        'Pride and Prejudice, chapters 1–3',
      );
      await f.contribution(work.work, holder.actor, 'fr', 'Orgueil et Préjugés, chapitres 1–3');
      const selection = {
        context: { kind: 'main-version-default' as const, id: work.mainVersion },
        work: work.work,
        contribution: english.contribution,
        publicationDecision: english.decision,
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
          mainSelectionDigest(selection),
        ),
        selection,
      );
    }
    for (const member of [holder, steward])
      await f.accessPool.query(
        `INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,'agent.control','infinity') ON CONFLICT DO NOTHING`,
        [randomUUID(), member.principalId, member.actor],
      );
    await holder.grant(`work:read:${work.work}`, 'work.read');
    await holder.grant(`work:edit:${work.work}`, 'work.edit');
    await steward.grant(`work:read:${work.work}`, 'work.read');
    await steward.grant(`work:review:${work.work}`, 'work.review');
    await steward.grant(`work:edit:${work.work}`, 'work.edit');
    const structure = await json<{ structure: string; revision: string }>(
      await call('POST', '/v1/compositions', {
        profile: 'book-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: holder.actor,
      }),
      201,
    );
    const chapters = await json<{ occurrences: string[] }>(
      await call('POST', `/v1/compositions/${short(structure.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: structure.revision,
        actingSubject: holder.actor,
        operations: [1, 2, 3, 4].map((n) => ({
          op: 'insert',
          parent: structure.structure,
          role: 'chapter',
          position: 'last',
          target: 'https://schema.org/DigitalDocument',
          label: { value: `Chapter ${n}`, language: 'en' },
        })),
      }),
    );
    const collections: Record<string, string> = {};
    for (const segment of ['franchise', 'characters', 'places', 'events', 'chapters']) {
      const collection = id();
      await holder.grant(`collection:edit:${collection}`, 'collection.edit');
      await steward.grant(`collection:edit:${collection}`, 'collection.edit');
      await holder.grant(`semantic:read:${collection}`, 'semantic.read');
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
      if (segment === 'franchise')
        await json(
          await call('POST', `/v1/collections/${short(collection)}/changes`, {
            expectedHead: created.revision,
            actingSubject: holder.actor,
            operations: [
              {
                op: 'insert',
                parent: created.structure,
                role: 'member',
                position: 'last',
                target: work.work,
              },
            ],
          }),
        );
      collections[segment] = collection;
    }
    await holder.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(
      await call('POST', '/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'Pride and Prejudice wiki',
        capabilities: ['realm'],
        actingSubject: holder.actor,
      }),
      201,
    );
    const zone = id();
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
    for (const [routeSegment, target] of Object.entries(collections))
      navigation = await json(
        await call('POST', `/v1/zones/${short(zone)}/mounts`, {
          expectedHead: navigation.revision,
          target,
          routeSegment,
          position: 'last',
          disclosure: 'public',
          actingSubject: holder.actor,
        }),
      );
    await holder.grant('semantic:create:root', 'semantic.change');
    await steward.grant('semantic:create:root', 'semantic.change');
    await steward.grant('relation:create:root', 'relation.change');
    await steward.grant(`statement:speak:${steward.actor}`, 'statement.record');
    await steward.grant(`statement:speak:${steward.actor}`, 'statement.withdraw');
    const property = await json<{ component: string }>(
      await call('POST', '/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: holder.actor,
        state: { component: 'definition', kind: 'property' },
      }),
      201,
    );
    await holder.grant(`semantic:read:${property.component}`, 'semantic.read');
    const relation = await json<{ component: string }>(
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
    );
    await holder.grant(`semantic:read:${relation.component}`, 'semantic.read');
    const source = {
      representationSha256: (publicWork ? 'a' : 'b').repeat(64),
      mediaType: 'text/plain',
      language: 'en',
      rightsBasis: 'public_domain' as const,
      method: { agent: 'Holder extraction agent', model: 'local', inference: 'local' as const },
    };
    const evidenceFor = (quote: string) => ({
      quote,
      locator: {
        version: 'rezics-locator-v1' as const,
        source: {
          type: 'external' as const,
          representationSha256: source.representationSha256,
          mediaType: source.mediaType,
        },
        selector: { type: 'TextQuoteSelector' as const, exact: quote },
      },
    });
    const bundle: WikiExtraction = {
      profile: 'wiki-extraction-v1',
      target: work.work,
      continuity: work.work,
      zone,
      source,
      units: chapters.occurrences.slice(0, 3).map((occurrence, index) => ({
        id: `ch${index + 1}`,
        ordinal: index,
        label: `Chapter ${index + 1}`,
        occurrence,
      })),
      entities: [
        {
          id: 'elizabeth',
          type: `${RV}Character`,
          names: [
            { value: 'Elizabeth Bennet', language: 'en', kind: 'primary', revealedAt: 'ch1' },
            { value: 'Lizzy', language: 'en', kind: 'alias', revealedAt: 'ch2' },
          ],
        },
        {
          id: 'jane',
          type: `${RV}Character`,
          names: [{ value: 'Jane Bennet', language: 'en', kind: 'primary', revealedAt: 'ch1' }],
        },
      ],
      claims: [
        {
          subject: 'elizabeth',
          predicate: property.component,
          object: { kind: 'literal', value: 'Bennet family' },
          modality: 'narrated',
          continuity: work.work,
          revealedAt: 'ch1',
          evidence: [evidenceFor('The Bennet family')],
        },
        {
          subject: 'elizabeth',
          predicate: relation.component,
          object: { kind: 'entity', ref: 'jane' },
          modality: 'narrated',
          continuity: work.work,
          revealedAt: 'ch3',
          evidence: [evidenceFor('Elizabeth and Jane')],
        },
      ],
    };
    return { work, bundle, collections, chapters };
  };
  try {
    const shown = await setup(true),
      proposal = await proposalFor(shown.bundle);
    const receipt = await apply(proposal.proposal, 1);
    const elizabeth = outcomeResult(receipt, 'entity:elizabeth').component;
    const jane = outcomeResult(receipt, 'entity:jane').component;
    const statement = outcomeResult(receipt, 'claim:0').component;
    const historyPath = `/v1/wiki/${short(shown.work.work)}/history?position=all`;
    type History = WikiHistory & {
      sourcePosition: { dataEpoch: string; sequence: string };
      revisionSetDigest: string;
      resolutions: Record<string, unknown>;
      nextCursor: string | null;
    };
    const pinned = await json<History>(await call('GET', historyPath));
    expect(pinned.claims).toHaveLength(2);
    const pinnedPath = `${historyPath}&revisions=${encodeURIComponent(JSON.stringify(pinned.revisions))}`;
    const hidden = await json<History>(
      await call('GET', historyPath.replace('position=all', 'position=start')),
    );
    expect(hidden.claims).toEqual([]);
    expect(hidden.entities).toEqual([]);
    const submit = async (candidate: unknown): Promise<Command> => {
      const response = await submitWikiBundle(
        {
          send: async (envelope) => {
            const delivered = await call(
              envelope.method,
              envelope.path,
              envelope.body,
              holder.token,
              envelope.headers['idempotency-key'],
            );
            return { status: delivered.status, body: (await delivered.json()) as unknown };
          },
        },
        {
          target: {
            resource: shown.work.work,
            revision: receipt.afterHeads[0]!.head!,
            context: 'urn:rezics:context:global',
          },
          bundle: candidate,
          baseHeads: receipt.afterHeads,
          evidence: [],
          actingSubject: holder.actor,
        },
        `Bearer ${holder.token}`,
        randomUUID(),
      );
      if (response.status !== 201)
        throw new Error(
          `Wiki toolkit submission failed: ${response.status} ${JSON.stringify(response.body)}`,
        );
      return response.body as Command;
    };
    const fourth = shown.chapters.occurrences[3]!;
    const deltaBundle: WikiExtraction = {
      ...shown.bundle,
      entities: [],
      units: [
        {
          ...shown.bundle.units[0]!,
          id: 'ch4',
          ordinal: 3,
          label: 'Chapter 4',
          occurrence: fourth,
        },
      ],
      claims: [
        {
          ...shown.bundle.claims[0]!,
          subject: elizabeth,
          revealedAt: 'ch4',
          evidence: [
            {
              ...shown.bundle.claims[0]!.evidence[0]!,
              quote: 'Chapter four corrects the family',
              locator: {
                ...shown.bundle.claims[0]!.evidence[0]!.locator,
                selector: { type: 'TextQuoteSelector', exact: 'Chapter four corrects the family' },
              },
            },
          ],
        },
      ],
    };
    const delta: WikiDelta = {
      profile: 'wiki-delta-v1',
      base: pinned.revisions,
      bundle: deltaBundle,
      changes: [
        {
          claim: statement,
          revision: outcomeResult(receipt, 'claim:0').revision,
          operation: 'retract',
          reason: 'Chapter four contradicts this assertion',
          evidenceClaim: 0,
        },
      ],
    };
    const submitted = await submit(delta);
    const contender = await submit(delta);
    expect((await json<History>(await call('GET', historyPath))).claims).toEqual(pinned.claims);
    expect(
      (
        await call(
          'POST',
          path(submitted.proposal, '/decisions'),
          {
            profile: 'editorial-proposal-decide-v1',
            revision: 1,
            outcome: 'applied',
            approve: false,
            message: 'No review yet',
            actingSubject: steward.actor,
          },
          steward.token,
        )
      ).status,
    ).toBe(409);
    pausePublication = submitted.proposal;
    const applyKey = randomUUID();
    await json(await decide(submitted.proposal, 1, applyKey), 202);
    expect((await decide(contender.proposal, 1)).status).toBe(409);
    // Retry after the evidence owner's interruption must settle the same keys.
    const ended = await apply(submitted.proposal, 1, applyKey);
    expect(await apply(submitted.proposal, 1, applyKey)).toEqual(ended);
    expect(ended.commands!.find((command) => command.key.endsWith(':delta-end:0'))?.outcome).toBe(
      'applied',
    );
    const current = await json<History>(await call('GET', historyPath));
    expect(current.claims.map((claim) => claim.claim)).toEqual([pinned.claims[1]!.claim]);
    const graphClaims =
      (
        await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?statementState ?relationState WHERE {
      GRAPH <${GRAPHS.current}> { <${statement}> rv:statementState ?statementState .
        <${pinned.claims[1]!.claim}> rv:occurrenceHead ?head . }
      GRAPH <${GRAPHS.revisions}> { ?head rv:lifecycle ?relationState . }
    } LIMIT 2`)
      ).results?.bindings ?? [];
    expect(graphClaims).toHaveLength(1);
    expect(graphClaims[0]!.statementState!.value).toBe(`${RV}Withdrawn`);
    expect(graphClaims[0]!.relationState!.value).toBe(`${RV}Active`);
    expect(await json<History>(await call('GET', pinnedPath))).toEqual(pinned);
    expect(
      (
        await call('POST', '/v1/editorial/proposals', {
          profile: 'editorial-proposal-create-v1',
          kind: 'wiki-bundle',
          target: {
            resource: shown.work.work,
            revision: receipt.afterHeads[0]!.head,
            context: 'urn:rezics:context:global',
          },
          candidate: delta,
          baseHeads: receipt.afterHeads,
          evidence: [],
          actingSubject: holder.actor,
        })
      ).status,
    ).toBe(409);
    const reverted = await json<Command>(
      await call('POST', path(submitted.proposal, '/reversal'), {
        profile: 'editorial-proposal-revert-v1',
        evidence: [],
        actingSubject: holder.actor,
      }),
      201,
    );
    const restored = await apply(reverted.proposal, 1);
    expect(
      restored.commands!.find((command) => command.key.endsWith(':delta-restore:0'))?.outcome,
    ).toBe('applied');
    expect(
      (await json<History>(await call('GET', historyPath))).claims.map(
        (claim) => claim.value.object,
      ),
    ).toEqual([pinned.claims[1]!.value.object, pinned.claims[0]!.value.object]);
    // An amendment of a restored occurrence must address its new owner head,
    // while retaining the original citation identity for future restrictions.
    const accepted = await json<History>(await call('GET', historyPath));
    const restoredClaim = accepted.claims.find((claim) => claim.value.object.kind === 'literal')!;
    const amendedBundle = {
      ...deltaBundle,
      claims: [
        { ...deltaBundle.claims[0]!, object: { kind: 'literal' as const, value: 'Darcy family' } },
      ],
    };
    const amendment = await submit({
      profile: 'wiki-delta-v1',
      base: accepted.revisions,
      bundle: amendedBundle,
      changes: [
        {
          claim: restoredClaim.claim,
          revision: restoredClaim.revision,
          operation: 'amend',
          reason: 'Chapter four names the new family',
          evidenceClaim: 0,
        },
      ],
    });
    const amended = await apply(amendment.proposal, 1);
    expect(amended.commands!.find((command) => command.key.endsWith(':delta-end:0'))?.outcome).toBe(
      'applied',
    );
    expect(
      (await json<History>(await call('GET', historyPath))).claims.some(
        (claim) =>
          claim.value.object.kind === 'literal' && claim.value.object.value === 'Darcy family',
      ),
    ).toBe(true);
    const undoAmendment = await json<Command>(
      await call('POST', path(amendment.proposal, '/reversal'), {
        profile: 'editorial-proposal-revert-v1',
        evidence: [],
        actingSubject: holder.actor,
      }),
      201,
    );
    await apply(undoAmendment.proposal, 1);
    expect(
      (await json<History>(await call('GET', historyPath))).claims.map(
        (claim) => claim.value.object,
      ),
    ).toEqual([pinned.claims[1]!.value.object, pinned.claims[0]!.value.object]);
    // Relation occurrences have their own head predicate; corrections use the
    // same reviewed ending/revert path as personal Statements.
    const beforeRelation = await json<History>(await call('GET', historyPath));
    const relationClaim = beforeRelation.claims.find((row) => row.value.object.kind === 'entity')!;
    await steward.grant(`relation:edit:${relationClaim.claim}`, 'relation.change');
    const relationDelta = await submit({
      profile: 'wiki-delta-v1',
      base: beforeRelation.revisions,
      bundle: deltaBundle,
      changes: [
        {
          claim: relationClaim.claim,
          revision: relationClaim.revision,
          operation: 'retract',
          reason: 'Chapter four corrects the relation',
          evidenceClaim: 0,
        },
      ],
    });
    const relationEnded = await apply(relationDelta.proposal, 1);
    expect(relationEnded.commands!.find((row) => row.key.endsWith(':delta-end:0'))?.outcome).toBe(
      'applied',
    );
    expect(
      (await json<History>(await call('GET', historyPath))).claims.some(
        (row) => row.claim === relationClaim.claim,
      ),
    ).toBe(false);
    const relationRevert = await json<Command>(
      await call('POST', path(relationDelta.proposal, '/reversal'), {
        profile: 'editorial-proposal-revert-v1',
        evidence: [],
        actingSubject: holder.actor,
      }),
      201,
    );
    const relationRestored = await apply(relationRevert.proposal, 1);
    expect(
      relationRestored.commands!.find((row) => row.key.endsWith(':delta-restore:0'))?.outcome,
    ).toBe('applied');
    expect(
      (await json<History>(await call('GET', historyPath))).claims.some(
        (row) => row.value.object.kind === 'entity',
      ),
    ).toBe(true);
    const entityPin = await json<History>(
      await call('GET', `${pinnedPath}&entity=${encodeURIComponent(elizabeth)}`),
    );
    const sectionPin = await json<History>(await call('GET', `${pinnedPath}&section=characters`));
    expect(entityPin.entities.map((entity) => entity.entity)).toEqual([elizabeth]);
    expect(sectionPin.entities).toEqual(pinned.entities);
    // A later semantic rename cannot overwrite a pin's language-tagged names.
    await steward.grant(`semantic:edit:${elizabeth}`, 'semantic.change');
    const renamed = await json<{ revision: string }>(
      await call(
        'POST',
        '/v1/semantic/changes',
        {
          profile: 'semantic-change-v1',
          target: elizabeth,
          expectedHead: outcomeResult(receipt, 'entity:elizabeth').revision,
          actingSubject: steward.actor,
          state: {
            component: 'resource',
            types: [`${RV}Character`],
            lifecycle: 'active',
            properties: [
              {
                predicate: 'https://schema.org/name',
                value: { kind: 'language-string', lexical: 'Elizabeth Darcy', language: 'en' },
              },
              { predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: shown.work.work } },
            ],
          },
        },
        steward.token,
      ),
    );
    expect(renamed.revision).not.toBe(outcomeResult(receipt, 'entity:elizabeth').revision);
    expect(await json<History>(await call('GET', pinnedPath))).toEqual(pinned);
    expect(
      await json<History>(
        await call('GET', `${pinnedPath}&entity=${encodeURIComponent(elizabeth)}`),
      ),
    ).toEqual(entityPin);
    expect(await json<History>(await call('GET', `${pinnedPath}&section=characters`))).toEqual(
      sectionPin,
    );
    // G-836 currently limits public merge commands to Works. Exercise the
    // character dependency using its committed read-resolution representation.
    await f.fuseki.update(
      `INSERT DATA { GRAPH <${GRAPHS.current}> { <${jane}> <${RV}mergedInto> <${elizabeth}> } }`,
    );
    const resolved = await json<History>(await call('GET', pinnedPath));
    expect(resolved.resolutions[jane]).toMatchObject({
      source: jane,
      survivor: elizabeth,
      state: 'merged',
    });
    const { resolutions: _links, ...content } = resolved;
    const { resolutions: _oldLinks, ...pinnedContent } = pinned;
    expect(content).toEqual(pinnedContent);
    await holder.grant(`export:${shown.work.work}`, 'export.create');
    const exportBody = {
      profile: 'export-create-v1',
      actingSubject: holder.actor,
      useScope: 'quotation',
      selection: {
        kind: 'wiki-revision-set',
        reference: shown.work.work,
        revisions: pinned.revisions,
        expectedPosition: pinned.sourcePosition,
      },
    };
    const exported = await json<{
      manifestId: string;
      manifestDigest: string;
      plan: { completeness: string; members: { data: unknown }[] };
    }>(await call('POST', '/v1/exports', exportBody), 201);
    expect(exported.plan.completeness).toBe('complete');
    expect(JSON.stringify(exported.plan)).toContain('The Bennet family');
    expect(JSON.stringify(exported.plan)).toContain('Elizabeth and Jane');
    expect(
      (
        await json<{ manifestDigest: string }>(
          await call('GET', `/v1/exports/${exported.manifestId}`),
        )
      ).manifestDigest,
    ).toBe(exported.manifestDigest);
    const quoteIds = (receipt.owner as { evidence: string[] }).evidence;
    await steward.grant('rights:assess', 'rights.assess');
    const restrictionKey = randomUUID();
    await json(
      await call(
        'POST',
        '/v1/rights/use-assessments',
        {
          profile: 'rights-use-assessment-v1',
          actingSubject: steward.actor,
          material: {
            scopeKind: 'wiki_evidence',
            provider: null,
            namespace: null,
            sourceRecordId: null,
            contentVariantId: null,
            wikiEvidenceId: quoteIds[0],
            mediaAsset: null,
            component: 'record',
          },
          expressionKind: 'expression',
          family: 'data_rights',
          useKind: 'quotation',
          useScope: 'rezics:export:quotation',
          basis: 'permission',
          outcome: 'not_supported',
          licenseInstrument: null,
          exceptionKind: null,
          rationale: null,
          extent: {},
          evidence: {},
          obligations: [],
          expectedAssessment: null,
          idempotencyKey: restrictionKey,
        },
        steward.token,
        restrictionKey,
      ),
      201,
    );
    for (const url of [historyPath, pinnedPath, path(submitted.proposal)]) {
      const response = await call('GET', url),
        text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain('The Bennet family');
      expect(text).toContain('quoteWithheld');
    }
    expect((await call('GET', `/v1/exports/${exported.manifestId}`)).status).toBe(409);
    const withheld = await json<{
      manifestId: string;
      manifestDigest: string;
      plan: { completeness: string };
    }>(await call('POST', '/v1/exports', exportBody), 201);
    expect(withheld.manifestId).not.toBe(exported.manifestId);
    expect(withheld.manifestDigest).not.toBe(exported.manifestDigest);
    expect(withheld.plan.completeness).toBe('complete');
    expect(JSON.stringify(withheld.plan)).not.toContain('The Bennet family');
    expect(JSON.stringify(withheld.plan)).toContain('quoteWithheld');
    expect((await call('GET', `/v1/exports/${withheld.manifestId}`)).status).toBe(200);
    // The franchise inventory crosses the old 64-proposal window through real
    // reviewed publications. The next delta must fence the entire journal.
    const chapterOnly = { ...deltaBundle, claims: [] };
    for (let index = 0; index < 65; index++) {
      const chapter = await proposalFor(chapterOnly);
      await apply(chapter.proposal, 1);
    }
    const journalPage = await deps.editorialReview!.appliedReceipts(
      shown.work.work,
      'wiki-bundle',
      64,
    );
    expect(journalPage.receipts).toHaveLength(64);
    expect(journalPage.nextCursor).not.toBeNull();
    const bulk = await json<History>(await call('GET', historyPath));
    expect(JSON.stringify(bulk.revisions).length).toBeLessThan(200);
    const pagedClaims: string[] = [],
      pagedEntities: string[] = [],
      pagedUnits: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await json<History>(
        await call(
          'GET',
          `${historyPath}&limit=1&revisions=${encodeURIComponent(JSON.stringify(bulk.revisions))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      expect(page.claims.length + page.entities.length + page.units.length).toBeLessThanOrEqual(1);
      pagedClaims.push(...page.claims.map((row) => row.claim));
      pagedEntities.push(...page.entities.map((row) => row.entity));
      pagedUnits.push(...page.units.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pagedClaims.sort()).toEqual(bulk.claims.map((row) => row.claim).sort());
    expect(pagedEntities.sort()).toEqual(bulk.entities.map((row) => row.entity).sort());
    expect(pagedUnits.sort()).toEqual(bulk.units.map((row) => row.id).sort());
    const later = await submit({
      profile: 'wiki-delta-v1',
      base: bulk.revisions,
      bundle: chapterOnly,
      changes: [],
    });
    await apply(later.proposal, 1);
    await expect(
      submit({ profile: 'wiki-delta-v1', base: bulk.revisions, bundle: chapterOnly, changes: [] }),
    ).rejects.toThrow('409');
    expect((await json<History>(await call('GET', historyPath))).revisionSetDigest).not.toBe(
      bulk.revisionSetDigest,
    );
    const oldBulk = await json<History>(
      await call(
        'GET',
        `${historyPath}&revisions=${encodeURIComponent(JSON.stringify(bulk.revisions))}`,
      ),
    );
    expect(oldBulk).toEqual(bulk);
    expect((await call('GET', `/v1/exports/${withheld.manifestId}`)).status).toBe(200);
  } finally {
    await f.stop();
  }
}
