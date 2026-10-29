import { afterAll, beforeAll, expect, test } from 'bun:test';
import { slug } from '@rezics/definitions/slug';
import { definitionPath, missingId, page, startPagesWorker } from './support/pages-worker-fixture.ts';

let worker: Awaited<ReturnType<typeof startPagesWorker>> | undefined;
const subjectPath = `${page.subject}/${slug(page.reads.r0.body.subject.labels.en)}`;
beforeAll(async () => {
  worker = await startPagesWorker();
}, 180_000);
afterAll(async () => {
  await worker?.stop();
}, 30_000);

// Examine only HTTP-delivered body markup, excluding serialized loader data and all scripts.
// No browser, hydration, React DOM/server call or substitute renderer participates in this proof.
function mainMarkup(html: string) {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1];
  expect(main).toBeDefined();
  return main!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

function aggregateSince(start: number, id: string) {
  const calls = worker!.calls.slice(start);
  const aggregate = calls.filter(({ path }) => path === '/v1/pages:read');
  expect(aggregate.map(({ method, body }) => ({ method, body }))).toEqual([
    { method: 'POST', body: { target: { subject: id }, languages: ['en'] } },
  ]);
  expect(aggregate[0]!.language).toBe('en');
  // Reaction counts and public collections are normal separate reads; standalone subjects/facts must never fill in the page.
  expect(
    calls.filter(
      ({ path }) =>
        ![
          '/v1/pages:read',
          '/v1/definitions/active',
          definitionPath,
          `/v1/subjects/${id}`,
          `/v1/subjects/${id}/reactions`,
          `/v1/subjects/${id}/collections`,
          `/v1/subjects/${id}/ratings`,
          `/v1/subjects/${id}/source-statistics`,
        ].includes(path),
    ),
  ).toEqual([]);
  expect(calls.every(({ authorization, cookie }) => authorization === null && cookie === null)).toBe(true);
}

test('the real Workers SSR path renders the Puck composition before client JavaScript', async () => {
  await worker!.verify(async () => {
    const start = worker!.calls.length;
    const { response, html } = await worker!.request(subjectPath);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).not.toMatch(/<html[^>]*data-hydrated/);
    const main = mainMarkup(html);
    const header = /<header\b[^>]*>([\s\S]*?)<\/header>/.exec(main)?.[1];
    expect(header).toBeDefined();
    expect(header!).toMatch(/<h1\b[^>]*>The Little Prince<\/h1>/);
    expect(header!).toContain('data-slot="subject-creators"');
    expect(header!).toMatch(/<button\b[^>]*aria-label="More actions"[^>]*>/);
    expect(header!).not.toContain(page.reads.r0.body.subject.descriptions.en);
    expect(main).toContain(
      'A pilot stranded in the Sahara meets a small prince who has left his asteroid, and learns from him what matters.',
    );
    // The recorded template nests SubjectHeader and the actions Slot inside the header Slot.
    expect(structuredClone(page.document.content[0])).toMatchObject({
      type: 'Slot',
      props: { name: 'header', children: [{ type: 'SubjectHeader' }, { type: 'Slot', props: { name: 'actions' } }] },
    });
    const landmarks = [
      '<h1',
      'data-slot="subject-creators"',
      'aria-label="More actions"',
      '</header>',
      'A pilot stranded in the Sahara meets a small prince',
      '<dl data-slot="subject-facts"',
      '>Editions</h2>',
    ];
    let previous = -1;
    for (const landmark of landmarks) {
      const index = main.indexOf(landmark);
      expect(index, landmark).toBeGreaterThan(previous);
      previous = index;
    }
    expect(main).not.toContain('data-rfd-droppable-id');
    expect(html).not.toContain(worker!.privateSentinel);
    aggregateSince(start, page.subject);
  });
}, 60_000);

test('Workers HTML and JSON-LD use the same aggregate public subject representation', async () => {
  await worker!.verify(async () => {
    const start = worker!.calls.length;
    const { response, html } = await worker!.request(subjectPath);
    expect(response.status).toBe(200);
    const main = mainMarkup(html);
    const scripts = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const jsonLd = JSON.parse(scripts[0]![1]!);
    const { subject, related } = page.reads.r0.body;
    const author = subject.statements['schema:author'][0]!.value.content;
    const authorLabel = related[author as keyof typeof related].labels.en;
    expect(structuredClone(jsonLd)).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Book',
      '@id': `https://rezics.com/id/${subject.id}`,
      url: `https://rezics.com/en/subjects/${subject.id}/${slug(subject.labels.en)}`,
      name: subject.labels.en,
      description: subject.descriptions.en,
      author: { '@id': `https://rezics.com/id/${author}`, name: authorLabel },
      datePublished: '1943-04-06',
    });
    expect(main).toMatch(new RegExp(`<h1[^>]*>${jsonLd.name}</h1>`));
    expect(main).toContain(`href="/en/subjects/${author}/${encodeURIComponent(slug(authorLabel))}"`);
    expect(main).toContain(`>${authorLabel}</a>`);
    expect(main).toContain('>Author</');
    expect(main).toContain('April 6, 1943');
    expect(html).not.toContain(worker!.privateSentinel);
    expect(JSON.stringify(jsonLd)).not.toContain(worker!.privateSentinel);
    aggregateSince(start, page.subject);

    const missingStart = worker!.calls.length;
    const absent = await worker!.request(missingId);
    expect(absent.response.status).toBe(404);
    expect(mainMarkup(absent.html)).toContain('Page not found');
    expect(absent.html).not.toContain('application/ld+json');
    expect(absent.html).not.toContain(worker!.privateSentinel);
    expect(absent.html).not.toContain(subject.labels.en);
    const missingCalls = worker!.calls.slice(missingStart);
    expect(missingCalls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: `/v1/subjects/${missingId}` },
    ]);
    expect(missingCalls.every(({ authorization, cookie }) => authorization === null && cookie === null)).toBe(true);
  });
}, 60_000);
