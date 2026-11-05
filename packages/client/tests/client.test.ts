import { expect, expectTypeOf, test } from 'bun:test';
import {
  createKernelClient,
  reviewedPersonRequests,
  isReviewedPersonEndpoint,
  type ReviewedPersonMerge,
  SESSION_HEADER,
  type Kernel,
  type KernelClient,
  type AccountAvatar,
  type AccountProfile,
  type AccountProfileResponse,
  type KernelSubjectsClient,
  type ManagedAccountOrganization,
  type ManagedAccountResponsibility,
  type ManagedAccountsPage,
  type NoticeInboxItem,
  type NoticeInboxPage,
  type SubjectRead,
  type UnreadNoticeSummary,
} from '../src/index.ts';

const ORIGIN = 'https://kernel.test';
const ID = '019a1b2c-3d4e-7f00-8a00-000000000001';
const subject = {
  id: ID,
  type: 'schema:Book',
  revision: 1,
  release: 'bundled',
  context: '019a1b2c-3d4e-7f00-8a00-000000000002',
  resolution: {},
  relationCounts: {},
  sourceRecords: [],
  labels: { en: '1984' },
  descriptions: { en: '2024-01-01' },
  aliases: {},
  statements: {},
};

type Sent = { url: string; method: string; headers: Headers; body: string | null };

/** A fetch that records each request and answers with the next of `answers`. */
function kernel(answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === null ? null : await request.text(),
    });
    return answers.shift()!();
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json', ...headers },
  });

test('all six label consolidation routes retain typed requests and results', () => {
  const typed = async (client: KernelClient) => {
    const label = client.libraryLabels({ id: ID });
    const selected = { subjectId: ID, assignmentId: ID, revision: 1 };
    const options = { headers: { 'idempotency-key': '"consolidate"' } };
    const review = await label.$reviewConsolidation.post({ targetLabelId: ID, items: [selected], limit: 4 });
    if (review.error) throw review.error;
    const confirmation = await label.$confirmConsolidation.post(
      {
        selection: review.data.selection,
        sourceLabel: review.data.sourceLabel,
        targetLabel: review.data.targetLabel,
        items: [{ selected, source: { id: ID, revision: 1, effective: true }, target: null, outcome: 'movable' }],
      },
      options,
    );
    if (confirmation.error) throw confirmation.error;
    expectTypeOf(review.data.selection).toEqualTypeOf<string>();
    expectTypeOf(review.data.next).toEqualTypeOf<string | null>();
    expectTypeOf(confirmation.data.confirmationId).toEqualTypeOf<string>();
    expectTypeOf(confirmation.data.expiresAt).toEqualTypeOf<string>();
    expectTypeOf(confirmation.data.status).toEqualTypeOf<'active'>();
    expectTypeOf(confirmation.data.itemCount).toEqualTypeOf<number>();
    const body = { confirmationId: confirmation.data.confirmationId };
    const results = [
      await label.$applyConsolidation.post(body, options),
      await label.$retryConsolidation.post({ ...body, item: 0 }, options),
      await label.$cancelConsolidation.post(body, options),
      await label.consolidations(body).get(),
    ];
    for (const result of results) {
      if (result.error) throw result.error;
      expectTypeOf(result.data.status).toEqualTypeOf<'active' | 'completed' | 'cancelled'>();
      expectTypeOf(result.data.items[0]?.item).toEqualTypeOf<number | undefined>();
      expectTypeOf(result.data.items[0]?.selected?.revision).toEqualTypeOf<number | undefined>();
    }
    // @ts-expect-error retry requires the selected item index
    await label.$retryConsolidation.post(body, options);
    // @ts-expect-error apply requires an idempotency key
    await label.$applyConsolidation.post(body);
    // @ts-expect-error review requires a numeric assignment revision
    await label.$reviewConsolidation.post({ targetLabelId: ID, items: [{ ...selected, revision: '1' }] });
  };
  expect(typeof typed).toBe('function');
});

test('a subject read answers like an Eden Treaty call, with the JSON as the kernel sent it', async () => {
  const { sent, fetch } = kernel([() => json(200, { subject, account: null, summary: null, related: {} })]);
  const client = createKernelClient(ORIGIN, { fetch });
  const { data, error, status } = await client.subjects({ id: ID }).get();
  expect(sent.map(({ url, method }) => [url, method])).toEqual([[`${ORIGIN}/v1/subjects/${ID}`, 'GET']]);
  expect(status).toBe(200);
  expect(error).toBeNull();
  expect(data).toEqual({ subject, account: null, summary: null, related: {} });
  expect(typeof data?.subject.descriptions.en).toBe('string');
});

test('a problem is the error value and no data', async () => {
  const problem = {
    type: 'https://rezics.com/problems/not_found',
    title: 'Not Found',
    status: 404,
    code: 'not_found',
    retryable: false,
    effect_status: 'not_applicable',
    request_id: '019a1b2c-3d4e-7f00-8a00-0000000000ff',
  };
  const { fetch } = kernel([() => json(404, problem)]);
  const { data, error, status } = await createKernelClient(ORIGIN, { fetch }).subjects({ id: ID }).get();
  expect(status).toBe(404);
  expect(data).toBeNull();
  expect(error).toMatchObject({ status: 404, value: problem });
});

test('the client sends back the session token the kernel last gave it', async () => {
  const { sent, fetch } = kernel([
    () => json(200, { subject, summary: null, related: {} }, { [SESSION_HEADER]: 'first' }),
    () => json(200, { subject, summary: null, related: {} }),
    () => json(200, { subject, summary: null, related: {} }, { [SESSION_HEADER]: 'second' }),
    () => json(200, { subject, summary: null, related: {} }),
  ]);
  const tokens: string[] = [];
  const client = createKernelClient(ORIGIN, {
    fetch,
    headers: { authorization: 'Bearer reader' },
    session: 'earlier',
    onSession: (token) => tokens.push(token),
  });
  for (let n = 0; n < 4; n++) await client.subjects({ id: ID }).get();
  expect(SESSION_HEADER).toBe('rezics-session-token');
  expect(sent.map(({ headers }) => headers.get(SESSION_HEADER))).toEqual(['earlier', 'first', 'first', 'second']);
  expect(sent.every(({ headers }) => headers.get('authorization') === 'Bearer reader')).toBe(true);
  expect(tokens).toEqual(['first', 'second']);
});

test("a create sends its idempotency key and JSON body, as the kernel's route types require", async () => {
  const { sent, fetch } = kernel([() => json(201, { subject }, { location: `/v1/subjects/${ID}` })]);
  const client: KernelClient = createKernelClient(ORIGIN, { fetch });
  const body = { type: 'schema:Book', labels: { en: '1984' } };
  const { data, status } = await client.subjects.post(body, { headers: { 'idempotency-key': '"k-1"' } });
  expect(status).toBe(201);
  expect(data?.subject.id).toBe(ID);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ url: `${ORIGIN}/v1/subjects`, method: 'POST', body: JSON.stringify(body) });
  expect(sent[0]!.headers.get('idempotency-key')).toBe('"k-1"');
  expect(sent[0]!.headers.get('content-type')).toBe('application/json');

  // Compile-time only: the types come from the kernel's routes.
  const typed = async () => {
    // @ts-expect-error a create needs its idempotency key
    await client.subjects.post(body);
    // @ts-expect-error an item needs labels
    await client.subjects.post({}, { headers: { 'idempotency-key': '"k-2"' } });
    // @ts-expect-error there is no such route
    await client.things.get();
  };
  expect(typeof typed).toBe('function');
});

test('the derived subjects group keeps native counts and routes contributed by other modules', async () => {
  const { sent, fetch } = kernel([
    () => json(200, { content: null }, { [SESSION_HEADER]: 'count-read' }),
    () => json(200, { counts: [{ kind: 'like', count: 2 }] }),
    () => json(200, { subject, account: null, summary: null, related: {} }),
  ]);
  const client = createKernelClient(ORIGIN, { fetch });
  const subjects: KernelSubjectsClient = client.subjects;
  const counts = await subjects({ id: ID }).counts.get();
  expect(counts.data).toEqual({ content: null });
  const reactions = await subjects({ id: ID }).reactions.get();
  expect(reactions.data?.counts).toEqual([{ kind: 'like', count: 2 }]);
  const read = await subjects({ id: ID }).get();
  if (read.error) throw read.error;
  const data: SubjectRead = read.data;
  expect(data.subject.id).toBe(ID);
  expect(sent.map(({ headers }) => headers.get(SESSION_HEADER))).toEqual([null, 'count-read', 'count-read']);

  const typed = async () => {
    // Every mounted root group remains present in the client representation.
    const complete: Record<keyof Kernel['~Routes']['v1'], object> = client;
    // This released native group is bound while whole-Kernel declaration publication is pending.
    const noExtraGroups: Exclude<
      keyof KernelClient,
      keyof Kernel['~Routes']['v1'] | 'subjectIdentityOperations' | '~path'
    > extends never
      ? true
      : false = true;
    const path: string = client['~path'];
    await subjects({ id: ID }).reaction.get();
    await subjects({ id: ID }).ratings({ questionId: ID }).vote.get();
    await client.libraryImports.anilist({ importId: ID }).get();
    await client.libraryImports.mal({ id: ID }).get();
    await client.libraryImports.bangumi({ uploadId: ID }).get();
    // @ts-expect-error a subject parameter is required
    subjects({});
    // @ts-expect-error omitted public aggregates are optional
    const properties: Record<string, { out?: number; in?: number }> = counts.data!.properties;
    // @ts-expect-error relation counts do not expose an invented total
    counts.data!.total;
    return { complete, noExtraGroups, path };
  };
  expect(typeof typed).toBe('function');
});

test('the generated account client reads the Inbox and unread summary', async () => {
  const { sent, fetch } = kernel([() => json(200, { items: [], next: null }), () => json(200, { unread: 0 })]);
  const client = createKernelClient(ORIGIN, { fetch });
  const inbox = await client.accounts({ accountId: ID }).notifications.get();
  const unread = await client.accounts({ accountId: ID }).notifications.count.get();
  const page: NoticeInboxPage = inbox.data!;
  const first: NoticeInboxItem | undefined = page.items[0];
  const summary: UnreadNoticeSummary = unread.data!;
  expectTypeOf(first).toEqualTypeOf<NoticeInboxItem | undefined>();
  expectTypeOf(summary).toEqualTypeOf<UnreadNoticeSummary>();
  expect(sent.map(({ url, method }) => [url, method])).toEqual([
    [`${ORIGIN}/v1/accounts/${ID}/notifications`, 'GET'],
    [`${ORIGIN}/v1/accounts/${ID}/notifications/count`, 'GET'],
  ]);
});

test('profile and managed-account readers expose the mounted account responses', async () => {
  const organizationAccount = { id: `${ID}-org`, kind: 'organization', handle: 'club', displayName: 'Club' } as const;
  const { sent, fetch } = kernel([
    () => json(200, { profile: { avatar: null } }),
    () =>
      json(200, {
        account: { id: ID, kind: 'actor', handle: 'reader', displayName: 'Reader' },
        organizations: {
          state: 'ready',
          items: [{ account: organizationAccount, role: 'owner' }],
          next: null,
        },
        responsibilities: {
          items: [
            { reservationId: `${ID}-reservation`, accountId: ID, account: organizationAccount, state: 'current' },
          ],
          next: null,
        },
      }),
  ]);
  const client = createKernelClient(ORIGIN, { fetch });
  const profile = await client.accounts({ accountId: ID }).profile.get();
  const managed = await client.me.managedAccounts.get({ query: { organizationsCursor: 'selected-page' } });
  const accountProfile: AccountProfile = profile.data!.profile;
  const avatar: AccountAvatar | null = accountProfile.avatar;
  const accountProfileResponse: AccountProfileResponse = profile.data!;
  const page: ManagedAccountsPage = managed.data!;
  const organization: ManagedAccountOrganization | undefined = page.organizations.items[0];
  const responsibility: ManagedAccountResponsibility | undefined = page.responsibilities.items[0];

  expectTypeOf(accountProfileResponse.profile).toEqualTypeOf<AccountProfile>();
  expectTypeOf(avatar).toEqualTypeOf<AccountAvatar | null>();
  expectTypeOf(page.account.id).toEqualTypeOf<string>();
  expectTypeOf(organization).toEqualTypeOf<ManagedAccountOrganization | undefined>();
  expectTypeOf(responsibility).toEqualTypeOf<ManagedAccountResponsibility | undefined>();
  expect(page.account.id).toBe(ID);
  expect(organization?.account.kind).toBe('organization');
  expect(responsibility?.state).toBe('current');
  expect(sent.map(({ url, method }) => [url, method])).toEqual([
    [`${ORIGIN}/v1/accounts/${ID}/profile`, 'GET'],
    [`${ORIGIN}/v1/me/managedAccounts?organizationsCursor=selected-page`, 'GET'],
  ]);
});

test('the same proxy rewrites a custom method and retains viewer headers', async () => {
  const { sent, fetch } = kernel([() => json(200, { redirect: { from: ID, to: ID } })]);
  const client = createKernelClient(ORIGIN, { fetch, session: 'viewer' });
  await client.subjects.$merge.post({ subjects: [ID] }, { headers: { 'idempotency-key': '"merge"' } });
  expect(sent[0]!.url).toBe(`${ORIGIN}/v1/subjects:merge`);
  expect(sent[0]!.headers.get(SESSION_HEADER)).toBe('viewer');
  expect(sent[0]!.headers.get('idempotency-key')).toBe('"merge"');
});

test('reviewed Person requests use native evidence query and preserve ordered decimal identity', async () => {
  const endpoint = {
    subject: ID,
    revision: 7,
    securityRevision: '9007199254740993',
    source: 'bangumi' as const,
    externalId: 'person:123',
    claimTransactionId: ID,
    property: 'wdt:P6298' as const,
    value: '123',
  };
  const other = { ...endpoint, subject: '019a1b2c-3d4e-7f00-8a00-000000000002' };
  const body: ReviewedPersonMerge = {
    subjects: [ID, other.subject],
    expectedIdentity: { endpoints: [endpoint, other] },
  };
  const remote = kernel([
    () => json(200, { subject, reviewedIdentity: endpoint }),
    () => json(202, { operation: { id: ID } }),
    () => json(200, { operation: { id: ID, done: false } }),
  ]);
  const client = createKernelClient(ORIGIN, { fetch: remote.fetch });
  const reviewed = reviewedPersonRequests(client);
  const read = await reviewed.read(ID, endpoint);
  expect(read.data).toMatchObject({ reviewedIdentity: { securityRevision: endpoint.securityRevision } });
  expect(new URL(remote.sent[0]!.url).searchParams.get('reviewIdentitySource')).toBe('bangumi');
  expect(new URL(remote.sent[0]!.url).searchParams.get('reviewIdentityExternalId')).toBe('person:123');
  expect(new URL(remote.sent[0]!.url).searchParams.get('includeViewerActions')).toBe('true');
  const admitted = await reviewed.merge(body, { headers: { 'idempotency-key': '"review"' } });
  expect(admitted.status).toBe(202);
  expect(admitted.data?.operation.id).toBe(ID);
  const pending = await reviewed.operation(ID);
  expect(pending.data?.operation).toEqual({ id: ID, done: false });
  expect(remote.sent[2]!.url).toBe(`${ORIGIN}/v1/subjectIdentityOperations/${ID}`);
  expect(JSON.parse(remote.sent[1]!.body!)).toEqual(body);
  expect(isReviewedPersonEndpoint(endpoint)).toBe(true);
  expect(isReviewedPersonEndpoint({ ...endpoint, privateClaim: ID })).toBe(false);
});
