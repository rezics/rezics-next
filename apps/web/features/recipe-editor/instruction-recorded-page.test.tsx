import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { englishMessages } from '../work-page/messages.ts';
import { recipeReadingReads } from '../work-page/recipe-reading-recorded-page.ts';
import { recipeWorkFrame, recipeWorkOverview } from '../work-page/recipe-reading-recorded-page.tsx';
import { EVERYONE } from '../work-page/route.ts';
import { RecipeContent } from '../work-page/types/recipe.tsx';
import { loadRecipeAuthoring } from './authoring-page.ts';
import { mainRecipeExportApi, RecipeExportError } from './export-api.ts';
import { instructionVisitTransport } from './instruction-recorded-fixture.ts';
import { readRecipeVisitFrame } from './recipe-authoring-recorded-page.ts';

test.each(['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const)(
  '%s replays unchanged instruction captures through production page, editor and exchange with zero misses', async persona => {
    const misses: unknown[] = [];
    const visit = instructionVisitTransport(persona, 'https://recorded.invalid', source =>
      readFile(new URL(`../../../../${source}`, import.meta.url)).then(bytes => new Uint8Array(bytes)), error => misses.push(error));
    try {
      const frame = await readRecipeVisitFrame(visit.main, visit.fetcher, { actingSubject: visit.actingSubject,
        locale: 'en', origin: 'https://recorded.invalid' });
      expect(frame.ok).toBe(true);
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
      }
      const exported = mainRecipeExportApi(() => visit.main);
      const selection = { structure: visit.page.structure, revision: visit.page.revision, actingSubject: visit.actingSubject ?? '' };
      if (persona === 'visitor') {
        await expect(exported.exportRevision(selection)).rejects.toBeInstanceOf(RecipeExportError);
        await expect(exported.exportNativeRevision!(selection)).rejects.toBeInstanceOf(RecipeExportError);
      } else {
        expect((await exported.exportRevision(selection)).losses?.length).toBeGreaterThan(0);
        expect((await exported.exportNativeRevision!(selection)).losses).toEqual([]);
      }
      expect(misses).toEqual([]);
    } finally { visit.dispose(); }
  });
