import type { AnswerSample, AnswerViolation } from '../../../scripts/api/answer-record.ts';

export interface AnswerContractDebt {
  operationId: string;
  status: number;
  path: string;
  date: string;
}

/** API owns repairs. Each exception names one member, never a subtree or a row. */
export const answerContractDebts: readonly AnswerContractDebt[] = [
  { operationId: 'getV1RecipesByIdExportsSchema-org', status: 200, path: '/answer/importability', date: '2026-10-14' },
  ...[0, 1].flatMap(index => ['', '/name', '/text', '/amountLexical', '/parseStatus'].map(member => ({
    operationId: 'getV1RecipesByIdExportsSchema-org', status: 200,
    path: `/answer/recipe/recipeIngredient/${index}${member}`, date: '2026-10-14',
  }))),
];

/** Exchange has no checked-in record. Retain its observed response as a debt witness
 * so the fresh-contract guard can retire these entries when the contract is repaired. */
export const answerContractDebtWitnesses: readonly AnswerSample[] = [{
  label: 'schema-org-export', operationId: 'getV1RecipesByIdExportsSchema-org', method: 'GET',
  path: '/v1/recipes/8edc5136-cbf7-86b6-aa7c-7f7d3ea2e25f/exports/schema-org', status: 200,
  headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' },
  answer: {
    profile: 'recipe-schema-org-export-v1',
    structure: 'https://rezics.com/id/8edc5136-cbf7-86b6-aa7c-7f7d3ea2e25f',
    revision: 'https://rezics.com/id/fcc3b0a7-4ebe-820d-bbf1-3e0a011811d4',
    recipe: {
      '@context': 'https://schema.org', '@type': 'Recipe', recipeIngredient: [
        { '@type': 'PropertyValue', text: 'flour', value: '3/2', amountLexical: '3/2', unitText: 'cup', parseStatus: 'partial', inLanguage: 'fr' },
        { '@type': 'PropertyValue', text: 'flour', value: '1/4', amountLexical: '1/4', unitText: 'cup', parseStatus: 'partial', inLanguage: 'fr' },
      ],
      recipeInstructions: [
        { '@type': 'HowToSection', name: 'Mix', inLanguage: 'en', itemListElement: [
          { '@type': 'HowToStep', text: 'Mix the first portion.', inLanguage: 'en' },
        ] },
        { '@type': 'HowToSection', name: 'Finish', inLanguage: 'en', itemListElement: [
          { '@type': 'HowToStep', text: 'Fold in the second portion.', inLanguage: 'en' },
        ] },
      ],
    },
    residuals: [
      { sourceKey: null, text: 'flour', parseStatus: 'partial', residual: null },
      { sourceKey: null, text: 'flour', parseStatus: 'partial', residual: null },
    ],
    sourceObservations: [], importability: { status: 'importable' },
    sourcePosition: { datasetId: 'product', dataEpoch: '782cba71-ed4c-48a3-a15f-d261833739e6', sequence: '14' },
    cost: { pages: 4, pagesRead: 12, occurrences: 6 },
  },
}];

export function matchesAnswerContractDebt(violation: AnswerViolation, debts = answerContractDebts): boolean {
  return debts.some(debt => debt.operationId === violation.operationId
    && debt.status === violation.status && debt.path === violation.path);
}

/** Check the whole observed inventory: one conforming sample cannot retire a debt. */
export function assertAnswerContractDebts(violations: readonly AnswerViolation[], debts = answerContractDebts): void {
  const stale = debts.filter(debt => !violations.some(violation => matchesAnswerContractDebt(violation, [debt])));
  if (stale.length) throw new Error(`Stale answer contract debts: ${stale.map(debt =>
    `${debt.operationId}, status ${debt.status}, ${debt.path}, ${debt.date}`).join('; ')}`);
}
