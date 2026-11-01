import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { consentFixture } from '../src/kernel/fake/statement-consent';
import { consentAssertion, readStatementConsent, type ConsentRead } from '../src/features/catalogue/statement-consent';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { StatementConsentPage } = await import('../src/features/catalogue/statement-consent-view');

async function prepared() {
  const fixture = consentFixture();
  const read = await fixture.transport.read();
  if (!read.ok || !read.candidate?.consentIdentity) throw new Error('Expected admitted native-shaped identity');
  return { fixture, read };
}

function markup(fixture: ReturnType<typeof consentFixture>, read: ConsentRead, locale = 'en') {
  return renderToStaticMarkup(
    createElement(StatementConsentPage, {
      address: fixture.address,
      locale,
      transport: fixture.transport,
      initial: read,
    }),
  );
}

test('Authorized consent identifies the actual private subject relationship and target before confirmation while unauthorized callers cannot read the private assertion', async () => {
  const { fixture, read } = await prepared();
  const html = markup(fixture, read);
  expect(read.public.state).toBe('absent');
  expect(consentAssertion(read, fixture.address, 'en').identified).toBe(true);
  for (const text of ['River Ink', 'pen name of', 'The person behind the name']) {
    expect(html).toContain(text);
    expect(html.indexOf(text)).toBeLessThan(html.indexOf('>Share consent<'));
  }
  expect(html).toContain('<dt');
  expect(html).toContain('Relationship</dt>');
  for (const authorization of ['', 'Bearer other-account']) {
    const denied = await readStatementConsent(fixture.client, authorization, fixture.address);
    const deniedHtml = markup(fixture, denied);
    expect(JSON.stringify(denied)).not.toContain('River Ink');
    expect(JSON.stringify(denied)).not.toContain('The person behind the name');
    expect(deniedHtml).not.toContain('>Share consent<');
    expect(deniedHtml).not.toContain('River Ink');
  }
});

test('Missing private names disable both consequential actions even when a public result has a target', async () => {
  for (const missing of ['subject', 'target', 'blank', 'relationship'] as const) {
    const { fixture, read } = await prepared();
    const identity = read.candidate!.consentIdentity!;
    if (missing === 'subject') identity.subject = null;
    if (missing === 'target') identity.target = null;
    if (missing === 'blank') identity.subject!.labels = { en: '  \t' };
    if (missing === 'relationship') read.field = {};
    read.public = { state: 'present', statement: read.candidate!.statement, related: {} };
    expect(consentAssertion(read, fixture.address, 'en').identified).toBe(false);
    const html = markup(fixture, read);
    expect(html).toContain(m.statement_consent_identity_help({}, { locale: 'en' }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Share consent<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Retract assertion<\/button>/);
    expect(html).not.toContain('type="checkbox"');
  }
});

test('The confirmation display refuses names bound to another candidate, subject, property or target', async () => {
  for (const mismatch of ['candidate', 'statement', 'subject', 'property', 'target', 'slot', 'retracted'] as const) {
    const { fixture, read } = await prepared();
    const candidate = read.candidate!;
    const wrong = crypto.randomUUID();
    if (mismatch === 'candidate') candidate.id = wrong;
    if (mismatch === 'statement') candidate.statement.id = wrong;
    if (mismatch === 'subject') candidate.consentIdentity!.subject!.id = wrong;
    if (mismatch === 'property') candidate.statement.property.id = 'schema:name';
    if (mismatch === 'target') candidate.consentIdentity!.target!.id = wrong;
    if (mismatch === 'slot') fixture.address.slot = { target: wrong };
    if (mismatch === 'retracted') candidate.retracted = 3;
    expect(consentAssertion(read, fixture.address, 'en').identified).toBe(false);
  }
});

test('All interface locales name the assertion parts and mark the actual fallback language', async () => {
  const { fixture, read } = await prepared();
  read.candidate!.consentIdentity!.subject!.labels = { ja: '川の墨', en: 'River Ink' };
  read.candidate!.consentIdentity!.target!.labels = { fr: 'La personne derrière le nom' };
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
    const html = markup(fixture, read, locale);
    for (const message of [m.statement_consent_subject, m.statement_consent_relationship, m.statement_consent_target]) {
      expect(html).toContain(message({}, { locale }));
    }
    expect(html).toContain('lang="fr">La personne derrière le nom');
    expect(consentAssertion(read, fixture.address, locale).identified).toBe(true);
  }
  expect(markup(fixture, read, 'ja')).toContain('lang="ja">川の墨');
});
