import { randomUUID } from 'node:crypto';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { ShowcaseJournal } from '../../../importer/src/showcase-publication.ts';
import { reviewReviewedTagProperty } from '../../../importer/src/showcase-tags.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';

const origin = 'http://kernel.test';
type Account = { accountId: string; bearer: string };

async function jsonResponse(response: Response): Promise<HttpResponse> {
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** Recreate each attempt so a consumed body cannot poison the 503 retry. */
function kernelRequest(path: string, body: unknown, bearer: string | undefined, key: string): Request {
  return new Request(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined
        ? {}
        : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Shared Auth registration for reviewed-tag native scenarios.
 * Accounts retains the Auth producer; this caller only consumes fixtures.handle / person / grantAccount.
 */
export async function openReviewedTagRuntime() {
  const driver = await createSemanticDriver();
  const { fixtures } = driver;
  let journal: ShowcaseJournal | undefined;
  try {
    const importer = await fixtures.person('reviewed-tag-importer');
    const reviewer = await fixtures.person('reviewed-tag-reviewer');
    await fixtures.grantAccount(importer, [
      'subject:batch_write',
      'statement:propose',
      'source_fence:read',
      'subject:read',
      'media:import_from_url',
    ]);
    await fixtures.grantAccount(reviewer, [
      'context:accept',
      'context:adopt',
      'statement:propose',
      'source_fence:takedown',
      'access:grant',
      'subject:read',
    ]);
    const tierKey = randomUUID();
    const tier = await fixtures.send(
      fixtures.governor,
      'POST',
      `/v1/accounts/${importer.accountId}:setRateTier`,
      { key: tierKey, tier: 'service' },
      { 'Idempotency-Key': JSON.stringify(tierKey) },
    );
    if (tier.status !== 200)
      throw new Error(`Reviewed-tag service tier setup: HTTP ${tier.status}: ${JSON.stringify(tier.body)}`);

    async function dispatch(path: string, body?: unknown, bearer?: string, key = randomUUID()): Promise<Response> {
      const sendOnce = () => fixtures.handle(kernelRequest(path, body, bearer, key));
      let response = await sendOnce();
      for (let attempt = 1; response.status === 503 && attempt < 3; attempt++) {
        await response.body?.cancel();
        await Bun.sleep(1000);
        response = await sendOnce();
      }
      return response;
    }

    const importFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const incoming = new Request(input, init);
        const url = new URL(incoming.url);
        const headers = new Headers(incoming.headers);
        const method = incoming.method;
        const hasBody = method !== 'GET' && method !== 'HEAD';
        const body = hasBody ? await incoming.text() : undefined;
        const sendOnce = () =>
          fixtures.handle(
            new Request(`${origin}${url.pathname}${url.search}`, {
              method,
              headers,
              ...(body === undefined ? {} : { body }),
            }),
          );
        let response = await sendOnce();
        for (let attempt = 1; response.status === 503 && attempt < 3; attempt++) {
          await response.body?.cancel();
          await Bun.sleep(1000);
          response = await sendOnce();
        }
        return response;
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const importTransport = createImportTransport({
      origin,
      tokenProvider: async () => importer.bearer,
      importFetch,
    });
    const reviewTransport = createImportTransport({
      origin,
      tokenProvider: async () => reviewer.bearer,
      importFetch,
    });
    journal = new ShowcaseJournal(':memory:');
    const publicClient = createPublicBulkClient({
      origin,
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          const url = new URL(String(input instanceof Request ? input.url : input));
          return dispatch(`${url.pathname}${url.search}`);
        },
        { preconnect: fetch.preconnect },
      ),
    });

    async function http(account: Account, path: string, body?: unknown): Promise<HttpResponse> {
      return jsonResponse(await dispatch(path, body, account.bearer));
    }

    async function acceptAndAdopt(subjectId: string, property: string): Promise<void> {
      await reviewReviewedTagProperty(reviewTransport, journal!, subjectId, property);
    }

    return {
      origin,
      driver,
      fixtures,
      importer,
      reviewer,
      importTransport,
      review: reviewTransport,
      journal: journal!,
      publicClient,
      pool: fixtures.pool,
      request: dispatch,
      editor: {
        http: (path: string, body?: unknown) => http(reviewer, path, body),
      },
      acceptAndAdopt,
      close: async () => {
        journal!.close();
        await driver.close();
      },
    };
  } catch (error) {
    journal?.close();
    await driver.close();
    throw error;
  }
}

export type ReviewedTagRuntime = Awaited<ReturnType<typeof openReviewedTagRuntime>>;
export type { SemanticOutcomeDriver };
