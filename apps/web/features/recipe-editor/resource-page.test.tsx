import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import exchangeJson from '../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { englishMessages } from '../work-page/messages.ts';
import { readSuppliedRecipePage } from './resource-page.ts';
import { RecipeResourceBody } from './resource-page.tsx';

const record = exchangeJson as AnswerRecord;
test.each(['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as AnswerPersona[])(
  '%s reads the exact recorded recipe through the production resource-section reader', async persona => {
    const sample = record.personas[persona].find(item => item.label === 'public-recipe')!;
    const path = new URL(sample.path, 'https://recorded.invalid');
    const actingSubject = path.searchParams.get('actingSubject') ?? undefined;
    const replay = recordedFetch(record, persona, [{ label: sample.label, state: 'populated' }], { pathPrefix: BFF_PREFIX });
    const misses: unknown[] = [];
    const main = browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher: async (...args) => {
      try { return await replay.fetcher(...args); } catch (error) { misses.push(error); throw error; }
    } });
    try {
      const recipe = await readSuppliedRecipePage(main, actingSubject, path.pathname);
      expect(recipe).toEqual({ ok: true, data: sample.answer });
      expect(misses).toEqual([]);
      const html = renderToStaticMarkup(createElement(RecipeResourceBody, { recipe, href: path.pathname,
        actingSubject: actingSubject ?? null, allowed: [], work: path.pathname.split('/').pop()!, text: null,
        locale: 'en', messages: englishMessages }));
      expect(html).toContain('1 ½ cup flour');
      expect(html).toContain('¼ cup flour');
      expect(html).toContain('lang="fr"');
      expect(html).not.toContain('Import Schema.org JSON');
      expect(html).not.toContain('Edit recipe');
      if (persona !== 'visitor') expect(html).toContain('Download Schema.org JSON');
      else expect(html).not.toContain('Download Schema.org JSON');
    } finally { replay.dispose(); }
  },
);
