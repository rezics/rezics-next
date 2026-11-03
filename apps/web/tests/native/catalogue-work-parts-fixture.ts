import { bundledDigest } from '@rezics/definitions/bundled';
import { candidateContext } from '../../src/subject/candidates.ts';
import { startAuthStack, type AuthJourney, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

export type WorkPartsSubject = { id: string; type: string; label: string };
type InitialSnak = { property: { id: string }; value: { type: 'value'; content: unknown } };
type InitialStatement = {
  value: { type: 'value'; content: unknown };
  qualifiers?: InitialSnak[];
  references?: { parts: InitialSnak[] }[];
};

export type NativeCatalogueWorkPartsFixture = {
  stack: NativeWebStack;
  auth: NativeAuthStack;
  alice: AuthJourney;
  series: WorkPartsSubject;
  books: WorkPartsSubject[];
  firstArc: WorkPartsSubject;
  secondArc: WorkPartsSubject;
  memberStream: { count: { value: number; exact: boolean }; caughtUp: boolean };
  close(): Promise<void>;
};

const writeRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 1000, seconds: 60 } },
  member: { write: { maximum: 1000, seconds: 60 } },
  trusted: { write: { maximum: 1000, seconds: 60 } },
  service: { write: { maximum: 1000, seconds: 60 } },
});

function snak(property: string, content: unknown): InitialSnak {
  return { property: { id: property }, value: { type: 'value', content } };
}

async function json<T>(response: Response, expectedStatus: number, label: string): Promise<T> {
  const body = await response.text();
  if (response.status !== expectedStatus)
    throw new Error(`${label} expected ${expectedStatus}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function createSubject(
  stack: NativeWebStack,
  type: string,
  label: string,
  statements: Record<string, InitialStatement[]> = {},
): Promise<WorkPartsSubject> {
  const created = await json<{ subject: { id: string; type: string } }>(
    await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` },
        body: JSON.stringify({ type, labels: { en: label }, statements }),
      },
      'editor',
    ),
    201,
    `POST /v1/subjects ${type}`,
  );
  return { id: created.subject.id, type: created.subject.type, label };
}

async function waitForMemberContinuation(
  stack: NativeWebStack,
  series: WorkPartsSubject,
): Promise<{ count: { value: number; exact: boolean }; caughtUp: boolean }> {
  const query = new URLSearchParams({
    property: 'wdt:P179',
    context: candidateContext,
    language: 'en',
    limit: '20',
  });
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const response = await stack.kernel(`/v1/subjects/${series.id}/links?${query}`);
    if (response.status === 200) {
      const page = (await response.json()) as {
        links?: unknown[];
        next?: unknown;
        count?: { value: number; exact: boolean };
        freshness?: { caught_up: boolean };
      };
      if (
        page.links?.length === 20 &&
        typeof page.next === 'string' &&
        page.next.length > 0 &&
        page.count &&
        page.freshness
      )
        return { count: page.count, caughtUp: page.freshness.caught_up };
    }
    await Bun.sleep(250);
  }
  throw new Error(`Native work-parts stream for ${series.id} did not expose its continuation`);
}

async function waitForSuggestion(stack: NativeWebStack, subject: WorkPartsSubject): Promise<void> {
  const until = Date.now() + 60_000;
  const query = `/v1/subjects:suggest?q=${encodeURIComponent(subject.label)}&limit=10&languages=en`;
  while (Date.now() < until) {
    const response = await stack.kernel(query);
    if (response.status === 200) {
      const body = (await response.json()) as { subjects?: { id: string }[] };
      if (body.subjects?.some((item) => item.id === subject.id)) return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Native suggestions did not include ${subject.type} ${subject.id} for ${subject.label}`);
}

export async function createNativeCatalogueWorkPartsFixture(): Promise<NativeCatalogueWorkPartsFixture> {
  const stack = await startNativeWebStack({ writeRateOverrides });
  let auth: NativeAuthStack | undefined;
  try {
    const active = await json<{ digest: string }>(
      await stack.kernel('/v1/definitions/active'),
      200,
      'GET /v1/definitions/active',
    );
    if (active.digest !== bundledDigest)
      throw new Error(`Native stack activated ${active.digest}; expected bundled release ${bundledDigest}.`);

    const marker = crypto.randomUUID().slice(0, 8);
    const firstArc = await createSubject(stack, 'wd:Q2620972', `Native work-parts story arc ${marker} one`);
    const secondArc = await createSubject(stack, 'wd:Q2620972', `Native work-parts story arc ${marker} two`);
    const series = await createSubject(stack, 'schema:BookSeries', `Native work-parts series ${marker}`, {
      'rezics:storyArc': [
        {
          value: { type: 'value', content: firstArc.id },
          qualifiers: [
            snak('rezics:firstPart', '1'),
            snak('rezics:lastPart', '2'),
            snak('schema:position', '1'),
          ],
          references: [
            { parts: [snak('schema:url', `https://example.org/work-parts/${marker}/arc/one`)] },
            { parts: [snak('schema:url', `https://example.org/work-parts/${marker}/arc/two`)] },
          ],
        },
      ],
    });
    const books: WorkPartsSubject[] = [];
    for (let position = 1; position <= 21; position++) {
      const label = `Native work-parts book ${marker} ${String(position).padStart(2, '0')}`;
      const references = [
        { parts: [snak('schema:url', `https://example.org/work-parts/${marker}/${position}/one`)] },
        { parts: [snak('schema:url', `https://example.org/work-parts/${marker}/${position}/two`)] },
      ];
      books.push(
        await createSubject(stack, 'schema:Book', label, {
          'wdt:P179': [
            {
              value: { type: 'value', content: series.id },
              qualifiers: [snak('schema:position', String(position))],
              references,
            },
          ],
        }),
      );
    }
    const memberStream = await waitForMemberContinuation(stack, series);

    await waitForSuggestion(stack, secondArc);

    auth = await startAuthStack(stack);
    const alice = await auth.signIn('alice');
    return {
      stack,
      auth,
      alice,
      series,
      books,
      firstArc,
      secondArc,
      memberStream,
      async close() {
        await auth?.stop();
        await stack.stop();
      },
    };
  } catch (error) {
    await auth?.stop().catch(() => {});
    await stack.stop().catch(() => {});
    throw error;
  }
}
