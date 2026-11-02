import { describe, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { EditionApi, EditionMetadata } from '../src/content-editions/edition-api';
import { configuredPriceExample } from '../src/kernel/fake/creator-offers';
import type { MoneySchemaApi } from '../src/checkout/money-schema';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
const { loadCreatorEditor, submitCreatorOffer, validateCreatorOfferMutation, nativeOwnedOffersApi } =
  await import('../src/checkout/creator-offers');
const { nativeMoneySchemaApi } = await import('../src/checkout/money-schema');

const id = (n: number) => `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`;
const metadata: EditionMetadata = {
  editionId: id(1),
  editionRevision: id(2),
  state: 'published',
  targetSubjectId: id(3),
  creatorAccountId: id(4),
  revisionId: id(5),
  sha256: 'a'.repeat(64),
  licence: 'CC-BY-4.0',
};
const create = {
  operation: 'create' as const,
  idempotencyKey: id(6),
  contentEditionId: id(1),
  title: 'Fixed edition',
  currency: 'usd' as const,
  unitAmountMinor: 1299,
  taxCode: 'txcd_10000000',
};
const schemaApi: MoneySchemaApi = {
  async read() {
    return { kind: 'ready', schema: configuredPriceExample };
  },
};
const editionApi = (value: EditionMetadata): EditionApi => ({
  async readMetadata() {
    return { state: 'available', value };
  },
  async readRevision() {
    throw new Error('The editor must not copy protected content');
  },
});
const request = () =>
  new Request('https://site.test/en/creator/offers/new', { headers: { authorization: 'Bearer current-seller' } });

describe('Creator offer publication consumes exact native terms and existing owner writes', () => {
  test('published metadata identifies a fixed version; draft, wrong identity and missing native producers stay unavailable or rejected', async () => {
    const page = await loadCreatorEditor(editionApi(metadata), schemaApi, 'Bearer seller', metadata.editionId);
    expect(page.kind).toBe('ready');
    if (page.kind === 'ready') expect(page.edition).toEqual(metadata);
    expect(
      await loadCreatorEditor(
        editionApi({ ...metadata, state: 'draft' }),
        schemaApi,
        'Bearer seller',
        metadata.editionId,
      ),
    ).toEqual({ kind: 'rejected' });
    expect(await loadCreatorEditor(editionApi(metadata), schemaApi, 'Bearer seller', id(8))).toEqual({
      kind: 'unavailable',
    });
    expect(
      await loadCreatorEditor(editionApi(metadata), nativeMoneySchemaApi, 'Bearer seller', metadata.editionId),
    ).toEqual({ kind: 'unavailable' });
    expect(await nativeOwnedOffersApi.list('Bearer seller', { limit: 20 })).toEqual({ kind: 'unavailable' });
    expect(await loadCreatorEditor(editionApi(metadata), schemaApi, 'Bearer seller')).toEqual({
      kind: 'choose-edition',
    });
  });
  test('client input cannot supply royalty, source, subject, creator, benefit or money authority', () => {
    expect(validateCreatorOfferMutation(create)).toEqual(create);
    for (const key of [
      'royaltyBasisPoints',
      'targetSubjectId',
      'creatorAccountId',
      'source',
      'benefit',
      'moneyUnit',
      'taxBehavior',
      'canSell',
    ])
      expect(() => validateCreatorOfferMutation({ ...create, [key]: true })).toThrow();
    expect(() => validateCreatorOfferMutation({ ...create, unitAmountMinor: 49 })).toThrow();
    expect(() => validateCreatorOfferMutation({ ...create, unitAmountMinor: 12.99 })).toThrow();
  });
  test('create forwards only the current native body; uncertain retries retain the exact body and key', async () => {
    const calls: { path: string; key: string | null; body: unknown }[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const call = new Request(input, init);
        expect(call.headers.get('authorization')).toBe('Bearer current-seller');
        calls.push({
          path: new URL(call.url).pathname,
          key: call.headers.get('idempotency-key'),
          body: await call.json(),
        });
        return calls.length === 1
          ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
          : Response.json({ offer: { id: id(9) } }, { status: 201 });
      }) as typeof fetch,
    });
    expect(await submitCreatorOffer(client, request(), {}, create)).toEqual({ kind: 'retry' });
    expect(await submitCreatorOffer(client, request(), {}, create)).toEqual({ kind: 'saved', id: id(9) });
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toEqual({
      path: '/v1/offers',
      key: create.idempotencyKey,
      body: {
        contentEditionId: metadata.editionId,
        title: create.title,
        currency: 'usd',
        unitAmountMinor: 1299,
        taxCode: create.taxCode,
      },
    });
  });
  test('observed own-row changes use PATCH and delist, with no guessed relist or currency change', async () => {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const call = new Request(input, init);
        calls.push(call);
        return Response.json({ offer: { id: id(9) } });
      }) as typeof fetch,
    });
    expect(
      await submitCreatorOffer(
        client,
        request(),
        {},
        { operation: 'reprice', offerId: id(9), expectedRevision: 3, unitAmountMinor: 1299, idempotencyKey: id(10) },
      ),
    ).toEqual({ kind: 'saved', id: id(9) });
    expect(calls[0]!.method).toBe('PATCH');
    expect(await calls[0]!.json()).toEqual({ unitAmountMinor: 1299, expectedRevision: 3 });
    expect(
      await submitCreatorOffer(
        client,
        request(),
        {},
        { operation: 'delist', offerId: id(9), expectedRevision: 3, idempotencyKey: id(11) },
      ),
    ).toEqual({ kind: 'saved', id: id(9) });
    expect(new URL(calls[1]!.url).pathname).toBe(`/v1/offers/${id(9)}:delist`);
    expect(calls[1]!.method).toBe('POST');
    expect(await calls[1]!.json()).toEqual({ expectedRevision: 3 });
    expect(() =>
      validateCreatorOfferMutation({
        operation: 'reprice',
        offerId: id(9),
        expectedRevision: 3,
        unitAmountMinor: 1299,
        idempotencyKey: id(10),
        currency: 'eur',
      }),
    ).toThrow();
  });
});

test('seller changes require reviewed revisions and expose native conflicts for explicit review', async () => {
  const client = createKernelClient('https://kernel.test', {
    fetch: (async () => Response.json({ code: 'offer_revision_conflict' }, { status: 409 })) as typeof fetch,
  });
  for (const operation of ['reprice', 'delist'] as const) {
    const terms = {
      operation,
      offerId: id(9),
      idempotencyKey: id(10),
      ...(operation === 'reprice' ? { unitAmountMinor: 1299 } : {}),
    };
    const change = validateCreatorOfferMutation({ ...terms, expectedRevision: 3 });
    expect(await submitCreatorOffer(client, request(), {}, change)).toEqual({ kind: 'conflict' });
    for (const expectedRevision of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1])
      expect(() => validateCreatorOfferMutation({ ...terms, expectedRevision })).toThrow();
  }
});
