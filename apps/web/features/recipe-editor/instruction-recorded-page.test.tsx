import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { englishMessages } from '../work-page/messages.ts';
import { recipeReadingReads } from '../work-page/recipe-reading-recorded-page.ts';
import { recipeRegion, recipeWorkFrame, recipeWorkOverview } from '../work-page/recipe-reading-recorded-page.tsx';
import { EVERYONE } from '../work-page/route.ts';
import { mainRelationships } from '../relationships/api.ts';
import { RecipeContent } from '../work-page/types/recipe.tsx';
import { loadRecipeAuthoring } from './authoring-page.ts';
import { instructionVisitTransport } from './instruction-recorded-fixture.ts';
import { readRecipeVisitFrame } from './recipe-authoring-recorded-page.ts';

test('a server Recipe region leaves continuation functions inside the client boundary', async () => {
  const visit = instructionVisitTransport('visitor', 'https://recorded.invalid', source =>
    readFile(new URL(`../../../../${source}`, import.meta.url)).then(bytes => new Uint8Array(bytes)), error => { throw error; });
  try {
    const region = await recipeRegion({ host: { ...visit.host, recordingFetch: undefined, recipeReadPage: undefined },
      id: visit.id, work: visit.header, href: `/v1/recipes/works/${visit.id}`, locale: 'en', messages: englishMessages });
    expect(region.type).not.toBeUndefined();
    expect(region.props.initial?.instructions).toHaveLength(4);
    expect(region.props.readPage).toBeUndefined();
    expect(region.props.recordingFetch).toBeUndefined();
  } finally { visit.dispose(); }
});

test.each(['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const)(
  '%s replays unchanged instruction captures through production page, editor and compact exports with zero misses', async persona => {
    const misses: unknown[] = [];
    const visit = instructionVisitTransport(persona, 'https://recorded.invalid', source =>
      readFile(new URL(`../../../../${source}`, import.meta.url)).then(bytes => new Uint8Array(bytes)), error => misses.push(error));
    try {
      const frame = await readRecipeVisitFrame(visit.main, visit.fetcher, { actingSubject: visit.actingSubject,
        locale: 'en', origin: 'https://recorded.invalid' });
      expect(frame.ok).toBe(true);
      if (visit.actingSubject) await mainRelationships(visit.actingSubject, { fetch: visit.fetcher }).state(visit.header.id);
      const reads = recipeReadingReads({ main: visit.main, actingSubject: visit.actingSubject });
      const header = await reads.readWorkHeader(visit.id);
      expect(header).toMatchObject({ ok: true, data: visit.header });
      const overview = await recipeWorkOverview({ host: visit.host, workRef: visit.id, id: visit.id,
        work: visit.header, scope: EVERYONE, locale: 'en', messages: englishMessages });
      await recipeWorkFrame({ host: visit.host, workRef: visit.id, id: visit.id, work: visit.header,
        locale: 'en', messages: englishMessages, children: overview });
      const page = await reads.readRecipe(`/v1/recipes/works/${visit.id}`);
      if (!page.ok || !page.data) throw new Error('Production instruction page is unavailable');
      expect(page.data.instructions?.map(item => item.occurrence)).toEqual(visit.page.instructions?.map(item => item.occurrence));
      const html = renderToStaticMarkup(createElement(RecipeContent, { page: page.data, units: 'written', messages: englishMessages }));
      expect(html).toContain('Stir');
      expect(html).not.toContain('PRIVATE successor');
      expect(html).toContain(englishMessages.instructionTransformationNotice);
      expect(html).toContain(englishMessages.openRecording);
      const recording = page.data.instructions?.find(item => item.reference.selector.grain === 'representation');
      if (!recording || recording.reference.selector.grain !== 'representation') throw new Error('Missing selected recording');
      const query = new URLSearchParams({ ...(visit.actingSubject ? { actingSubject: visit.actingSubject } : {}), use: recording.mediaUse! });
      const bytes = await visit.fetcher(`https://recorded.invalid/api/main/v1/media/representations/${recording.reference.selector.representation}/bytes?${query}`);
      expect(bytes.status).toBe(200);
      expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array(await readFile(new URL('../../../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url))));
      const editor = await loadRecipeAuthoring(visit.main, { id: visit.id, actingSubject: visit.actingSubject, signedIn: persona !== 'visitor' });
      expect(editor.kind).toBe(persona === 'owner' ? 'editor' : 'no-authority');
      if (editor.kind === 'editor') {
        expect(JSON.stringify(editor.initial.recipe)).toContain('PRIVATE successor');
        expect(editor.initial.recipe.head).not.toBe(page.data.revision);
        const recording = editor.initial.recipe.instructions?.find(item => item.reference.selector.grain === 'representation');
        if (!recording || recording.reference.selector.grain !== 'representation') throw new Error('Missing private recording');
        expect(recording.status).toBe('available');
        expect(recording.details?.recording?.sha256).toBeTruthy();
        const query = new URLSearchParams({ actingSubject: visit.actingSubject!, ...(recording.mediaUse ? { use: recording.mediaUse } : {}) });
        const bytes = await visit.fetcher(`https://recorded.invalid/api/main/v1/media/representations/${recording.reference.selector.representation}/bytes?${query}`);
        expect(bytes.status).toBe(200);
        expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array(await readFile(new URL('../../../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url))));
      }
      // These captures prove compact exports. The paged download client is
      // covered by export-api.test.ts, including resume and authority rechecks.
      for (const format of ['schema-org', 'native'] as const) {
        const exported = await visit.main.v1.recipes({ id: visit.page.structure.slice(-36) }).export.get({
          query: { ...(visit.actingSubject ? { actingSubject: visit.actingSubject } : {}),
            revision: visit.page.revision, format },
        });
        if (persona === 'visitor') {
          expect(exported.error?.status).toBe(401);
          expect(exported.data).toBeNull();
        } else {
          expect(exported.error).toBeNull();
          expect(exported.data).toMatchObject({ structure: visit.page.structure, revision: visit.page.revision });
          if (!exported.data || !('losses' in exported.data) || !exported.data.losses) throw new Error('Missing compact export losses');
          if (format === 'schema-org') expect(exported.data.losses.length).toBeGreaterThan(0);
          else expect(exported.data.losses).toEqual([]);
        }
      }
      expect(misses).toEqual([]);
    } finally { visit.dispose(); }
  });
