import { randomUUID } from 'node:crypto';
import { type Page } from '@playwright/test';
import { BFF_PREFIX } from '../../features/api/browser.ts';

/** Prepare an original public Recipe through the signed-in cook's production Main API. */
export async function recipeTrackingSetup(page: Page, actingSubject: string, title: string): Promise<string> {
  async function answer<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const key = randomUUID();
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await page.request.fetch(`${BFF_PREFIX}${path}`, {
        method, data: body, headers: { 'idempotency-key': key },
      });
      const text = await response.text();
      if (response.status() === 202) {
        await page.waitForTimeout(1_000);
        continue;
      }
      if (!response.ok()) throw new Error(JSON.stringify({ method, path, request: body, status: response.status(), answer: text }));
      return JSON.parse(text) as T;
    }
    throw new Error(JSON.stringify({ method, path, request: body, status: 202, reason: 'still pending after 60 attempts' }));
  }
  const work = await answer<{ work: string; mainVersion: string }>('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/Recipe'],
    authoring: 'own-work', actingSubject,
  });
  const short = (iri: string) => iri.slice(-36);
  const composition = await answer<{ structure: string; revision: string }>('POST', '/v1/compositions', {
    profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion, actingSubject,
  });
  const changed = await answer<{ revision: string }>('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
    profile: 'recipe-composition', expectedHead: composition.revision, actingSubject,
    operations: [
      { op: 'insert', parent: composition.structure, position: 'last', role: 'ingredient', qualifier: {
        type: 'ingredient-line', originalText: { value: '1 cup flour', language: 'en' }, amountLexical: '1',
        amount: { numerator: 1, denominator: 1 }, unitText: 'cup', optional: false, scaling: 'linear',
        substituteFor: [], parseStatus: 'parsed',
      } },
      { op: 'insert', parent: composition.structure, position: 'last', role: 'step', qualifier: {
        type: 'recipe-step', instructionText: { value: 'Cook the pancakes until golden.', language: 'en' },
        usesIngredient: [], media: [], scaling: 'linear',
      } },
    ],
  });
  const head = await answer<{ revision: string }>('GET', `/v1/works/${short(work.work)}/scalar-value?actingSubject=${encodeURIComponent(actingSubject)}`);
  await answer('POST', '/v1/work-publications', {
    profile: 'work-structure-publication-v1', operation: 'publish', work: work.work,
    actingSubject, expectedWorkHead: head.revision, expectedMainVersion: work.mainVersion,
    structure: composition.structure, expectedStructureHead: changed.revision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public',
  });
  return work.work;
}
