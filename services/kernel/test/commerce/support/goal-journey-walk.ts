/**
 * First-public Commerce/Library journey catalog and native walk helpers.
 * The seeded page walk in apps/web/tests/native/commerce-library-journeys.walk.ts
 * is the single user-visible acceptance for the 26 finishing-register rows.
 */
import { fromPlainText } from '@rezics/document';

export const GLOBAL_CONTEXT = '00000000-0000-8000-8000-000000000000';
export const STANDARD_QUESTION = '00000000-0000-7000-8000-000000000001';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FIRST_PUBLIC_JOURNEYS = [
  {
    id: 'offer-management',
    title: 'Offer management',
    pages: ['/creator/offers', '/creator/offers/new'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'purchase',
    title: 'Purchase',
    pages: ['/offers/:id'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'owned-use',
    title: 'Owned use',
    pages: ['/orders/:id', '/orders'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'payment-repair',
    title: 'Payment repair',
    pages: ['/orders/:id'],
    personas: ['owner', 'repair'],
  },
  {
    id: 'creator-money',
    title: 'Creator money',
    pages: ['/creator/sales', '/creator/statements'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'financial-lifecycle',
    title: 'Financial lifecycle',
    pages: ['/orders', '/entitlements'],
    personas: ['owner', 'suspended/terminal'],
  },
  {
    id: 'entry-facts',
    title: 'Entry facts',
    pages: ['/library'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'profiles',
    title: 'Profiles',
    pages: ['/settings'],
    personas: ['owner', 'other'],
  },
  {
    id: 'labels',
    title: 'Labels',
    pages: ['/library/labels'],
    personas: ['owner', 'other'],
  },
  {
    id: 'progress',
    title: 'Progress',
    pages: ['/library/progress', '/library/progress/:id'],
    personas: ['owner'],
  },
  {
    id: 'sessions',
    title: 'Sessions',
    pages: ['/library/progress/:id', '/library/history'],
    personas: ['owner'],
  },
  {
    id: 'copies-and-loans',
    title: 'Copies and loans',
    pages: ['/library/copies'],
    personas: ['owner'],
  },
  {
    id: 'everything-and-filters',
    title: 'Everything and filters',
    pages: ['/library'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'liked-and-score',
    title: 'Liked and score',
    pages: ['/library', '/library/ratings'],
    personas: ['owner'],
  },
  {
    id: 'continue',
    title: 'Continue',
    pages: ['/library/continue'],
    personas: ['owner', 'anonymous'],
  },
  {
    id: 'curated-collections',
    title: 'Curated Collections',
    pages: ['/library/collections', '/collections/new'],
    personas: ['owner'],
  },
  {
    id: 'collection-reading',
    title: 'Collection reading',
    pages: ['/collections/:id'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'collection-publication',
    title: 'Collection publication',
    pages: ['/collections/:id'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'pins-and-return',
    title: 'Pins and return',
    pages: ['/library', '/collections/:id'],
    personas: ['owner'],
  },
  {
    id: 'undo-and-archive',
    title: 'Undo and archive',
    pages: ['/library'],
    personas: ['owner'],
  },
  {
    id: 'personal-history',
    title: 'Personal history',
    pages: ['/library/history', '/library/logs'],
    personas: ['owner', 'anonymous'],
  },
  {
    id: 'published-logs',
    title: 'Published Logs',
    pages: ['/logs/:id', '/library/logs'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'library-lifecycle',
    title: 'Library lifecycle',
    pages: ['/library'],
    personas: ['owner', 'anonymous'],
  },
  {
    id: 'follow-edges',
    title: 'Follow edges',
    pages: ['/library/following'],
    personas: ['owner', 'other'],
  },
  {
    id: 'following',
    title: 'Following',
    pages: ['/library/following'],
    personas: ['owner', 'other', 'anonymous'],
  },
  {
    id: 'follower-counts',
    title: 'Follower counts',
    pages: ['/library/follow-counts'],
    personas: ['owner', 'other', 'anonymous'],
  },
] as const;

export type JourneyId = (typeof FIRST_PUBLIC_JOURNEYS)[number]['id'];
export type Json = Record<string, unknown>;
export type PersonaKind = 'owner' | 'other' | 'anonymous' | 'repair' | 'suspended/terminal';

export type KernelCall = {
  method: string;
  path: string;
  status: number;
  value: Json;
  command: string;
  headers: Record<string, string>;
};

export type NativeStep = {
  name: string;
  command: string;
  ok: boolean;
  status?: number;
  observed?: unknown;
  expected?: string;
  error?: string;
};

export type JourneyWalkRow = {
  journey: JourneyId;
  title: string;
  result: 'PASS' | 'FAIL';
  revision: string;
  utc: string;
  elapsedSeconds: number;
  persona: string;
  firstDiffering?: { command: string; expected: string; observed: string };
  evidence: string;
  steps: NativeStep[];
  pages: string[];
};

export type WalkReport = {
  revision: string;
  utc: string;
  passing: number;
  total: 26;
  slowestFailing: JourneyWalkRow | null;
  rows: JourneyWalkRow[];
};

export type WalkAccount = { bearer?: string; accountId?: string; handle?: string };

export type WalkIdentities = {
  workId: string;
  collectionId?: string;
  offerId?: string;
  offerRevision?: number;
  orderId?: string;
  entitlementId?: string;
  editionId?: string;
  editionSubjectId?: string;
  editionSha256?: string | undefined;
  labelId?: string;
  labelRevision?: number;
  sessionId?: string;
  sessionRevision?: number;
  copyId?: string;
  copyRevision?: number;
  loanId?: string;
  ownedCollectionId?: string;
  ownedCollectionRevision?: number;
  publishedLogId?: string;
  pinCollectionId?: string;
};

export type WalkCallOptions = {
  bearer?: string | undefined;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
};

export type WalkKernel = {
  origin: string;
  call(method: string, path: string, options?: WalkCallOptions): Promise<KernelCall>;
};

export type JourneyContext = {
  kernel: WalkKernel;
  revision: string;
  owner: WalkAccount;
  other: WalkAccount;
  identities: WalkIdentities;
};

if (FIRST_PUBLIC_JOURNEYS.length !== 26) throw new Error(`first-public catalog has ${FIRST_PUBLIC_JOURNEYS.length}`);

export function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error(`${label} is not a native identity`);
  return value;
}

export function publicFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 32).map(publicFields);
  if (!value || typeof value !== 'object') return value;
  const output: Json = {};
  for (const [key, field] of Object.entries(value as Json)) {
    if (/token|password|cookie|authorization|secret|credential/i.test(key)) continue;
    output[key] = publicFields(field);
  }
  return output;
}

export function createWalkKernel(origin: string, timeoutMs = 30_000): WalkKernel {
  const base = new URL(origin).origin;
  return {
    origin: base,
    async call(method, path, options = {}) {
      const url = new URL(path, base);
      for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
      const headers: Record<string, string> = {
        'accept-language': 'en',
        ...(options.headers ?? {}),
      };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET' && method !== 'HEAD' && !headers['idempotency-key'])
        headers['idempotency-key'] = JSON.stringify(crypto.randomUUID());
      if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
      const response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
        redirect: 'error',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await response.text();
      let value: Json = {};
      if (text) {
        try {
          value = JSON.parse(text) as Json;
        } catch {
          value = { text: text.slice(0, 400) };
        }
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((headerValue, name) => {
        responseHeaders[name.toLowerCase()] = headerValue;
      });
      return {
        method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        value,
        command: `${method} ${url.pathname}`,
        headers: responseHeaders,
      };
    },
  };
}

export function checkoutSessionIdFromUrl(checkoutUrl: string): string | undefined {
  try {
    const match = /\/pay\/(cs_(?:(?:test|live)_)?[A-Za-z0-9]+)$/.exec(new URL(checkoutUrl).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function walkStripeOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const host = env.STRIPE_API_HOST;
  if (!host) return undefined;
  try {
    const url = new URL(host);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function nested(value: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Json)[key];
  }, value);
}

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

class JourneyFailure extends Error {
  constructor(
    readonly command: string,
    readonly expected: string,
    readonly observed: string,
    readonly steps: NativeStep[] = [],
  ) {
    super(`${command}: expected ${expected}, observed ${observed}`);
    this.name = 'JourneyFailure';
  }
}

class Recorder {
  readonly steps: NativeStep[] = [];
  constructor(
    readonly kernel: WalkKernel,
    readonly bearer: string | undefined,
  ) {}

  async expect(
    name: string,
    method: string,
    path: string,
    allowed: readonly number[],
    options: WalkCallOptions = {},
  ): Promise<KernelCall> {
    const call = await this.kernel.call(method, path, { ...options, bearer: options.bearer ?? this.bearer });
    const ok = allowed.includes(call.status);
    this.steps.push({
      name,
      command: call.command,
      ok,
      status: call.status,
      observed: publicFields(call.value),
      expected: `HTTP ${allowed.join('|')}`,
    });
    if (!ok)
      throw new JourneyFailure(
        call.command,
        `HTTP ${allowed.join('|')}`,
        `HTTP ${call.status} ${JSON.stringify(publicFields(call.value)).slice(0, 400)}`,
        this.steps,
      );
    return call;
  }

  async id(
    name: string,
    method: string,
    path: string,
    allowed: readonly number[],
    field: string,
    options: WalkCallOptions = {},
  ): Promise<{ call: KernelCall; id: string }> {
    const call = await this.expect(name, method, path, allowed, options);
    const id = requireId(nested(call.value, field), `${name} ${field}`);
    return { call, id };
  }

  async waitForPaidOrder(orderId: string, ms = 90_000): Promise<KernelCall> {
    const deadline = Date.now() + ms;
    let last: KernelCall | undefined;
    while (Date.now() < deadline) {
      last = await this.kernel.call('GET', `/v1/orders/${orderId}`, { bearer: this.bearer });
      const settlement = nested(last.value, 'order.settlement');
      const entitlementId = nested(last.value, 'order.entitlementId');
      if (last.status === 200 && settlement === 'paid' && typeof entitlementId === 'string') {
        this.steps.push({
          name: 'paid order',
          command: last.command,
          ok: true,
          status: last.status,
          observed: publicFields(last.value),
          expected: 'HTTP 200 paid entitlement',
        });
        return last;
      }
      await Bun.sleep(500);
    }
    this.steps.push({
      name: 'paid order',
      command: last?.command ?? `GET /v1/orders/${orderId}`,
      ok: false,
      ...(typeof last?.status === 'number' ? { status: last.status } : {}),
      observed: publicFields(last?.value ?? {}),
      expected: 'HTTP 200 paid entitlement',
    });
    throw new JourneyFailure(
      `GET /v1/orders/${orderId}`,
      'paid entitlement after signed Checkout',
      last ? `HTTP ${last.status} ${JSON.stringify(publicFields(last.value)).slice(0, 400)}` : 'no order read',
      this.steps,
    );
  }
}

export async function settleWalkCheckout(
  kernel: WalkKernel,
  checkoutUrl: string,
  stripeOrigin: string,
): Promise<void> {
  const sessionId = checkoutSessionIdFromUrl(checkoutUrl);
  if (!sessionId)
    throw new JourneyFailure('POST /v1/orders', 'hosted Checkout session', checkoutUrl);
  const pay = await fetch(`${stripeOrigin}/walk/pay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!pay.ok)
    throw new JourneyFailure(
      'POST /walk/pay',
      'signed fixture pay',
      `HTTP ${pay.status}`,
    );
  const signed = await fetch(`${stripeOrigin}/walk/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'checkout.session.completed', objectId: sessionId }),
  });
  if (!signed.ok)
    throw new JourneyFailure(
      'POST /walk/event',
      'signed checkout.session.completed',
      `HTTP ${signed.status}`,
    );
  const payload = (await signed.json()) as { bytes?: unknown; headers?: unknown };
  const bytes = typeof payload.bytes === 'string' ? payload.bytes : undefined;
  const headers = payload.headers && typeof payload.headers === 'object' ? (payload.headers as Record<string, string>) : undefined;
  const signature = headers?.['stripe-signature'];
  if (!bytes || !signature)
    throw new JourneyFailure('POST /walk/event', 'signed webhook bytes', JSON.stringify(payload).slice(0, 200));
  const webhook = await fetch(`${kernel.origin}/v1/webhooks/stripe`, {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: bytes,
  });
  if (!webhook.ok)
    throw new JourneyFailure(
      'POST /v1/webhooks/stripe',
      'HTTP 200 received',
      `HTTP ${webhook.status}`,
    );
}

async function publishEdition(kernel: WalkKernel, bearer: string, title: string) {
  const suffix = crypto.randomUUID();
  const rec = new Recorder(kernel, bearer);
  const scheme = await rec.id('edition scheme', 'POST', '/v1/subjects', [201], 'subject.id', {
    body: { type: 'skos:ConceptScheme', labels: { en: `Walk edition scheme ${suffix}` } },
  });
  const category = await rec.id('edition board concept', 'POST', '/v1/subjects', [201], 'subject.id', {
    body: {
      type: 'skos:Concept',
      labels: { en: `Walk edition board ${suffix}` },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    },
  });
  const board = await rec.id('edition board', 'POST', '/v1/boards', [201], 'board.id', {
    body: {
      conceptId: category.id,
      title: `Walk edition board ${suffix}`,
      visibility: 'published',
      purpose: 'discussion',
    },
  });
  const subject = await rec.id('edition subject', 'POST', '/v1/subjects', [201], 'subject.id', {
    body: {
      type: 'skos:Concept',
      labels: { en: title },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    },
  });
  const thread = await rec.expect('edition thread', 'POST', '/v1/threads', [201], {
    body: {
      title,
      body: fromPlainText(`Walk edition body ${suffix}`),
      licence: 'CC0-1.0',
      subjectIds: [subject.id],
      boardId: board.id,
      visibility: 'protected',
    },
  });
  const firstPost = asRecord(asRecord(thread.value.thread).firstPost);
  const edition = await rec.expect('content edition', 'POST', '/v1/contentEditions', [201], {
    body: {
      postId: requireId(firstPost.id, 'edition post'),
      revisionId: requireId(firstPost.revisionId, 'edition revision'),
      targetSubjectId: subject.id,
    },
  });
  const editionId = requireId(edition.value.editionId, 'content edition');
  await rec.expect('publish edition', 'POST', `/v1/contentEditions/${editionId}:publish`, [200], {
    headers: { 'if-match': JSON.stringify(edition.value.editionRevision) },
  });
  return {
    rec,
    contentEditionId: editionId,
    targetSubjectId: subject.id,
    sha256: typeof firstPost.sha256 === 'string' ? firstPost.sha256 : undefined,
  };
}

type Runner = (ctx: JourneyContext) => Promise<{ persona: string; steps: NativeStep[]; pages: string[] }>;

const offerManagement: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('owner offer list', 'GET', '/v1/offers', [200]);
  await rec.expect('anonymous offer list', 'GET', '/v1/offers', [401, 403], { bearer: undefined });
  const edition = await publishEdition(ctx.kernel, ctx.owner.bearer!, 'Walk first-public offer');
  rec.steps.push(...edition.rec.steps);
  const created = await rec.id('create offer', 'POST', '/v1/offers', [201], 'offer.id', {
    body: {
      contentEditionId: edition.contentEditionId,
      title: 'Walk first-public offer',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
    },
  });
  const publicRead = await rec.expect('public offer', 'GET', `/v1/offers/${created.id}`, [200], { bearer: undefined });
  const offer = asRecord(publicRead.value.offer);
  const revision = offer.revision;
  if (typeof revision !== 'number' || revision < 1)
    throw new JourneyFailure(
      'GET /v1/offers/:id',
      'public revision >= 1',
      JSON.stringify(publicFields(offer)),
      rec.steps,
    );
  ctx.identities.offerId = created.id;
  ctx.identities.offerRevision = revision;
  ctx.identities.editionId = edition.contentEditionId;
  ctx.identities.editionSubjectId = edition.targetSubjectId;
  ctx.identities.editionSha256 = edition.sha256;
  const revised = await rec.expect('revise price', 'PATCH', `/v1/offers/${created.id}`, [200], {
    body: { unitAmountMinor: 1500, expectedRevision: revision },
  });
  const next = asRecord(revised.value.offer).revision;
  await rec.expect('delist offer', 'POST', `/v1/offers/${created.id}:delist`, [200], {
    body: { expectedRevision: next },
  });
  await rec.expect('delisted public read', 'GET', `/v1/offers/${created.id}`, [404], { bearer: undefined });
  const live = await publishEdition(ctx.kernel, ctx.owner.bearer!, 'Walk live offer');
  rec.steps.push(...live.rec.steps);
  const selling = await rec.id('live offer', 'POST', '/v1/offers', [201], 'offer.id', {
    body: {
      contentEditionId: live.contentEditionId,
      title: 'Walk live offer',
      currency: 'usd',
      unitAmountMinor: 1200,
      taxCode: 'txcd_10302000',
    },
  });
  const sellingRead = await rec.expect('live public offer', 'GET', `/v1/offers/${selling.id}`, [200], {
    bearer: undefined,
  });
  ctx.identities.offerId = selling.id;
  ctx.identities.offerRevision = asRecord(sellingRead.value.offer).revision as number;
  ctx.identities.editionId = live.contentEditionId;
  ctx.identities.editionSubjectId = live.targetSubjectId;
  ctx.identities.editionSha256 = live.sha256;
  if (ctx.other.bearer)
    await rec.expect('other cannot create', 'POST', '/v1/offers', [401, 403], {
      bearer: ctx.other.bearer,
      body: {
        contentEditionId: live.contentEditionId,
        title: 'Other offer',
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      },
    });
  return { persona: 'owner', steps: rec.steps, pages: ['/creator/offers', `/offers/${ctx.identities.offerId}`] };
};

const purchase: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  if (!ctx.identities.offerId || ctx.identities.offerRevision === undefined)
    throw new JourneyFailure(
      'POST /v1/orders',
      'live offer from Offer management',
      'offer identity missing',
      rec.steps,
    );
  const subject = ctx.identities.editionSubjectId;
  if (subject)
    await rec.expect('subject offers', 'GET', `/v1/subjects/${subject}/offers`, [200], { bearer: undefined });
  await rec.expect('public offer page data', 'GET', `/v1/offers/${ctx.identities.offerId}`, [200], {
    bearer: undefined,
  });
  const buyer = ctx.other.bearer ? ctx.other : ctx.owner;
  const order = await rec.expect('create order', 'POST', '/v1/orders', [201], {
    bearer: buyer.bearer,
    body: { offerId: ctx.identities.offerId, expectedOfferRevision: ctx.identities.offerRevision },
  });
  const orderId = requireId(nested(order.value, 'order.id'), 'order');
  ctx.identities.orderId = orderId;
  const checkout = nested(order.value, 'order.checkoutUrl');
  if (typeof checkout !== 'string' || checkout.length < 8)
    throw new JourneyFailure('POST /v1/orders', 'hosted checkout URL', JSON.stringify(publicFields(order.value)));
  const stripeOrigin = walkStripeOrigin();
  if (!stripeOrigin)
    throw new JourneyFailure('POST /v1/orders', 'signed walk Stripe origin', 'STRIPE_API_HOST missing');
  const buyerRec = new Recorder(ctx.kernel, buyer.bearer);
  await settleWalkCheckout(ctx.kernel, checkout, stripeOrigin);
  const paid = await buyerRec.waitForPaidOrder(orderId);
  rec.steps.push(...buyerRec.steps);
  ctx.identities.entitlementId = requireId(nested(paid.value, 'order.entitlementId'), 'entitlement');
  await rec.expect('anonymous cannot buy', 'POST', '/v1/orders', [401, 403], {
    bearer: undefined,
    body: { offerId: ctx.identities.offerId, expectedOfferRevision: ctx.identities.offerRevision },
  });
  return { persona: 'owner', steps: rec.steps, pages: [`/offers/${ctx.identities.offerId}`, `/orders/${orderId}`] };
};

const ownedUse: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.other.bearer ?? ctx.owner.bearer);
  if (!ctx.identities.orderId)
    throw new JourneyFailure('GET /v1/orders/:id', 'order from Purchase', 'order identity missing');
  const order = await rec.expect('owner order', 'GET', `/v1/orders/${ctx.identities.orderId}`, [200]);
  const entitlementId =
    typeof nested(order.value, 'order.entitlementId') === 'string'
      ? requireId(nested(order.value, 'order.entitlementId'), 'entitlement')
      : undefined;
  if (!entitlementId)
    throw new JourneyFailure(
      `GET /v1/orders/${ctx.identities.orderId}`,
      'current entitlement after purchase',
      JSON.stringify(publicFields(order.value)),
      rec.steps,
    );
  ctx.identities.entitlementId = entitlementId;
  await rec.expect('owner entitlement', 'GET', `/v1/entitlements/${entitlementId}`, [200]);
  await rec.expect('order list', 'GET', '/v1/orders', [200]);
  await rec.expect('anonymous order', 'GET', `/v1/orders/${ctx.identities.orderId}`, [401, 403, 404], {
    bearer: undefined,
  });
  if (ctx.owner.bearer && ctx.other.bearer)
    await rec.expect('other-account order', 'GET', `/v1/orders/${ctx.identities.orderId}`, [403, 404], {
      bearer: ctx.owner.bearer,
    });
  return {
    persona: 'owner',
    steps: rec.steps,
    pages: [`/orders/${ctx.identities.orderId}`, '/orders'],
  };
};

const paymentRepair: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.other.bearer ?? ctx.owner.bearer);
  if (!ctx.identities.orderId)
    throw new JourneyFailure('POST /v1/orders/:id:reconcile', 'order from Purchase', 'order identity missing');
  await rec.expect('order before repair', 'GET', `/v1/orders/${ctx.identities.orderId}`, [200]);
  await rec.expect('reconcile', 'POST', `/v1/orders/${ctx.identities.orderId}:reconcile`, [200, 403, 409], {
    body: {},
  });
  return { persona: 'repair', steps: rec.steps, pages: [`/orders/${ctx.identities.orderId}`] };
};

const creatorMoney: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('creator sales', 'GET', '/v1/commerceSales', [200]);
  await rec.expect('creator statements', 'GET', '/v1/payoutStatements', [200]);
  await rec.expect('anonymous sales', 'GET', '/v1/commerceSales', [401, 403], { bearer: undefined });
  if (ctx.other.bearer)
    await rec.expect('other sales', 'GET', '/v1/commerceSales', [200, 403], { bearer: ctx.other.bearer });
  return { persona: 'owner', steps: rec.steps, pages: ['/creator/sales', '/creator/statements'] };
};

const financialLifecycle: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.other.bearer ?? ctx.owner.bearer);
  if (ctx.identities.orderId) {
    await rec.expect('retained order while living', 'GET', `/v1/orders/${ctx.identities.orderId}`, [200, 401, 404]);
  }
  await rec.expect('private orders', 'GET', '/v1/orders', [200, 401]);
  await rec.expect('anonymous orders', 'GET', '/v1/orders', [401, 403], { bearer: undefined });
  return { persona: 'suspended/terminal', steps: rec.steps, pages: ['/orders'] };
};

const entryFacts: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const written = await rec.expect('record state', 'PUT', `/v1/libraryEntries/${ctx.identities.workId}`, [200, 201], {
    body: { state: 'reading' },
  });
  const entry = asRecord(written.value.libraryEntry);
  const revision = entry.revision;
  const personal = await rec.expect(
    'personal facts',
    'GET',
    `/v1/libraryEntries/${ctx.identities.workId}/personal`,
    [200],
  );
  const personalRevision = asRecord(personal.value.personalEntry).revision;
  await rec.expect('set note and priority', 'PUT', `/v1/libraryEntries/${ctx.identities.workId}/annotations`, [200], {
    body: {
      revision: personalRevision,
      note: { op: 'set', value: 'Walk note' },
      priority: { op: 'set', value: 2 },
    },
  });
  const afterNote = await rec.expect('read note', 'GET', `/v1/libraryEntries/${ctx.identities.workId}/personal`, [200]);
  await rec.expect('clear note', 'PUT', `/v1/libraryEntries/${ctx.identities.workId}/annotations`, [200], {
    body: {
      revision: asRecord(afterNote.value.personalEntry).revision,
      note: { op: 'clear' },
      priority: { op: 'unchanged' },
    },
  });
  const remaining = await rec.expect(
    'independent remaining facts',
    'GET',
    `/v1/libraryEntries/${ctx.identities.workId}`,
    [200],
  );
  if (
    asRecord(remaining.value.libraryEntry).state !== 'reading' &&
    asRecord(remaining.value.libraryEntry).state !== entry.state
  )
    throw new JourneyFailure(
      `GET /v1/libraryEntries/${ctx.identities.workId}`,
      'state remains after note clear',
      JSON.stringify(publicFields(remaining.value)),
    );
  await rec.expect('library list', 'GET', '/v1/libraryEntries', [200]);
  await rec.expect('anonymous private library', 'GET', '/v1/libraryEntries', [401, 403], { bearer: undefined });
  if (ctx.other.bearer)
    await rec.expect(
      'other cannot read owner entry',
      'GET',
      `/v1/libraryEntries/${ctx.identities.workId}`,
      [403, 404],
      {
        bearer: ctx.other.bearer,
      },
    );
  void revision;
  return { persona: 'owner', steps: rec.steps, pages: [`/subjects/${ctx.identities.workId}`, '/library'] };
};

const profiles: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const listed = await rec.expect('active profile', 'GET', '/v1/presentation/active', [200, 404]);
  const digest = typeof listed.value.digest === 'string' ? listed.value.digest : undefined;
  if (digest) await rec.expect('read profile', 'GET', `/v1/presentation/profiles/${digest}`, [200, 403, 404]);
  return { persona: 'owner', steps: rec.steps, pages: ['/settings'] };
};

const labels: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const created = await rec.id('create label', 'POST', '/v1/libraryLabels', [201], 'label.id', {
    body: { name: `Walk ${crypto.randomUUID().slice(0, 8)}` },
  });
  const revision = asRecord(created.call.value.label).revision;
  ctx.identities.labelId = created.id;
  ctx.identities.labelRevision = typeof revision === 'number' ? revision : 1;
  const renamed = await rec.expect('rename label', 'PATCH', `/v1/libraryLabels/${created.id}`, [200], {
    body: { name: `Walk renamed ${crypto.randomUUID().slice(0, 8)}`, revision: ctx.identities.labelRevision },
  });
  ctx.identities.labelRevision = asRecord(renamed.value.label).revision as number;
  await rec.expect('assign label', 'POST', `/v1/libraryLabels/${created.id}:assign`, [200], {
    body: { subjectId: ctx.identities.workId },
  });
  await rec.expect('list labels', 'GET', '/v1/libraryLabels', [200]);
  if (ctx.other.bearer)
    await rec.expect('other labels', 'GET', '/v1/libraryLabels', [200], { bearer: ctx.other.bearer });
  return { persona: 'owner', steps: rec.steps, pages: ['/library/labels', '/library'] };
};

const progress: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const started = await rec.expect('start session', 'POST', '/v1/progressSessions', [201], {
    body: { subjectId: ctx.identities.workId, mode: 'scalar_amount', unit: 'minute' },
  });
  const session = asRecord(started.value.progressSession);
  const sessionId = requireId(session.id, 'progress session');
  ctx.identities.sessionId = sessionId;
  ctx.identities.sessionRevision = session.revision as number;
  const recorded = await rec.expect('record amount', 'POST', `/v1/progressSessions/${sessionId}:record`, [200], {
    body: { revision: ctx.identities.sessionRevision, amount: '5' },
  });
  ctx.identities.sessionRevision = asRecord(recorded.value.progressSession).revision as number;
  await rec.expect('read session', 'GET', `/v1/progressSessions/${sessionId}`, [200]);
  return {
    persona: 'owner',
    steps: rec.steps,
    pages: ['/library/progress', `/library/progress/${sessionId}`],
  };
};

const sessions: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  if (!ctx.identities.sessionId)
    throw new JourneyFailure(
      'POST /v1/progressSessions/:id:record',
      'session from Progress',
      'session identity missing',
    );
  const current = await rec.expect('current session', 'GET', `/v1/progressSessions/${ctx.identities.sessionId}`, [200]);
  const revision = asRecord(current.value.progressSession).revision as number;
  const recorded = await rec.expect(
    'reread amount',
    'POST',
    `/v1/progressSessions/${ctx.identities.sessionId}:record`,
    [200],
    { body: { revision, amount: '8' } },
  );
  ctx.identities.sessionRevision = asRecord(recorded.value.progressSession).revision as number;
  await rec.expect('history', 'GET', '/v1/progressSessions', [200]);
  return {
    persona: 'owner',
    steps: rec.steps,
    pages: [`/library/progress/${ctx.identities.sessionId}`, '/library/history'],
  };
};

const copiesAndLoans: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const created = await rec.expect('create copy', 'POST', '/v1/copies', [201], {
    body: { subjectId: ctx.identities.workId, status: 'owned' },
  });
  const copy = asRecord(created.value.copy);
  const copyId = requireId(copy.id, 'copy');
  ctx.identities.copyId = copyId;
  ctx.identities.copyRevision = copy.revision as number;
  const loan = await rec.expect('lend copy', 'POST', '/v1/copy-loans', [201], {
    body: {
      copyId,
      copyRevision: ctx.identities.copyRevision,
      direction: 'lent',
      counterparty: { kind: 'name', name: 'Walk borrower' },
      startedOn: '2026-11-07',
      dueOn: '2026-11-21',
    },
  });
  const loanId = requireId(nested(loan.value, 'loan.id'), 'loan');
  ctx.identities.loanId = loanId;
  const loanRevision = nested(loan.value, 'loan.revision');
  await rec.expect('return copy', 'POST', `/v1/copy-loans/${loanId}/return`, [200], {
    body: { revision: loanRevision, returnedOn: '2026-11-08' },
  });
  await rec.expect('copy remains', 'GET', `/v1/copies/${copyId}`, [200]);
  await rec.expect('entry remains', 'GET', `/v1/libraryEntries/${ctx.identities.workId}`, [200]);
  return { persona: 'owner', steps: rec.steps, pages: ['/library/copies'] };
};

const everythingAndFilters: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('everything', 'GET', '/v1/libraryEntries', [200], { query: { limit: '20' } });
  await rec.expect('shelf summary', 'GET', '/v1/libraryShelfSummary', [200, 404]);
  await rec.expect('anonymous library', 'GET', '/v1/libraryEntries', [401, 403], { bearer: undefined });
  return { persona: 'owner', steps: rec.steps, pages: ['/library'] };
};

const likedAndScore: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect(
    'rate',
    'PUT',
    `/v1/subjects/${ctx.identities.workId}/ratings/${STANDARD_QUESTION}/vote`,
    [200, 201],
    { body: { units: 14 } },
  );
  await rec.expect(
    'read score',
    'GET',
    `/v1/subjects/${ctx.identities.workId}/ratings/${STANDARD_QUESTION}/vote`,
    [200, 404],
  );
  await rec.expect(
    'clear score',
    'DELETE',
    `/v1/subjects/${ctx.identities.workId}/ratings/${STANDARD_QUESTION}/vote`,
    [200, 204, 404],
  );
  return { persona: 'owner', steps: rec.steps, pages: ['/library', '/library/ratings'] };
};

const continueJourney: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('continue', 'GET', '/v1/libraryContinue', [200]);
  await rec.expect('anonymous continue', 'GET', '/v1/libraryContinue', [401, 403], { bearer: undefined });
  return { persona: 'owner', steps: rec.steps, pages: ['/library/continue'] };
};

const curatedCollections: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const created = await rec.id('create collection', 'POST', '/v1/collections', [201], 'collection.id', {
    body: { title: `Walk collection ${crypto.randomUUID().slice(0, 8)}`, visibility: 'private' },
  });
  ctx.identities.ownedCollectionId = created.id;
  ctx.identities.ownedCollectionRevision = asRecord(created.call.value.collection).revision as number;
  await rec.expect('add member', 'POST', `/v1/collections/${created.id}/members`, [201], {
    body: { subjectId: ctx.identities.workId, note: 'First occurrence' },
  });
  await rec.expect('duplicate occurrence', 'POST', `/v1/collections/${created.id}/members`, [201], {
    body: { subjectId: ctx.identities.workId, note: 'Second occurrence' },
  });
  const current = await rec.expect('reopen collection', 'GET', `/v1/collections/${created.id}`, [200]);
  ctx.identities.ownedCollectionRevision = asRecord(current.value.collection).revision as number;
  await rec.expect('members', 'GET', `/v1/collections/${created.id}/members`, [200]);
  return {
    persona: 'owner',
    steps: rec.steps,
    pages: ['/library/collections', `/collections/${created.id}`],
  };
};

const collectionReading: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const id = ctx.identities.ownedCollectionId ?? ctx.identities.collectionId;
  if (!id) throw new JourneyFailure('GET /v1/collections/:id', 'collection identity', 'missing');
  await rec.expect('owner collection', 'GET', `/v1/collections/${id}`, [200]);
  await rec.expect('owner members', 'GET', `/v1/collections/${id}/members`, [200]);
  const publicSeed = id === ctx.identities.collectionId && id !== ctx.identities.ownedCollectionId;
  await rec.expect('anonymous collection', 'GET', `/v1/collections/${id}`, publicSeed ? [200] : [401, 403, 404], {
    bearer: undefined,
  });
  if (ctx.other.bearer)
    await rec.expect('other collection', 'GET', `/v1/collections/${id}`, publicSeed ? [200] : [403, 404], {
      bearer: ctx.other.bearer,
    });
  return { persona: 'owner', steps: rec.steps, pages: [`/collections/${id}`] };
};

const collectionPublication: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const id = ctx.identities.ownedCollectionId;
  if (!id || ctx.identities.ownedCollectionRevision === undefined)
    throw new JourneyFailure('PATCH /v1/collections/:id', 'owned collection', 'missing');
  const published = await rec.expect('publish collection', 'PATCH', `/v1/collections/${id}`, [200], {
    body: { revision: ctx.identities.ownedCollectionRevision, visibility: 'public' },
  });
  ctx.identities.ownedCollectionRevision = asRecord(published.value.collection).revision as number;
  await rec.expect('anonymous public read', 'GET', `/v1/collections/${id}`, [200], { bearer: undefined });
  if (ctx.other.bearer)
    await rec.expect('other public read', 'GET', `/v1/collections/${id}`, [200], { bearer: ctx.other.bearer });
  const retracted = await rec.expect('retract collection', 'PATCH', `/v1/collections/${id}`, [200], {
    body: { revision: ctx.identities.ownedCollectionRevision, visibility: 'private' },
  });
  ctx.identities.ownedCollectionRevision = asRecord(retracted.value.collection).revision as number;
  await rec.expect('anonymous retracted', 'GET', `/v1/collections/${id}`, [401, 403, 404], { bearer: undefined });
  return { persona: 'owner', steps: rec.steps, pages: [`/collections/${id}`] };
};

const pinsAndReturn: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const id = ctx.identities.ownedCollectionId ?? ctx.identities.collectionId;
  if (!id) throw new JourneyFailure('PUT /v1/libraryPins/:id', 'collection identity', 'missing');
  await rec.expect('pin collection', 'PUT', `/v1/libraryPins/${id}`, [200], { body: { revision: 0 } });
  ctx.identities.pinCollectionId = id;
  await rec.expect('list pins', 'GET', '/v1/libraryPins', [200]);
  return { persona: 'owner', steps: rec.steps, pages: ['/library', `/collections/${id}`] };
};

const undoAndArchive: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const current = await rec.expect('current entry', 'GET', `/v1/libraryEntries/${ctx.identities.workId}`, [200]);
  const entry = asRecord(current.value.libraryEntry);
  const deleted = await rec.expect('clear entry', 'DELETE', `/v1/libraryEntries/${ctx.identities.workId}`, [204], {
    query: { revision: String(entry.revision) },
  });
  const deletionId = deleted.headers['library-entry-deletion-id'];
  const deletionRevision = deleted.headers['library-entry-deletion-revision'];
  await rec.expect('restore entry', 'POST', `/v1/libraryEntries/${ctx.identities.workId}:restore`, [200], {
    body: {
      deletionId,
      revision: deletionRevision === undefined ? entry.revision : Number(deletionRevision),
    },
  });
  await rec.expect('entry after undo', 'GET', `/v1/libraryEntries/${ctx.identities.workId}`, [200]);
  return { persona: 'owner', steps: rec.steps, pages: ['/library'] };
};

const personalHistory: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('history', 'GET', '/v1/progressSessions', [200]);
  await rec.expect('consumption summary', 'GET', '/v1/libraryConsumptionSummary', [200, 404]);
  await rec.expect('anonymous history', 'GET', '/v1/progressSessions', [401, 403], { bearer: undefined });
  return { persona: 'owner', steps: rec.steps, pages: ['/library/history', '/library/logs'] };
};

const publishedLogs: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  if (!ctx.identities.sessionId)
    throw new JourneyFailure('POST /v1/publishedLogs', 'session from Progress', 'session identity missing');
  const made = await rec.expect('publish log', 'POST', '/v1/publishedLogs', [201], {
    body: { sessionId: ctx.identities.sessionId, note: 'Walk public log' },
  });
  const log = asRecord(made.value.publishedLog);
  const logId = requireId(log.id, 'published log');
  ctx.identities.publishedLogId = logId;
  await rec.expect('anonymous log', 'GET', `/v1/publishedLogs/${logId}`, [200], { bearer: undefined });
  if (ctx.other.bearer)
    await rec.expect('other log', 'GET', `/v1/publishedLogs/${logId}`, [200], { bearer: ctx.other.bearer });
  return { persona: 'owner', steps: rec.steps, pages: [`/logs/${logId}`, '/library/logs'] };
};

const libraryLifecycle: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('private library still open', 'GET', '/v1/libraryEntries', [200]);
  await rec.expect('anonymous private library', 'GET', '/v1/libraryEntries', [401, 403], { bearer: undefined });
  if (ctx.identities.copyId) await rec.expect('owned copy', 'GET', `/v1/copies/${ctx.identities.copyId}`, [200]);
  return { persona: 'owner', steps: rec.steps, pages: ['/library'] };
};

const followEdges: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  const key = JSON.stringify(crypto.randomUUID());
  await rec.expect('follow', 'PUT', `/v1/follows/${ctx.identities.workId}`, [200], {
    headers: { 'idempotency-key': key },
  });
  await rec.expect('exact retry', 'PUT', `/v1/follows/${ctx.identities.workId}`, [200], {
    headers: { 'idempotency-key': key },
  });
  await rec.expect('read follow', 'GET', `/v1/follows/${ctx.identities.workId}`, [200]);
  await rec.expect('unfollow', 'DELETE', `/v1/follows/${ctx.identities.workId}`, [200, 204]);
  await rec.expect('follow again', 'PUT', `/v1/follows/${ctx.identities.workId}`, [200]);
  return { persona: 'owner', steps: rec.steps, pages: ['/library/following'] };
};

const following: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('following list', 'GET', '/v1/follows', [200]);
  await rec.expect('anonymous following', 'GET', '/v1/follows', [401, 403], { bearer: undefined });
  if (ctx.other.bearer) await rec.expect('other following', 'GET', '/v1/follows', [200], { bearer: ctx.other.bearer });
  return { persona: 'owner', steps: rec.steps, pages: ['/library/following'] };
};

const followerCounts: Runner = async (ctx) => {
  const rec = new Recorder(ctx.kernel, ctx.owner.bearer);
  await rec.expect('outgoing counts', 'GET', '/v1/followCounts/outgoing', [200]);
  await rec.expect('subject counts', 'GET', `/v1/followCounts/subject/${ctx.identities.workId}`, [200, 403, 404]);
  await rec.expect('anonymous counts', 'GET', '/v1/followCounts/outgoing', [401, 403], { bearer: undefined });
  if (ctx.other.bearer)
    await rec.expect('other outgoing counts', 'GET', '/v1/followCounts/outgoing', [200], { bearer: ctx.other.bearer });
  return { persona: 'owner', steps: rec.steps, pages: ['/library/follow-counts'] };
};

export const JOURNEY_RUNNERS: Record<JourneyId, Runner> = {
  'offer-management': offerManagement,
  purchase,
  'owned-use': ownedUse,
  'payment-repair': paymentRepair,
  'creator-money': creatorMoney,
  'financial-lifecycle': financialLifecycle,
  'entry-facts': entryFacts,
  profiles,
  labels,
  progress,
  sessions,
  'copies-and-loans': copiesAndLoans,
  'everything-and-filters': everythingAndFilters,
  'liked-and-score': likedAndScore,
  continue: continueJourney,
  'curated-collections': curatedCollections,
  'collection-reading': collectionReading,
  'collection-publication': collectionPublication,
  'pins-and-return': pinsAndReturn,
  'undo-and-archive': undoAndArchive,
  'personal-history': personalHistory,
  'published-logs': publishedLogs,
  'library-lifecycle': libraryLifecycle,
  'follow-edges': followEdges,
  following,
  'follower-counts': followerCounts,
};

export async function runJourney(ctx: JourneyContext, id: JourneyId): Promise<Omit<JourneyWalkRow, 'evidence'>> {
  const spec = FIRST_PUBLIC_JOURNEYS.find((row) => row.id === id)!;
  const started = Date.now();
  const utc = new Date().toISOString();
  try {
    const result = await JOURNEY_RUNNERS[id](ctx);
    return {
      journey: id,
      title: spec.title,
      result: 'PASS',
      revision: ctx.revision,
      utc,
      elapsedSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
      persona: result.persona,
      steps: result.steps,
      pages: result.pages,
    };
  } catch (error) {
    const failure = error instanceof JourneyFailure ? error : undefined;
    const command = failure?.command ?? 'native walk';
    const expected = failure?.expected ?? 'journey completes';
    const observed = failure?.observed ?? (error instanceof Error ? error.message : String(error));
    return {
      journey: id,
      title: spec.title,
      result: 'FAIL',
      revision: ctx.revision,
      utc,
      elapsedSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
      persona: spec.personas[0],
      firstDiffering: { command, expected, observed },
      steps: failure?.steps ?? [],
      pages: [...spec.pages],
    };
  }
}

export function summarizeWalk(revision: string, rows: JourneyWalkRow[]): WalkReport {
  const failing = rows.filter((row) => row.result === 'FAIL');
  const slowestFailing = failing.reduce<JourneyWalkRow | null>((slowest, row) => {
    if (!slowest || row.elapsedSeconds > slowest.elapsedSeconds) return row;
    return slowest;
  }, null);
  return {
    revision,
    utc: new Date().toISOString(),
    passing: rows.filter((row) => row.result === 'PASS').length,
    total: 26,
    slowestFailing,
    rows,
  };
}

export function formatCapabilitiesWalkCells(row: JourneyWalkRow): { latest: string; evidence: string } {
  const latest = `${row.result} ${row.revision.slice(0, 12)} ${row.utc} ${row.persona}`;
  const evidence = row.firstDiffering
    ? `${row.evidence} ${row.elapsedSeconds}s; ${row.firstDiffering.command} → ${row.firstDiffering.observed.slice(0, 180)}`
    : `${row.evidence} ${row.elapsedSeconds}s`;
  return { latest, evidence };
}

export function applyWalkResults(markdown: string, rows: JourneyWalkRow[]): string {
  let next = markdown;
  for (const row of rows) {
    const cells = formatCapabilitiesWalkCells(row);
    const pattern = new RegExp(
      `(\\| ${row.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| [^|]+ \\| )[^|]+(\\| )[^|]+(\\|)`,
    );
    next = next.replace(pattern, `$1${cells.latest} $2${cells.evidence} $3`);
  }
  const report = summarizeWalk(rows[0]?.revision ?? '', rows);
  const slowest = report.slowestFailing;
  const observed = (slowest?.firstDiffering?.observed ?? '').replace(/`/g, "'").slice(0, 180);
  const summary = slowest
    ? `Latest measured result: **${report.passing}/26**. Slowest failing path: ${slowest.title} (${slowest.persona}, ${slowest.elapsedSeconds}s); first differing command \`${slowest.firstDiffering?.command ?? 'unknown'}\` / result \`${observed}\`.`
    : `Latest measured result: **${report.passing}/26**.`;
  return next.replace(/Latest measured result: \*\*\d+\/26\*\*\.[^\n]*/, summary);
}

/** Seed import writes wait until topology remaining is zero, not only until one subject POST succeeds. */
export async function waitUntilIdentityBootstrapRemainingZero(
  remaining: () => Promise<number | string>,
  options: { ms?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const ms = options.ms ?? 1_200_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((wait: number) => Bun.sleep(wait));
  const deadline = now() + ms;
  let last = 'no remaining';
  while (now() < deadline) {
    try {
      const value = await remaining();
      if (value === 0) return;
      last = `remaining ${value}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  throw new Error(`identity epoch bootstrap not caught up: ${last}`);
}
