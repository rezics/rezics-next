import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fromPlainText } from '@rezics/document';
import type {
  ContentCore,
  ExactContentReference,
  PublicationPreparation,
  SaveDraftCommand,
  SaveDraftResult,
} from '../../content/src/core.ts';
import { ContentConflict } from '../../content/src/core.ts';
import {
  AdmissionDenied,
  type AdmissionRequest,
  type RegisteredAdmission,
} from '../src/modules/access/admission.ts';
import {
  ContentDraftDenied,
  ContentDraftStale,
  ContentDraftUnavailable,
  saveAdmittedContentDraft,
  type AuthoredContentDraftInput,
} from '../src/modules/content-publication/draft.ts';
import { pinAdmittedZonePageContent } from '../src/modules/content-publication/publish-admitted.ts';
import {
  ContentEmbedDenied,
  ContentEmbedUnavailable,
} from '../src/modules/content-publication/embed-closure.ts';
import {
  ContentPublicationConflict,
  settleZonePageContentPublication,
  StaleContentOwnerEpoch,
  type PublishPinnedContentInput,
} from '../src/modules/content-publication/publish.ts';
import { compositionReceiptIri } from '../src/modules/structure/change.ts';
import { zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';
import { ZoneUnavailable } from '../src/modules/zone/configuration.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const zoneType = 'https://rezics.com/vocab/Zone';
const workType = 'https://schema.org/CreativeWork';
const resource = () => `https://rezics.com/id/${randomUUID()}`;
const request = () => new Request('http://main.test/v1/content-drafts');
const principal = { issuer: 'https://account.test', subject: 'editor', emailVerified: true };
const position = { owner: 'content' as const, dataEpoch: randomUUID(), sequence: '4' };

function environment(types = [zoneType], receiptRows: Record<string, { value: string }>[] = []) {
  const queries: string[] = [];
  const env = {
    lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: {
      query: async (query: string) => {
        queries.push(query);
        if (query.includes('SELECT DISTINCT ?type'))
          return {
            results: {
              bindings: types.map((type) => ({ type: { value: type } })),
            },
          };
        if (query.includes('SELECT ?zone ?revision')) return { results: { bindings: receiptRows } };
        if (query.includes('SELECT ?admission ?receipt ?digest'))
          return {
            results: {
              bindings: [
                {
                  admission: { value: randomUUID() },
                  receipt: { value: `urn:rezics:receipt:${'c'.repeat(64)}` },
                  digest: { value: 'd'.repeat(64) },
                },
              ],
            },
          };
        return { boolean: true };
      },
    },
  } as unknown as WorkActivationEnvironment;
  return { env, queries };
}

function draftHarness(types = [zoneType]) {
  const { env, queries } = environment(types);
  const target = resource();
  const input: AuthoredContentDraftInput = {
    resourceId: target,
    variant: {
      id: `urn:rezics:variant:${randomUUID()}`,
      resourceId: target,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr',
    },
    expectedHead: null,
    body: 'Home',
    actingSubject: resource(),
    idempotencyKey: randomUUID(),
  };
  const registrations: AdmissionRequest[] = [],
    commands: SaveDraftCommand[] = [];
  const scopes: string[][] = [];
  const state = {
    denyRegistration: false,
    denyClaim: false,
    zoneEditor: true,
    outcome: 'succeeded' as SaveDraftResult['outcome'],
    head: randomUUID(),
    claims: 0,
    receipts: 0,
  };
  const account = {
    verify: async (_request: Request, required: readonly string[]) => {
      scopes.push([...required]);
      return principal;
    },
  };
  const access = {
    activePrincipalId: async () => randomUUID(),
    withOwnerAuthority: async (
      _authority: unknown,
      operation: (client: PoolClient) => Promise<unknown>,
    ) =>
      operation({
        query: async (sql: string) => ({
          rows: [],
          rowCount: sql.includes('SELECT a.id FROM access.admission a') && state.zoneEditor ? 1 : 0,
        }),
      } as unknown as PoolClient),
    register: async (registration: AdmissionRequest): Promise<RegisteredAdmission> => {
      registrations.push(registration);
      if (state.denyRegistration) throw new AdmissionDenied('not a Zone editor');
      return {
        ...registration,
        id: randomUUID(),
        principalId: randomUUID(),
        authorityEpoch: '1',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        state: 'registered',
        dispatchEligible: true,
        replayed: false,
      };
    },
    claim: async () => {
      state.claims++;
      if (state.denyClaim) throw new AdmissionDenied('editor revoked');
    },
    recordGraphOutcome: async () => {
      state.receipts++;
    },
  } as unknown as Parameters<typeof saveAdmittedContentDraft>[3];
  const content = {
    saveDraft: async (command: SaveDraftCommand): Promise<SaveDraftResult> => {
      commands.push(command);
      return {
        outcome: state.outcome,
        revisionId: state.outcome === 'succeeded' ? randomUUID() : null,
        predecessor: command.expectedHead,
        position,
        replayed: false,
      };
    },
    readDraftReceipt: async () => null,
    readDraftHead: async () => ({ revisionId: state.head }),
  } as unknown as ContentCore;
  const save = (value = input) =>
    saveAdmittedContentDraft(env, content, account, access, request(), value);
  return { env, queries, input, registrations, commands, scopes, state, save };
}

test('server-resolved Zone drafts use zone.edit and pin the Zone in Access admission', async () => {
  const h = draftHarness();
  const saved = await h.save();
  expect(saved.outcome).toBe('succeeded');
  expect(h.scopes).toEqual([['zone:edit']]);
  expect(h.registrations[0]).toMatchObject({
    action: 'content.draft',
    scope: `content:draft:${h.input.resourceId}`,
    resolvedZonePage: h.input.resourceId,
  });
  expect(h.state.claims).toBe(1);
  expect(h.state.receipts).toBe(1);
  expect(h.commands[0]!.variant.language).toEqual(h.input.variant.language);
});

test('Zone revision CAS reports the current head and preserves the requested predecessor', async () => {
  const h = draftHarness();
  h.input.expectedHead = randomUUID();
  h.state.outcome = 'stale_head';
  try {
    await h.save();
    throw new Error('Expected stale CAS');
  } catch (error) {
    expect(error).toBeInstanceOf(ContentDraftStale);
    expect((error as ContentDraftStale).currentHead).toBe(h.state.head);
  }
  expect(h.commands[0]!.expectedHead).toBe(h.input.expectedHead);
  expect(h.state.receipts).toBe(1);
});

test('non-editors and revoked editors cannot write any Zone draft bytes', async () => {
  for (const phase of ['registration', 'claim'] as const) {
    const h = draftHarness();
    h.state.denyRegistration = phase === 'registration';
    h.state.denyClaim = phase === 'claim';
    await expect(h.save()).rejects.toBeInstanceOf(
      phase === 'registration' ? AdmissionDenied : ContentDraftDenied,
    );
    expect(h.commands).toHaveLength(0);
    expect(h.state.receipts).toBe(0);
  }
});

test('an explicit Content policy cannot replace zone.edit for a Zone draft', async () => {
  const h = draftHarness();
  h.state.zoneEditor = false;
  await expect(h.save()).rejects.toBeInstanceOf(ContentDraftDenied);
  expect(h.registrations).toHaveLength(0);
  expect(h.commands).toHaveLength(0);
});

test('Zone Blocks documents preserve unknown opaque payloads and their fallback in exact bytes', async () => {
  const h = draftHarness();
  const document = structuredClone(fromPlainText('Home', 'blocks'));
  const payload = {
    future: [null, { coordinates: [121.5, 25], preserved: true }],
    unicode: '雨夜書店',
  };
  document.doc.content!.push({
    type: 'extensionBlock',
    attrs: {
      id: 'unknown-map',
      dir: null,
      lang: null,
      definition: 'https://example.org/future-map',
      version: '9',
      fallback: 'Place map',
      payload,
    },
  });
  const { body: _body, ...fields } = h.input;
  const saved = await h.save({ ...fields, document });
  const serialized = h.commands[0]!.serializedJson;
  expect(JSON.parse(serialized).document).toEqual(document);
  expect(JSON.parse(serialized).body).toContain('Place map');
  expect(JSON.parse(serialized).document.doc.content.at(-1).attrs.payload).toEqual(payload);
  expect(saved.byteDigest).toBe(createHash('sha256').update(serialized).digest('hex'));
});

test('a client-invented Zone owner cannot change an existing Work authority path', async () => {
  const h = draftHarness([workType]);
  await h.save({ ...h.input, resolvedZonePage: resource() } as AuthoredContentDraftInput);
  expect(h.scopes).toEqual([['work:edit']]);
  expect(h.registrations[0]!.resolvedZonePage).toBeUndefined();
  expect(h.commands).toHaveLength(1);
});

test('Content drafts accept another admitted resource type through its ordinary owner admission', async () => {
  const h = draftHarness(['https://schema.org/Place']);
  expect((await h.save()).outcome).toBe('succeeded');
  expect(h.registrations[0]).toMatchObject({
    action: 'content.draft',
    scope: `content:draft:${h.input.resourceId}`,
  });
  expect(h.registrations[0]!.resolvedZonePage).toBeUndefined();
  expect(h.commands[0]!.model).toBe('content-shape-v1');
});

test('absent, ambiguous and unknown-only graph types fail before Access admission', async () => {
  // Even a malformed owner response cannot admit a type outside the registry.
  for (const types of [[], [zoneType, workType], ['https://example.org/UnknownType']]) {
    const h = draftHarness(types);
    await expect(h.save()).rejects.toBeInstanceOf(ContentDraftUnavailable);
    expect(h.registrations).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
    expect(h.scopes).toHaveLength(0);
    expect(h.queries[0]).toContain('VALUES ?type');
    expect(h.queries[0]).not.toContain('https://example.org/UnknownType');
  }
});

test('catalogue-description claims cannot relabel a Zone draft', async () => {
  const h = draftHarness();
  await expect(h.save({ ...h.input, targetProfile: 'catalog-description' })).rejects.toBeInstanceOf(
    ContentConflict,
  );
  expect(h.registrations).toHaveLength(0);
  expect(h.commands).toHaveLength(0);
});

function pinHarness() {
  const { env } = environment();
  const input: PublishPinnedContentInput & { actingSubject: string } = {
    preparationId: `page:${randomUUID()}`,
    revisionId: randomUUID(),
    expectedDigest: 'a'.repeat(64),
    expectedContentEpoch: position.dataEpoch,
    resourceId: resource(),
    variantId: `urn:rezics:variant:${randomUUID()}`,
    expectedPublicationHead: null,
    actingSubject: resource(),
  };
  const reference: ExactContentReference = {
    owner: 'content',
    resourceId: input.resourceId,
    variantId: input.variantId,
    revisionId: input.revisionId,
    format: 'rezics-content-json-v1',
    model: 'content-shape-v1',
    byteDigest: input.expectedDigest,
    byteLength: 15,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' },
    direction: 'ltr',
    sourceRevision: null,
    predecessor: null,
    provenance: {},
  };
  const preparation: PublicationPreparation = {
    operationId: input.preparationId,
    reference,
    position,
    status: 'pending',
    pinActive: true,
    replayed: false,
  };
  const state = {
    denied: false,
    zoneEditor: true,
    pins: 0,
    reads: 0,
    ownerEpoch: position.dataEpoch,
  };
  const authorities: Array<Record<string, unknown>> = [],
    scopes: string[][] = [];
  const settlements: Parameters<ContentCore['settlePublication']>[] = [];
  const content = {
    owningResourceForRevision: async () => input.resourceId,
    readExactBatch: async () => {
      state.reads++;
      return [
        {
          revisionId: input.revisionId,
          status: 'available',
          reference,
          serializedJson: '{"body":"Home"}',
          body: { body: 'Home' },
        },
      ];
    },
    preparePublication: async () => {
      state.pins++;
      return preparation;
    },
    readPublicationPreparation: async () => preparation,
    ownerPosition: async () => ({ ...position, dataEpoch: state.ownerEpoch }),
    settlePublication: async (...args: Parameters<ContentCore['settlePublication']>) => {
      settlements.push(args);
      return { status: 'active', pinActive: false, position, replayed: false };
    },
  } as unknown as ContentCore;
  const account = {
    verify: async (_request: Request, required: readonly string[]) => {
      scopes.push([...required]);
      return principal;
    },
  };
  const access = {
    activePrincipalId: async () => randomUUID(),
    withOwnerAuthority: async (
      authority: Record<string, unknown>,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => {
      authorities.push(authority);
      if (state.denied) throw new AdmissionDenied('editor revoked');
      return operation({
        query: async (sql: string) => ({
          rows: [],
          rowCount: sql.includes('SELECT a.id FROM access.admission a') && state.zoneEditor ? 1 : 0,
        }),
      } as unknown as PoolClient);
    },
  } as unknown as Parameters<typeof pinAdmittedZonePageContent>[3];
  return {
    env,
    input,
    reference,
    preparation,
    state,
    authorities,
    scopes,
    settlements,
    content,
    account,
    access,
    pin: () => pinAdmittedZonePageContent(env, content, account, access, request(), input),
  };
}

test('site page custody pins exact bytes under the live Zone editor bridge without publishing them', async () => {
  const h = pinHarness();
  expect(await h.pin()).toMatchObject({ ...h.preparation, publicationGuard: '' });
  expect(h.scopes).toEqual([['zone:edit']]);
  expect(h.authorities[0]).toMatchObject({
    action: 'content.publish',
    scope: `content:publish:${h.input.resourceId}`,
    resolvedZonePage: h.input.resourceId,
  });
  expect(h.state.pins).toBe(1);
  expect(h.preparation.status).toBe('pending');
  expect(h.settlements).toHaveLength(0);
});

test('denied pin authority never reads bytes or creates a Content custody pin', async () => {
  const h = pinHarness();
  h.state.denied = true;
  await expect(h.pin()).rejects.toBeInstanceOf(AdmissionDenied);
  expect(h.state.reads).toBe(0);
  expect(h.state.pins).toBe(0);
});

test('an explicit Content policy cannot replace zone.edit for a site custody pin', async () => {
  const h = pinHarness();
  h.state.zoneEditor = false;
  await expect(h.pin()).rejects.toBeInstanceOf(ContentDraftDenied);
  expect(h.state.reads).toBe(0);
  expect(h.state.pins).toBe(0);
});

test('site custody refuses private, cyclic and missing embed dependencies before creating a pin', async () => {
  for (const outcome of ['private', 'cycle', 'missing'] as const) {
    const h = pinHarness(),
      embedded = randomUUID();
    h.content.readExactBatch = async (ids) =>
      ids.map((id) => {
        if (id === embedded && outcome === 'missing')
          return { revisionId: id, status: 'missing' as const };
        const body = {
          body: 'Home',
          embeds:
            id === h.input.revisionId
              ? [embedded]
              : outcome === 'cycle'
                ? [h.input.revisionId]
                : [],
        };
        return {
          revisionId: id,
          status: 'available' as const,
          reference: { ...h.reference, revisionId: id },
          body,
          serializedJson: JSON.stringify(body),
        };
      });
    await expect(h.pin()).rejects.toBeInstanceOf(
      outcome === 'missing' ? ContentEmbedUnavailable : ContentEmbedDenied,
    );
    expect(h.state.pins).toBe(0);
  }
});

test('site pins refuse foreign variants, stale Content epochs and spoofed catalogue profiles', async () => {
  for (const mismatch of ['variant', 'epoch', 'profile'] as const) {
    const h = pinHarness();
    if (mismatch === 'variant')
      h.preparation.reference.variantId = `urn:rezics:variant:${randomUUID()}`;
    if (mismatch === 'epoch') h.preparation.position = { ...position, dataEpoch: randomUUID() };
    if (mismatch === 'profile') h.input.targetProfile = 'catalog-description';
    await expect(h.pin()).rejects.toBeInstanceOf(ContentPublicationConflict);
    expect(h.settlements).toHaveLength(0);
  }
});

function siteProof(h: ReturnType<typeof pinHarness>) {
  const admissionId = randomUUID(),
    revision = resource();
  const receipt = compositionReceiptIri(admissionId, 'zone.edit');
  const { env } = environment();
  const values = {
    zone: h.input.resourceId,
    revision,
    routesRevision: resource(),
    navigationRevision: resource(),
    themeRevision: resource(),
    count: '1',
    admissionId,
    digest: 'b'.repeat(64),
    authorityEpoch: '1',
    scope: `zone:edit:${h.input.resourceId}`,
    dataEpoch: env.lineage.dataEpoch,
    sequence: '9',
    binding: zonePublishedPageBinding(revision, h.input.resourceId, h.input.revisionId),
    page: h.input.resourceId,
    variant: h.input.variantId,
    contentRevision: `urn:rezics:content:revision:${h.input.revisionId}`,
  };
  const row = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  env.fuseki = environment([zoneType], [row]).env.fuseki;
  return { env, row, receipt };
}

test('only an exact successful site receipt settles the pinned page, independently of current site heads', async () => {
  const h = pinHarness(),
    proof = siteProof(h);
  await settleZonePageContentPublication(
    proof.env,
    h.content,
    h.input.preparationId,
    proof.receipt,
  );
  expect(h.settlements).toHaveLength(1);
  expect(h.settlements[0]![2]).toEqual({
    outcome: 'active',
    revisionId: h.input.revisionId,
    receipt: proof.receipt,
    dataEpoch: proof.env.lineage.dataEpoch,
    sequence: '9',
  });
  expect(h.settlements[0]![3]).toBe(position.dataEpoch);
});

test('pending, invalid, foreign site receipts and stale owner epochs cannot settle page custody', async () => {
  for (const mismatch of ['pending', 'invalid', 'variant', 'epoch'] as const) {
    const h = pinHarness(),
      proof = siteProof(h);
    if (mismatch === 'pending') proof.env.fuseki = environment().env.fuseki;
    if (mismatch === 'invalid') proof.row.count = { value: '2' };
    if (mismatch === 'variant') proof.row.variant = { value: `urn:rezics:variant:${randomUUID()}` };
    if (mismatch === 'epoch') h.state.ownerEpoch = randomUUID();
    await expect(
      settleZonePageContentPublication(proof.env, h.content, h.input.preparationId, proof.receipt),
    ).rejects.toBeInstanceOf(
      mismatch === 'epoch'
        ? StaleContentOwnerEpoch
        : mismatch === 'invalid'
          ? ZoneUnavailable
          : ContentPublicationConflict,
    );
    expect(h.settlements).toHaveLength(0);
  }
});
