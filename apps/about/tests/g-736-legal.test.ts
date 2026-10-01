import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { POLICY_VERSIONS } from '../../../services/account/src/policy-versions.ts';
import { uiLocales } from '../src/i18n/locales.ts';
import { catalogs } from '../src/i18n/messages/index.ts';
import {
  boundMarkerKeys,
  emptyFacts,
  legalFacts,
  slotsFor,
  type LegalFacts,
} from '../src/legal/facts.ts';
import { readPolicies } from '../src/legal/loader.ts';
import {
  isReleaseBuild,
  markersIn,
  policies,
  publishedMarkdown,
  sourceDigest,
} from '../src/legal/policies.ts';

const root = resolve(import.meta.dir, '..');
const legalDirectory = new URL('../../../docs/legal/', import.meta.url);
const sourceOf = (file: string) => readFileSync(new URL(file, legalDirectory), 'utf8');

/** Every empty string replaced by text, as a maintainer's finished facts file would be. */
function complete(facts: LegalFacts): LegalFacts {
  const fill = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.trim() || 'supplied'
      : Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, fill(item)]));
  return fill(facts) as LegalFacts;
}
const everyKey = (facts: LegalFacts): LegalFacts => ({
  ...complete(facts),
  statements: Object.fromEntries(
    policies.flatMap(({ source }) =>
      markersIn(sourceOf(source)).map(({ key }) => [key, 'supplied']),
    ),
  ),
});

test('every marker in every published source has a slot in the facts file', () => {
  const slots = new Set([...boundMarkerKeys, ...Object.keys(legalFacts.statements)]);
  const missing = policies.flatMap(({ slug, source }) =>
    markersIn(sourceOf(source))
      .filter(({ key }) => !slots.has(key))
      .map(({ key }) => `${slug}: ${key}`),
  );
  expect(missing).toEqual([]);
});

test('sources link only to policies the site publishes or to documents outside docs/legal', () => {
  const published = new Set<string>(policies.map(({ source }) => source));
  const outline = 'creator-distribution-agreement-outline.md';
  for (const { source } of policies) {
    for (const [, file] of sourceOf(source).matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)) {
      if (file!.startsWith('..') || file === 'README.md' || file === outline) continue;
      expect(published.has(file!), `${source} links ${file}`).toBe(true);
    }
  }
});

test('G-736 digest guard: Terms and Privacy sources match the digests sign-up records', () => {
  for (const version of POLICY_VERSIONS) {
    const policy = policies.find(({ slug }) => slug === version.policyId)!;
    expect(`docs/legal/${policy.source}`).toBe(version.source);
    expect(sourceDigest(sourceOf(policy.source)), version.policyId).toBe(version.versionDigest);
  }
});

test('markers are filled from facts, section lines become headings and links stay inside the site', () => {
  const facts = { ...legalFacts, dmcaAgent: { ...legalFacts.dmcaAgent, name: 'Agent Example' } };
  const { markdown, unfilled } = publishedMarkdown(
    'copyright-and-dmca',
    sourceOf('copyright-and-dmca-policy.md'),
    slotsFor(facts),
  );
  expect(markdown).toContain('Agent name or title: Agent Example');
  expect(markdown).toContain('<mark data-unfilled>[REZICS TO FILL: monitored DMCA address]</mark>');
  expect(unfilled).toContain('monitored DMCA address');
  expect(unfilled).not.toContain('@Agent name or title');
  expect(markdown).toMatch(/^## 1\. Respect for copyright$/m);
  expect(markdown).not.toContain('REZICS Copyright and DMCA Policy');
  expect(markdown).toContain('](/legal/');
  expect(markdown).not.toMatch(/\]\((?![a-z]+:)[^)]*\.md/);
});

test('a development read reports problems without refusing', () => {
  const { published, problems } = readPolicies(legalDirectory);
  expect(published).toHaveLength(policies.length);
  expect(problems.length).toBeGreaterThan(0);
  expect(emptyFacts(legalFacts)).toContain('dmcaAgent.email');
});

test('the release rules refuse a placeholder, an empty fact and a digest mismatch, and pass complete facts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g736-legal-'));
  cleanups.push(directory);
  for (const file of readdirSync(legalDirectory)) {
    if (file.endsWith('.md')) writeFileSync(join(directory, file), sourceOf(file));
  }
  const fixture = new URL(`file://${directory}/`);
  const facts = everyKey(legalFacts);
  const accepted = POLICY_VERSIONS;
  expect(readPolicies(fixture, facts, accepted).problems).toEqual([]);

  // A seeded placeholder in an otherwise complete source.
  const terms = join(directory, 'terms-of-service.md');
  writeFileSync(
    terms,
    `${sourceOf('terms-of-service.md')}\n[REZICS TO FILL: seeded placeholder]\n`,
  );
  const seeded = readPolicies(fixture, facts, accepted).problems;
  expect(seeded.some((problem) => problem.includes('seeded placeholder'))).toBe(true);
  expect(seeded.some((problem) => problem.includes('differs from services/account'))).toBe(true);

  // A digest mismatch on its own: an edit with no marker in it.
  writeFileSync(terms, `${sourceOf('terms-of-service.md')}\nOne more sentence.\n`);
  const mismatch = readPolicies(fixture, facts, accepted).problems;
  expect(mismatch).toHaveLength(1);
  expect(mismatch[0]).toContain('terms: source digest');

  // An empty fact stays a problem even when every marker resolved.
  writeFileSync(terms, sourceOf('terms-of-service.md'));
  const blank = { ...facts, dmcaAgent: { ...facts.dmcaAgent, email: ' ' } };
  expect(readPolicies(fixture, blank, accepted).problems).toEqual(
    expect.arrayContaining(['legal facts: dmcaAgent.email is empty']),
  );
});

test('only --release or ABOUT_RELEASE=1 makes a release build', () => {
  expect(isReleaseBuild(['astro', 'build'], {})).toBe(false);
  expect(isReleaseBuild(['astro', 'build', '--release'], {})).toBe(true);
  expect(isReleaseBuild(['astro', 'build'], { ABOUT_RELEASE: '1' })).toBe(true);
});

test('the legal chrome is localized in every locale and names every policy', () => {
  for (const locale of uiLocales) {
    const copy = catalogs.legal[locale];
    expect(Object.keys(copy.names).sort(), locale).toEqual(policies.map(({ slug }) => slug).sort());
  }
});

const cleanups: string[] = [];
afterAll(() => {
  for (const path of cleanups) rmSync(path, { recursive: true, force: true });
});

function build(args: string[], outDir: string) {
  return Bun.spawnSync(
    [join(root, '../../node_modules/.bin/astro'), 'build', '--outDir', outDir, ...args],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

test('the development build renders every policy in every locale as a draft', () => {
  const out = mkdtempSync(join(root, '../../.temp/g736-about-'));
  cleanups.push(out);
  const result = build([], out);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  for (const locale of uiLocales) {
    for (const { slug } of policies) {
      const path = join(out, locale, 'legal', slug, 'index.html');
      expect(existsSync(path), path).toBe(true);
      const html = readFileSync(path, 'utf8');
      expect(html.match(/<h1[ >]/g)?.length, path).toBe(1);
      expect(html, path).toContain('data-draft-banner');
      expect(html, path).toContain('<meta name="robots" content="noindex">');
      expect(html.includes('data-english-governs'), path).toBe(locale !== 'en');
      expect(html, path).toContain('<div lang="en"');
    }
  }
  const sitemap = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  expect(sitemap).not.toContain('/legal/');
}, 180_000);

test('the release build fails while a placeholder or empty fact remains', () => {
  const out = mkdtempSync(join(root, '../../.temp/g736-about-'));
  cleanups.push(out);
  const result = build(['--release'], out);
  expect(result.exitCode).not.toBe(0);
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(output).toContain('Release build refused');
  expect(output).toContain('[REZICS TO FILL] marker has no fact');
  expect(existsSync(join(out, 'en', 'legal'))).toBe(false);
}, 180_000);
