import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformAccess } from '../api/platform-access.ts';
import { work } from './fixtures.ts';
import { messages } from './messages.ts';
import type { HubWorkPage } from './types.ts';

const originalMain = { ...(await import('../api/main.ts')) };
const originalHeaders = { ...(await import('next/headers')) };
const originalSession = { ...(await import('../auth/session.ts')) };
const id = '00000000-0000-4000-8000-000000000001';
const href = `/v1/hub/works/${id}`;
const publication: HubWorkPage = { profile: 'hub-work-page-v1', kind: 'prompt', revision: id,
  content: 'Published instructions', parameterSchema: {}, examples: [], declaredModels: [], testedModels: [],
  versions: [{ revision: id, createdAt: '2026-10-12T00:00:00.000Z' }], moreVersions: false,
  createdAt: '2026-10-12T00:00:00.000Z' };
let signedIn = false;
let access: PlatformAccess = { groups: [], operations: [], generation: 'anonymous' };
let reads = 0;
let answer: { data: HubWorkPage | null; error: { status: number; value?: unknown } | null };

await mock.module('../api/main.ts', () => ({ ...originalMain,
  readPlatformAccess: async () => access,
  mainApiWithToken: () => ({ v1: { hub: { works: { [id]: { get: async () => { reads++; return answer; } } } } } }),
}));
await mock.module('next/headers', () => ({ ...originalHeaders,
  cookies: async () => ({ get: () => signedIn ? { value: 'session-token' } : undefined }),
}));
await mock.module('../auth/session.ts', () => ({ ...originalSession, sessionAgentState: async () => null }));
afterAll(async () => {
  await mock.module('../api/main.ts', () => originalMain);
  await mock.module('next/headers', () => originalHeaders);
  await mock.module('../auth/session.ts', () => originalSession);
});
const { readHubWorkPage } = await import('./read.ts');
const { TypeExperience } = await import('./work-views.tsx');

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
    for (const kind of ['prompt', 'skill'] as const) {
      const section = await typeSection(kind);
      expect(section === null).toBe(!state.permitted);
      if (!state.permitted) {
        const html = renderToStaticMarkup(createElement('main', null,
          createElement('h1', null, work.title.value), section));
        expect(html).toContain(work.title.value);
        expect(html).not.toContain('Retry');
        expect(html).not.toContain('Published text could not be loaded');
      }
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
  expect(await readHubWorkPage(href)).toEqual({ ok: false, failure: 'unavailable' });
});
