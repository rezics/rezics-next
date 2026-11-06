import { randomUUID } from 'node:crypto';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';

const origin = 'http://kernel.test';
const context = GLOBAL_CONTEXT;
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
      const seen = new Set<string>();
      for (;;) {
        const response = await http(
          reviewer,
          `/v1/subjects/${subjectId}/candidates?${new URLSearchParams({ property, context, limit: '100' })}`,
        );
        if (response.status !== 200)
          throw new Error(`Reviewed-tag candidate page: HTTP ${response.status}: ${JSON.stringify(response.body)}`);
        const page = response.body as {
          candidates: {
            id: string;
            head: number | null;
            retracted: number | null;
            decision?: string | null;
            statement?: { rank?: 'normal' | 'preferred' | 'deprecated' };
          }[];
          adoption: { head: number } | null;
        };
        const next = page.candidates.find(
          (candidate) => !candidate.retracted && candidate.decision !== 'rejected' && !seen.has(candidate.id),
        );
        if (next) {
          const accepted = await http(reviewer, `/v1/subjects/${subjectId}/candidates/${next.id}:accept`, {
            context,
            expected_head: next.head,
          });
          if (accepted.status !== 200)
            throw new Error(`Reviewed-tag accept: HTTP ${accepted.status}: ${JSON.stringify(accepted.body)}`);
          seen.add(next.id);
          continue;
        }
        const adopted = await http(reviewer, `/v1/subjects/${subjectId}:adopt`, {
          context,
          property,
          mode: 'replace',
          expected_head: page.adoption?.head ?? null,
          selection: page.candidates
            .filter((candidate) => !candidate.retracted && candidate.decision === 'accepted')
            .map((candidate) => ({
              candidate: candidate.id,
              rank: candidate.statement?.rank ?? 'normal',
            })),
        });
        if (adopted.status !== 200)
          throw new Error(`Reviewed-tag adopt: HTTP ${adopted.status}: ${JSON.stringify(adopted.body)}`);
        return;
      }
    }

    return {
      origin,
      driver,
      fixtures,
      importer,
      reviewer,
      importTransport,
      publicClient,
      pool: fixtures.pool,
      request: dispatch,
      editor: {
        http: (path: string, body?: unknown) => http(reviewer, path, body),
      },
      acceptAndAdopt,
      close: () => driver.close(),
    };
  } catch (error) {
    await driver.close();
    throw error;
  }
}

export type ReviewedTagRuntime = Awaited<ReturnType<typeof openReviewedTagRuntime>>;
export type { SemanticOutcomeDriver };
