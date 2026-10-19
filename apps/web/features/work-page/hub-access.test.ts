import { afterAll, expect, test } from 'bun:test';
import { replaceModule } from '../../tests/support/module-replacement.ts';
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformAccess } from '../api/platform-access.ts';
import { work } from './fixtures.ts';
import { messages } from './messages.ts';
import type { HubWorkPage } from './types.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { workHref } from './route.ts';
import { seedServedTypes, servedTypes } from '../catalogue/type-fixtures.ts';
import { noStatements, projectionFor } from '../entity-page/fixtures.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { workExperience } from '../entity-page/experience.ts';

const originalMain = { ...(await import('../api/main.ts')) };
const originalHeaders = { ...(await import('next/headers')) };
const originalNavigation = { ...(await import('next/navigation')) };
const originalSession = { ...(await import('../auth/session.ts')) };
const originalProjection = { ...(await import('../entity-page/read.ts')) };
const id = '00000000-0000-4000-8000-000000000001';
const href = `/v1/hub/works/${id}`;
const publication: HubWorkPage = { profile: 'hub-work-page-v1', kind: 'prompt', revision: id,
  content: 'Published instructions', parameterSchema: {}, examples: [], declaredModels: [], testedModels: [],
  versions: [{ revision: id, createdAt: '2026-10-12T00:00:00.000Z' }], moreVersions: false,
  createdAt: '2026-10-12T00:00:00.000Z' };
let signedIn = false;
let access: PlatformAccess = { groups: [], operations: [], generation: 'anonymous' };
let reads = 0;
let kind: 'prompt' | 'skill' = 'prompt';
let projectionMode: 'ready' | 'unavailable' | 'missing-section' = 'ready';
const statementCursors: (string | undefined)[] = [];
seedServedTypes();
const typesFor = (kind: 'prompt' | 'skill') => [servedTypes.types.find(type => type.presentation === kind)!.type];
let answer: { data: HubWorkPage | null; error: { status: number; value?: unknown } | null };

const restoreMain = replaceModule(import.meta.resolve('../api/main.ts'), originalMain, {
  readPlatformAccess: async () => access,
  mainApiWithToken: () => ({ v1: { hub: { works: { [id]: { get: async () => { reads++; return answer; } } } } } }),
});
const restoreHeaders = replaceModule(import.meta.resolve('next/headers'), originalHeaders, {
  cookies: async () => ({ get: () => signedIn ? { value: 'session-token' } : undefined }),
  headers: async () => new Headers(),
});
const restoreNavigation = replaceModule(import.meta.resolve('next/navigation'), originalNavigation, {
  usePathname: () => localizedPath(workHref(id), 'en'),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh() {} }),
});
const restoreSession = replaceModule(import.meta.resolve('../auth/session.ts'), originalSession, { sessionAgentState: async () => null });
const restoreProjection = replaceModule(import.meta.resolve('../entity-page/read.ts'), originalProjection, {
  // The current frame reads its fact/source collection before streaming Hub content.
  readStatements: async (_section: unknown, cursor: string | undefined) => {
    statementCursors.push(cursor);
    return { ok: true, data: { ...noStatements, resource: work.id } };
  },
  readEntityProjection: async () => {
    if (projectionMode === 'unavailable') return { ok: false, failure: 'unavailable' };
    const data = projectionFor({ id, base: 'work', types: typesFor(kind), name: work.title.value });
    return { ok: true, data: projectionMode === 'missing-section'
      ? { ...data, sections: data.sections.filter(section => section.id !== kind) } : data };
  },
});
const originalRead = { ...(await import('./read.ts')) };
const restoreRead = replaceModule(import.meta.resolve('./read.ts'), originalRead, {
  readingAgent: async () => ({ signedIn, actingSubject: null }),
  readReaderState: async () => null,
  readRatings: async () => ({ ok: false, failure: 'unavailable' }),
});
afterAll(() => {
  restoreMain(); restoreHeaders(); restoreNavigation(); restoreSession(); restoreProjection(); restoreRead();
});
const { readHubWorkPage } = await import('./read.ts');
const { TypeExperience, WorkOverview, WorkFrameView } = await import('./work-views.tsx');
const { readWorkFacts } = await import('./hub-sections.tsx');

test('the Work facts owner receives the URL cursor, while repeated cursors are refused before its read', async () => {
  projectionMode = 'ready';
  statementCursors.length = 0;
  const main = originalMain.mainApiWithToken(undefined);
  const client = { main, anonymous: main, signedIn: false,
    pageUrl: `https://rezics.com/en/s/readers/library/${id}/contents?scope=global&statements=opaque%2Bnext` };
  const facts = await readWorkFacts(id, 'en', client);
  expect(statementCursors).toEqual(['opaque+next']);
  expect(facts.selection.cursor).toBe('opaque+next');
  expect(facts.selection.hrefFor({ kind: 'continue', section: 'statements', cursor: 'page-3' }))
    .toContain(`/en/s/readers/library/${id}/contents?scope=global&statements=page-3#statements`);
  const refused = await readWorkFacts(id, 'en', { ...client, pageUrl: `${client.pageUrl}&statements=second` });
  expect(refused.page).toEqual({ ok: false, failure: 'invalid' });
  expect(statementCursors).toEqual(['opaque+next']);
});

// Resolve the production Hub slots. Other independently streamed regions do not participate in
// this acceptance; leave them empty instead of replacing the page/header with a test-made shell.
async function hubShell(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(hubShell));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    if (!['TypeExperience', 'ReadSlot'].includes(node.type.name)) return null;
    return hubShell(await (node.type as (props: Record<string, unknown>) => Promise<ReactNode>)(node.props));
  }
  const props = Object.fromEntries(await Promise.all(Object.entries(node.props).map(async ([name, value]) =>
    [name, await hubShell(value as ReactNode)])));
  return cloneElement(node as ReactElement<Record<string, unknown>>, props);
}

async function productionPage() {
  const shown = { ...work, types: typesFor(kind) };
  const overview = await WorkOverview({ workRef: id, id, work: shown, scope: null, context: undefined,
    locale: 'en', messages: messages.en });
  const frame = await WorkFrameView({ workRef: id, id, work: shown, locale: 'en', messages: messages.en,
    children: overview });
  return renderToStaticMarkup(createElement(ShellProvider, { locale: 'en', messages: shellMessages,
    signedIn, platformAccess: access, initialTheme: 'light', initialCollapsed: false, children: await hubShell(frame) }));
}

async function typeSection(kind: 'prompt' | 'skill') {
  return TypeExperience({ id, work, locale: 'en', messages: messages.en,
    experience: { kind, presentation: kind, primaryAction: kind === 'skill' ? 'install' : 'copy',
      typeSection: { id: kind, href } } });
}

for (const state of [
  { name: 'anonymous', signedIn: false, groups: [], operations: [], permitted: false },
  { name: 'signed in without a grant', signedIn: true, groups: [], operations: [], permitted: false },
  { name: 'group grant', signedIn: true, groups: ['developer-extras'], operations: [], permitted: true },
  { name: 'individual operation grant', signedIn: true, groups: [], operations: ['getV1HubWorksById'], permitted: true },
  { name: 'unrelated individual grant', signedIn: true, groups: [], operations: ['getV1Mod-releasesByWork'], permitted: false },
  { name: 'revoked grant', signedIn: true, groups: [], operations: [], permitted: false },
]) {
  test(`optional Hub publication: ${state.name}`, async () => {
    signedIn = state.signedIn;
    access = { groups: state.groups, operations: state.operations, generation: state.name };
    reads = 0;
    answer = { data: publication, error: null };
    expect(await readHubWorkPage(href)).toEqual(state.permitted
      ? { ok: true, data: answer.data } : null);
    expect(reads).toBe(state.permitted ? 1 : 0);
    for (const shownKind of ['prompt', 'skill'] as const) {
      kind = shownKind;
      const section = await typeSection(shownKind);
      expect(section === null).toBe(!state.permitted);
      const html = await productionPage();
      expect(/<h1\b[^>]*>(.*?)<\/h1>/s.exec(html)?.[1]).toBe(work.title.value);
      const about = /<section\b[^>]*aria-labelledby="work-about"[^>]*>(.*?)<\/section>/s.exec(html)?.[1];
      expect(about).toContain('A surveyor maps a delta that redraws itself with every tide.');
      expect(html).toContain(messages.en.overview);
      expect(html.includes(publication.content)).toBe(state.permitted);
      expect(html).not.toContain('Retry');
      expect(html).not.toContain('Published text could not be loaded');
    }
  });
}

test('a grant revoked after the access summary leaves no publication or retry outcome', async () => {
  signedIn = true;
  access = { groups: ['developer-extras'], operations: [], generation: 'before-revocation' };
  reads = 0;
  answer = { data: null, error: { status: 403, value: { code: 'platform_closed' } } };
  expect(await readHubWorkPage(href)).toBeNull();
  expect(reads).toBe(1);
  expect(await typeSection('prompt')).toBeNull();
  expect(await typeSection('skill')).toBeNull();
});

test('an unpublished Hub work stays distinct from a closed publication', async () => {
  access = { groups: [], operations: ['getV1HubWorksById'], generation: 'operation' };
  answer = { data: null, error: null };
  expect(await readHubWorkPage(href)).toEqual({ ok: true, data: null });
});

test('a temporary Hub failure remains recoverable for a permitted viewer', async () => {
  access = { groups: ['developer-extras'], operations: [], generation: 'group' };
  answer = { data: null, error: { status: 503 } };
  expect(await readHubWorkPage(href)).toEqual({ ok: false, failure: 'unavailable', status: 503 });
});

for (const shownKind of ['prompt', 'skill'] as const) {
  for (const mode of ['unavailable', 'missing-section'] as const) {
    test(`known ${shownKind}: ${mode} keeps identity and a recoverable explanation without an invented publication read`, async () => {
      kind = shownKind;
      signedIn = true;
      access = { groups: ['developer-extras'], operations: [], generation: mode };
      projectionMode = mode;
      reads = 0;
      try {
        const html = await productionPage();
        expect(/<h1\b[^>]*>(.*?)<\/h1>/s.exec(html)?.[1]).toBe(work.title.value);
        expect(html).toContain(messages.en.hubUnavailable);
        expect(html).toContain(messages.en.regionUnavailable);
        expect(html).toContain(messages.en.retry);
        expect(html).not.toContain(publication.content);
        expect(html).not.toContain('Want to read');
        expect(reads).toBe(0);
        access = { groups: [], operations: [], generation: 'closed' };
        const section = await TypeExperience({ id, work: { ...work, types: typesFor(kind) }, locale: 'en',
          messages: messages.en, experience: workExperience(null, typesFor(kind)) });
        expect(section).toBeNull();
        expect(reads).toBe(0);
      } finally { projectionMode = 'ready'; }
    });
  }
}
