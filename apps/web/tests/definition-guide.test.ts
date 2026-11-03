import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { releaseDigest, type Release } from '@rezics/definitions';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  definitionGuideHref,
  definitionText,
  fetchGuideRelease,
  guideReturnTo,
  readGuide,
} from '../src/features/catalogue/definition-guide';
import { DefinitionGuideContent, DefinitionGuideLink } from '../src/features/catalogue/definition-guide-view';
import { definitionGuideFixture, historicalGuideDigest } from '../src/kernel/fake/definition-guide';
import { statementFixture } from '../src/kernel/fake/catalogue-statements';
import { statementInput, validateStatement } from '../src/features/catalogue/statement-editor';
import { m } from '../src/paraglide/messages.js';

test('Understand released Types and fields before contributing a valid fact through the declared native contract with truthful authority and failure states', async () => {
  const fixture = statementFixture();
  const initial = await fixture.editor.read();
  if (!initial.ok || !initial.source) throw new Error('Expected selected fact');
  const original = structuredClone(initial.source);
  const address = { type: initial.public.subject.type, property: fixture.address.property };
  const guideFixture = definitionGuideFixture();
  const guide = await guideFixture.transport.exact('en', address.type);
  if (!guide.ok) throw new Error('Expected released Type descriptor');
  expect(guide.descriptor.definition.properties).toContain(address.property);
  expect(guide.descriptor.properties[address.property]!.datatype).toBe('time');
  const author = guide.descriptor.properties['schema:author'];
  expect(author).toBeDefined();
  for (const id of author!.qualifiers) expect(guide.descriptor.properties[id]).toBeDefined();
  const matches = await guideFixture.transport.directory('en', 'book');
  expect(matches.ok && matches.page.types.some((type) => type.typeId === address.type)).toBe(true);
  expect(guideFixture.calls[0]!.path).toBe(`/v1/definitionTypes/${address.type}`);
  expect(guideFixture.calls.some((call) => call.path === '/v1/definitionTypes')).toBe(true);
  expect(guideFixture.calls.some((call) => call.path === '/v1/definitions/active')).toBe(false);
  expect(
    guideFixture.calls
      .filter((call) => call.path.startsWith('/v1/definitions/releases/'))
      .every((call) => call.path === `/v1/definitions/releases/${guide.descriptor.releaseDigest}`),
  ).toBe(true);
  const statement = statementInput(initial.source);
  statement.value = {
    type: 'value',
    content: {
      time: '+1946-04-06T00:00:00Z',
      precision: 11,
      calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
    },
  };
  expect(validateStatement(statement, initial.release)).toEqual([]);
  expect(validateStatement({ ...statement, references: [] }, initial.release)).toContainEqual({
    pointer: '/statement/references',
    code: 'required',
  });
  const result = await fixture.editor.propose({ id: fixture.id, key: crypto.randomUUID(), statement });
  expect(result.ok && result.kind).toBe('proposed-awaiting-review');
  expect(fixture.publicRead.subject.statements[address.property]![0]).toEqual(original);
  const write = fixture.calls.find((call) => call.method === 'POST')!;
  expect(write.path).toBe(`/v1/subjects/${fixture.id}/candidates`);
  expect(write.body).toEqual({ statement });
  expect(write.authorization).toBe('Bearer fixture');
  expect(write.key).toBeTruthy();
  const denied = await statementFixture('denied').editor.propose({
    id: fixture.id,
    key: crypto.randomUUID(),
    statement,
  });
  expect(denied).toEqual({ ok: false, reason: 'denied' });
});

test('reads the exact historical release without an active lookup and retains language fallback and emitted constraints', async () => {
  const fixture = definitionGuideFixture('pinned');
  const guide = await fixture.transport.read();
  if (!guide.ok) throw new Error('Expected historical release');
  expect(guide.pin).toBe('pinned');
  expect(guide.release.digest).toBe(historicalGuideDigest);
  const { digest, ...surface } = guide.release;
  // The fixture has the full historical release, including its original compiler metadata.
  expect(releaseDigest(surface as Release)).toBe(digest);
  expect(fixture.calls.map((call) => call.path)).toEqual([`/v1/definitions/releases/${historicalGuideDigest}`]);
  expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
  expect(guide.release.properties['schema:cookTime']!.units).toEqual(['http://www.wikidata.org/entity/Q7727']);
  expect(definitionText({ en: 'meaning' }, 'ja')).toEqual({ text: 'meaning', lang: 'en' });
  const html = renderToStaticMarkup(
    createElement(DefinitionGuideContent, { address: fixture.address, locale: 'ja', read: guide, retry: () => {} }),
  );
  expect(html).toContain('min');
  expect(html).toContain(m.guide_integer({}, { locale: 'ja' }));
  expect(html).toContain(m.guide_pinned({}, { locale: 'ja' }));
  expect(html).toContain(m.guide_missing({}, { locale: 'ja' }));
  const current = definitionGuideFixture();
  const currentRelease = await fetchGuideRelease(current.client);
  const pinned = (address: { type: string; property: string }) =>
    readGuide(
      { ...address, release: currentRelease.digest },
      (digest) => fetchGuideRelease(current.client, digest),
      async () => ({ ok: true as const, page: { types: [], next: null } }),
      async () => ({ ok: false as const, reason: 'no-match' as const }),
    );
  const consentAddress = { type: 'schema:Person', property: 'rezics:penNameOf' };
  const consent = await pinned(consentAddress);
  if (!consent.ok) throw new Error('Expected released consent field');
  const consentHtml = renderToStaticMarkup(
    createElement(DefinitionGuideContent, { address: consentAddress, locale: 'en', read: consent, retry: () => {} }),
  );
  expect(consentHtml).toContain(m.guide_consent({}, { locale: 'en' }));
  expect(consentHtml).toContain(m.guide_targets({}, { locale: 'en' }));
  const authorAddress = { type: 'schema:Book', property: 'schema:author' };
  const author = await pinned(authorAddress);
  const authorHtml = renderToStaticMarkup(
    createElement(DefinitionGuideContent, { address: authorAddress, locale: 'en', read: author, retry: () => {} }),
  );
  expect(authorHtml).toContain('person');
  expect(authorHtml).toContain('position');
  expect(authorHtml).toContain(m.guide_qualifiers({}, { locale: 'en' }));
});

test('native read failures never become empty metadata or fall back from a pin; help returns only to the real editor', async () => {
  for (const [status, reason] of [
    [401, 'denied'],
    [403, 'concealed'],
    [404, 'concealed'],
    [503, 'unavailable'],
  ] as const) {
    const calls: Request[] = [];
    const client = createKernelClient('https://guide-failures.test', {
      fetch: (async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        calls.push(request);
        return Response.json({ code: 'not_found' }, { status });
      }) as typeof fetch,
    });
    expect(
      await readGuide(
        { release: historicalGuideDigest },
        (digest) => fetchGuideRelease(client, digest, { authorization: 'Bearer current-viewer' }),
        async () => ({ ok: true as const, page: { types: [], next: null } }),
        async () => ({ ok: false as const, reason: 'no-match' as const }),
      ),
    ).toEqual({ ok: false, reason });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-viewer');
  }
  const invalid = definitionGuideFixture('invalid');
  expect(await invalid.transport.read()).toEqual({ ok: false, reason: 'invalid' });
  const empty = definitionGuideFixture('empty');
  const emptyRead = await empty.transport.read();
  expect(emptyRead.ok && emptyRead.pin === 'active' && 'page' in emptyRead && emptyRead.page.types).toEqual([]);
  const current = definitionGuideFixture();
  expect(
    await readGuide(
      { type: 'schema:Book', property: 'missing:field' },
      (digest) => fetchGuideRelease(current.client, digest),
      () => current.transport.directory('en', ''),
      (typeId) => current.transport.exact('en', typeId),
    ),
  ).toEqual({ ok: false, reason: 'invalid' });
  expect(await current.transport.exact('en', 'missing:type')).toEqual({ ok: false, reason: 'no-match' });
  const back =
    '/en/subjects/00000000-0000-4000-8000-000000000001/a-book/edit?property=schema%3AdatePublished&statement=selected#value';
  expect(guideReturnTo(back, 'en')).toBe(back);
  for (const unsafe of [
    'https://elsewhere.test',
    '//elsewhere.test/en/catalogue/new',
    '/en/catalogue/new/../admin',
    '/en/catalogue/new\\elsewhere',
  ])
    expect(guideReturnTo(unsafe, 'en')).toBeUndefined();
  const address = { type: 'schema:Book', property: 'schema:datePublished', returnTo: back };
  expect(new URL(definitionGuideHref('en', address), 'https://site.test').searchParams.get('returnTo')).toBe(back);
  const link = renderToStaticMarkup(createElement(DefinitionGuideLink, { locale: 'en', address, field: true }));
  expect(link).toContain('target="_blank"');
  expect(link).toContain(m.guide_field_help({}, { locale: 'en' }));
});
