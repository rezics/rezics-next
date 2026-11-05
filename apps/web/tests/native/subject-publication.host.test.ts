import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startSubjectPublicationFixture, type SubjectPublicationFixture } from './subject-publication-fixture.ts';

let fixture: SubjectPublicationFixture;
beforeAll(async () => {
  fixture = await startSubjectPublicationFixture();
}, 300_000);
afterAll(async () => fixture && fixture.close(), 180_000);

describe('native subject publication', () => {
  test('released subject data reaches the anonymously served page, source credit, and subject sitemap', async () => {
    const { stack, auth, subject } = fixture;
    const signedIn = await auth.signIn('editor');
    expect(signedIn.url).toStartWith(stack.web);
    expect((await signedIn.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);

    const response = await stack.request(`${stack.web}${subject.path}`, 'anonymous');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<title>${subject.label}`);
    expect(html).toContain(`href="https://rezics.example.test${subject.path}"`);
    expect(html).not.toContain('Withheld Publication Sentinel');
    expect(html).not.toContain('Private Publication Sentinel');

    const read = await stack.kernel(`/v1/subjects/${encodeURIComponent(subject.id)}`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      subject: { sourceRecords?: unknown[] };
      summary: {
        cover?: { credit?: { rightsHolder: string; via?: { name: string; url?: string }; license?: string } } | null;
      };
    };
    // These values must arrive from the production subject read and its original imported cover.
    expect(body.subject.sourceRecords).toBeDefined();
    expect(body.summary?.cover?.credit?.rightsHolder).toBeTruthy();
    expect(body.summary?.cover?.credit?.via?.name).toBeTruthy();

    const feed = await stack.kernel('/v1/subject-pages?limit=1000');
    expect(feed.status).toBe(200);
    const page = (await feed.json()) as {
      subjectPages: { id: string; labels: { language: string; value: string }[] }[];
      next: string | null;
    };
    expect(page.subjectPages.some(({ id }) => id === subject.id)).toBe(true);
    expect(page.next).toBeNull();

    const index = await stack.request(`${stack.web}/sitemap.xml`, 'anonymous');
    expect(index.status).toBe(200);
    const indexXml = await index.text();
    const subjectShards = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => match[1]!)
      .filter((url) => new URL(url).pathname.includes('/sitemap-subjects-'));
    expect(subjectShards.length).toBeGreaterThan(0);
    const responses = await Promise.all(subjectShards.map((url) => stack.request(url, 'anonymous')));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const shardXml = await Promise.all(responses.map((response) => response.text()));
    expect(shardXml.some((xml) => xml.includes(`https://rezics.example.test${subject.path}`))).toBe(true);
    expect(shardXml.join('\n')).not.toContain('Withheld Publication Sentinel');
    expect(shardXml.join('\n')).not.toContain('Private Publication Sentinel');
  }, 900_000);
});
