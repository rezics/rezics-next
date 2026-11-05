import { createHash } from 'node:crypto';
import { expect } from 'bun:test';
import type { Page } from 'playwright';
import { fromPlainText } from '@rezics/document';
import { createSourceRegistration } from '../../../../services/importer/src/source-registry.ts';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { m } from '../../src/paraglide/messages.js';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  acceptCatalogueReviewCandidate,
  adoptCatalogueReviewSelection,
  catalogueReviewProperty,
  grantCatalogueReviewAuthority,
  listCatalogueReviewCandidates,
} from './catalogue-review-fixture.ts';
import { nativeTest } from './lifecycle.ts';
import { startNativeWebStack, type NativeKernelRequest, type NativeWebStack } from './stack.ts';

type Json = Record<string, unknown>;
type NativeSubject = { id: string; label: string; path: string };

async function command<T extends Json>(
  stack: NativeWebStack,
  path: string,
  body: unknown,
  persona: string,
  expected: number,
): Promise<T> {
  const response = await stack.kernel(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify(body),
    },
    persona,
  );
  const text = await response.text();
  if (response.status !== expected) throw new Error(`${path} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function grant(stack: NativeWebStack, persona: string, actions: string[]): Promise<void> {
  const { accountId } = await stack.authPersona(persona);
  await command<Json>(
    stack,
    '/v1/grants',
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: accountId },
      actions,
      valid: '(,)',
    },
    'governor',
    201,
  );
}

async function createSubject(stack: NativeWebStack, label: string, statements?: unknown): Promise<NativeSubject> {
  const body = await command<{ subject: { id: string } }>(
    stack,
    '/v1/subjects',
    {
      type: 'schema:Book',
      labels: { en: label },
      ...(statements ? { statements } : {}),
    },
    'editor',
    201,
  );
  const id = body.subject.id;
  return { id, label, path: subjectHref({ id, label }, 'en').href };
}

function sourceTuple(source: string, externalId: string, revision: string, converter: string, value: string) {
  return {
    source,
    external_id: externalId,
    record_revision: revision,
    digest: createHash('sha256').update(`${source}:${externalId}:${value}`).digest('hex'),
    converter_revision: converter,
    field_group: 'facts',
  };
}

async function proposeLanguage(
  stack: NativeWebStack,
  subject: NativeSubject,
  source: ReturnType<typeof sourceTuple>,
  value: string,
  citation: { property: string; value: { type: 'value'; content: string } },
): Promise<string> {
  const response = await stack.kernel(
    '/v1/subjects:batchWrite',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commands: [
          {
            op: 'propose',
            key: crypto.randomUUID(),
            source,
            subject: subject.id,
            statement: {
              property: { id: catalogueReviewProperty },
              value: { type: 'value', content: value },
              references: [
                {
                  parts: [
                    {
                      property: { id: citation.property },
                      value: citation.value,
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    },
    'alice',
  );
  const text = await response.text();
  if (response.status !== 200) throw new Error(`Native imported proposal returned ${response.status}: ${text}`);
  const result = (JSON.parse(text) as { results: { value?: { candidate?: unknown } }[] }).results[0]?.value?.candidate;
  if (typeof result !== 'string') throw new Error(`Native imported proposal returned no candidate: ${text}`);
  return result;
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

function requestsForSubject(requests: readonly NativeKernelRequest[], id: string): NativeKernelRequest[] {
  return requests.filter(
    (request) =>
      !request.fixtureRequest && new URL(request.url, 'http://native.test').pathname === `/v1/subjects/${id}`,
  );
}

nativeTest(
  'the anonymous Sources route reads current selected support and keeps provenance, rights, and failures distinct',
  900_000,
  async () => {
    const stack = await startNativeWebStack();
    let auth: NativeAuthStack | undefined;
    let page: Page | undefined;
    try {
      auth = await startAuthStack(stack);
      await grantCatalogueReviewAuthority(stack);
      await grant(stack, 'alice', ['subject:batch_write']);

      // Real authored proposals, acceptance and adoption precede the mounted public reading.
      const reading = await createSubject(stack, `Native synopsis ${crypto.randomUUID().slice(0, 8)}`);
      const synopsisIds: string[] = [];
      const citations = ['https://example.org/first-synopsis', 'https://example.org/second-synopsis', null];
      for (const [index, citation] of citations.entries()) {
        const proposal = await command<{ candidate: string }>(
          stack,
          `/v1/subjects/${reading.id}/candidates`,
          {
            statement: {
              property: { id: 'schema:abstract' },
              value: {
                type: 'value',
                content: {
                  document: fromPlainText(`Native synopsis ${index + 1}.`),
                  licence: 'CC-BY-4.0',
                  language: 'en',
                },
              },
              references: citation
                ? [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] }]
                : [],
            },
          },
          'alice',
          201,
        );
        synopsisIds.push(proposal.candidate);
        await acceptCatalogueReviewCandidate(stack, reading.id, proposal.candidate, null, 'bob');
      }
      const candidateResponse = await stack.kernel(
        `/v1/subjects/${reading.id}/candidates?${new URLSearchParams({ property: 'schema:abstract', context: GLOBAL_CONTEXT })}`,
        {},
        'bob',
      );
      expect(candidateResponse.status).toBe(200);
      const currentAdoption = (await candidateResponse.json()) as { adoption: { head: number | null } };
      await command(
        stack,
        `/v1/subjects/${reading.id}:adopt`,
        {
          context: GLOBAL_CONTEXT,
          property: 'schema:abstract',
          mode: 'replace',
          selection: synopsisIds.map((candidate) => ({ candidate, rank: 'preferred' })),
          expected_head: currentAdoption.adoption.head,
        },
        'bob',
        200,
      );
      const currentResponse = await stack.kernel(`/v1/subjects/${reading.id}`);
      expect(currentResponse.status).toBe(200);
      const current = (await currentResponse.json()) as {
        subject: {
          context: string;
          release: string;
          statements: Record<
            string,
            { id: string; value: { content: { document: string; digest: string; language: string } } }[]
          >;
        };
      };
      for (const persona of ['anonymous', 'alice'] as const) {
        const exactPage = await (await auth.context(persona)).newPage();
        try {
          for (const index of [1, 2]) {
            const candidate = current.subject.statements['schema:abstract']!.find(
              (row) => row.id === synopsisIds[index],
            )!;
            const binding = candidate.value.content;
            const response = await exactPage.goto(`${stack.web}${reading.path}`, { waitUntil: 'domcontentloaded' });
            expect(response?.status()).toBe(200);
            await hydrate(exactPage);
            await exactPage.getByLabel(m.subject_synopsis_choice(), { exact: true }).selectOption(candidate.id);
            const entry = exactPage
              .locator('#subject-summary-evidence')
              .getByRole('link', { name: m.subject_synopsis_evidence(), exact: true });
            if (index === 1) await entry.click();
            else
              await exactPage.goto(new URL((await entry.getAttribute('href'))!, stack.web).href, {
                waitUntil: 'domcontentloaded',
              });
            await hydrate(exactPage);
            const detail = exactPage.locator('[data-slot="subject-sources-detail"]');
            await detail.waitFor({ state: 'visible' });
            const text = await detail.innerText();
            expect(text).not.toContain(citations[0]!);
            if (index === 1) expect(text).toContain(citations[1]!);
            else {
              expect(text).toContain(m.sources_no_citations());
              expect(text).not.toContain(citations[1]!);
            }
            for (const secret of [binding.document, binding.digest, `Native synopsis ${index + 1}.`])
              expect(await detail.innerHTML()).not.toContain(secret);
            await exactPage.getByRole('link', { name: m.subject_synopsis_return(), exact: true }).click();
            await hydrate(exactPage);
            await exactPage
              .locator('#subject-summary-reading')
              .getByText(`Native synopsis ${index + 1}.`, { exact: true })
              .waitFor({ state: 'visible' });
            expect(await exactPage.getByLabel(m.subject_synopsis_choice(), { exact: true }).inputValue()).toBe(
              candidate.id,
            );
          }
        } finally {
          await exactPage.close();
        }
      }

      const subject = await createSubject(stack, `Native Sources ${crypto.randomUUID().slice(0, 8)}`, {
        'schema:url': [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://example.org/catalogue-sources/book' },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://example.org/catalogue-sources/url-citation' },
                  },
                ],
              },
            ],
          },
        ],
      });

      const bangumi = createSourceRegistration('bangumi');
      const bangumiMetadata = bangumi.describeSourceRecord!('17');
      const { name, url, licence } = bangumiMetadata;
      const metadata = { name, url, licence };
      const metadataWrite = await stack.kernel(
        '/v1/source-records:setMetadata',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
          },
          body: JSON.stringify({
            source: bangumi.source,
            external_id: '17',
            metadata,
            expected_metadata_revision: null,
          }),
        },
        'alice',
      );
      const metadataText = await metadataWrite.text();
      if (metadataWrite.status !== 201)
        throw new Error(`Native source metadata fixture returned ${metadataWrite.status}: ${metadataText}`);

      const japanese = await proposeLanguage(
        stack,
        subject,
        sourceTuple(bangumi.source, '17', '1', bangumi.converter_revision, 'ja'),
        'ja',
        { property: 'schema:author', value: { type: 'value', content: crypto.randomUUID() } },
      );
      const wikidata = createSourceRegistration('wikidata');
      const korean = await proposeLanguage(
        stack,
        subject,
        sourceTuple(wikidata.source, 'Q42', '1', wikidata.converter_revision, 'ko'),
        'ko',
        {
          property: 'schema:url',
          value: { type: 'value', content: 'https://example.org/catalogue-sources/korean-citation' },
        },
      );
      await acceptCatalogueReviewCandidate(stack, subject.id, japanese, null, 'bob');
      await acceptCatalogueReviewCandidate(stack, subject.id, korean, null, 'bob');
      let comparison = await listCatalogueReviewCandidates(stack, subject.id);
      await adoptCatalogueReviewSelection(
        stack,
        subject.id,
        [{ candidate: japanese, rank: 'preferred' }],
        comparison.adoption.head,
        'bob',
      );

      page = await (await auth.context('anonymous')).newPage();
      page.setDefaultTimeout(60_000);
      const sourcesUrl = `${stack.web}${subject.path}/sources?view=selected`;
      const firstReadsStart = stack.kernelRequests().length;
      let response = await page.goto(sourcesUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await hydrate(page);

      await page
        .locator('[data-slot="subject-sources-detail"][data-source-reader="signed-out"]')
        .waitFor({ state: 'visible' });
      const noCitationField = page
        .locator('[data-slot="source-property"]')
        .filter({ hasText: m.sources_no_citations() });
      expect(await noCitationField.count()).toBe(1);
      expect(await noCitationField.innerText()).toContain('Japanese');
      const urlField = page
        .locator('[data-slot="source-property"]')
        .filter({ hasText: 'https://example.org/catalogue-sources/url-citation' });
      expect(await urlField.count()).toBe(1);
      const urlFieldText = await urlField.innerText();
      expect(urlFieldText).toContain('https://example.org/catalogue-sources/url-citation');
      expect(urlFieldText).not.toContain(url);
      const metadataSection = page.locator('[data-slot="subject-sources"]');
      expect(await metadataSection.innerText()).toContain('CC-BY-SA-3.0');
      const firstText = await page.locator('body').innerText();
      expect(firstText).toContain(m.sources_attribution_unknown());
      expect(firstText).toContain(m.sources_cover_unknown());
      expect(await page.locator('[data-candidate-item]').count()).toBe(0);
      expect(await page.getByRole('link', { name: m.correction_title(), exact: true }).count()).toBe(0);

      const contributor = await (await auth.context('alice')).newPage();
      contributor.setDefaultTimeout(60_000);
      await contributor.goto(sourcesUrl, { waitUntil: 'domcontentloaded' });
      await hydrate(contributor);
      const cited = contributor
        .locator('[data-slot="source-property"]')
        .filter({ hasText: 'https://example.org/catalogue-sources/url-citation' });
      const compare = cited.getByRole('link', { name: m.sources_compare(), exact: true });
      await compare.waitFor({ state: 'visible' });
      const compareAddress = new URL((await compare.getAttribute('href'))!, stack.web);
      expect(compareAddress.searchParams.get('candidateField')).toBe('schema:url');
      expect(compareAddress.searchParams.get('sourceStatement')).toBeTruthy();
      await compare.click();
      await contributor.getByRole('button', { name: m.candidate_entry(), exact: true }).click();
      await contributor.locator('#candidate-review select').first().waitFor({ state: 'visible' });
      await contributor.getByRole('link', { name: m.correction_title(), exact: true }).click();
      await contributor
        .getByLabel(m.correction_url(), { exact: true })
        .first()
        .fill('https://example.org/catalogue-sources/proposed');
      await contributor.getByRole('button', { name: m.correction_submit(), exact: true }).click();
      await contributor.getByText(m.correction_proposed(), { exact: true }).waitFor({ state: 'visible' });
      await contributor.getByRole('link', { name: m.subject_sources(), exact: true }).first().click();
      await hydrate(contributor);
      await contributor
        .locator('[data-slot="source-property"]')
        .filter({ hasText: 'https://example.org/catalogue-sources/url-citation' })
        .waitFor({ state: 'visible' });
      expect(
        await contributor
          .locator('[data-slot="source-statement"]')
          .filter({ hasText: 'https://example.org/catalogue-sources/proposed' })
          .count(),
      ).toBe(0);
      await contributor.close();

      await stack.refreshKernelRequests();
      const firstReads = requestsForSubject(stack.kernelRequests().slice(firstReadsStart), subject.id);
      expect(firstReads.length).toBeGreaterThan(0);
      expect(firstReads.every((request) => request.authorization === null)).toBe(true);
      expect(firstReads.every((request) => request.responseStatus === 200)).toBe(true);

      comparison = await listCatalogueReviewCandidates(stack, subject.id);
      await adoptCatalogueReviewSelection(
        stack,
        subject.id,
        [{ candidate: korean, rank: 'normal' }],
        comparison.adoption.head,
        'bob',
      );
      response = await page.goto(sourcesUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await hydrate(page);
      await page
        .locator('[data-slot="subject-sources-detail"][data-source-reader="signed-out"]')
        .waitFor({ state: 'visible' });
      const currentField = page
        .locator('[data-slot="source-property"]')
        .filter({ hasText: 'https://example.org/catalogue-sources/korean-citation' });
      expect(await currentField.count()).toBe(1);
      expect(await currentField.innerText()).toContain('Korean');
      const currentText = await page.locator('body').innerText();
      expect(currentText).not.toContain('Japanese');
      expect(currentText).not.toContain(url);
      expect(currentText).toContain(m.sources_metadata_unavailable());

      await stack.injectKernelFailureOnce({
        method: 'GET',
        path: `/v1/subjects/${subject.id}`,
        status: 503,
        body: JSON.stringify({
          type: 'https://rezics.com/problems/overloaded',
          title: 'Overloaded',
          status: 503,
          code: 'overloaded',
          retryable: true,
          effect_status: 'not_applied',
          request_id: crypto.randomUUID(),
        }),
      });
      response = await page.goto(sourcesUrl, { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      await hydrate(page);
      const failedText = await page.locator('body').innerText();
      expect(failedText).toContain(m.sources_unavailable());
      expect(failedText).not.toContain(m.sources_no_citations());
      await stack.refreshKernelRequests();
      expect(
        requestsForSubject(stack.kernelRequests(), subject.id).some((request) => request.responseStatus === 503),
      ).toBe(true);

      const hidden = await createSubject(stack, `Concealed Sources ${crypto.randomUUID().slice(0, 8)}`);
      await grant(stack, 'steward', ['moderation:hide']);
      await command(
        stack,
        `/v1/subjects/${hidden.id}:hide`,
        { reason: 'Native Sources concealment fixture' },
        'steward',
        200,
      );
      const concealed = await stack.request(`${stack.web}${hidden.path}/sources`);
      expect(concealed.status).toBe(404);
      expect(await concealed.text()).not.toContain(hidden.label);

      const missingPath = subjectHref({ id: crypto.randomUUID(), label: 'Missing Sources' }, 'en').href;
      const missing = await stack.request(`${stack.web}${missingPath}/sources`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain(m.not_found_message());

      await grant(stack, 'bob', ['subject:merge', 'subject:read', 'gate:subject_identity']);
      const mergeSubjects = [
        await createSubject(stack, 'Sources merge first'),
        await createSubject(stack, 'Sources merge second'),
      ];
      const labels = new Map(mergeSubjects.map(({ id, label }) => [id, label]));
      const ids = mergeSubjects.map(({ id }) => id).sort();
      await command(stack, '/v1/subjects:merge', { subjects: ids }, 'bob', 200);
      const [survivor, redirected] = ids as [string, string];
      const redirectedPath = `${subjectHref({ id: redirected, label: labels.get(redirected)! }, 'en').href}/sources`;
      const survivorPath = `${subjectHref({ id: survivor, label: labels.get(survivor)! }, 'en').href}/sources`;
      const mergePage = await (await auth.context('anonymous')).newPage();
      mergePage.setDefaultTimeout(60_000);
      response = await mergePage.goto(`${stack.web}${redirectedPath}?keep=selected#candidate-review`, {
        waitUntil: 'domcontentloaded',
      });
      expect(response?.status()).toBe(200);
      await hydrate(mergePage);
      const canonical = new URL(mergePage.url());
      expect(canonical.pathname).toBe(survivorPath);
      expect(canonical.search).toBe('?keep=selected');
      expect(canonical.hash).toBe('#candidate-review');
      await mergePage.close();
    } finally {
      await page?.close().catch(() => {});
      await auth?.stop().catch(() => {});
      await stack.stop();
    }
  },
);
