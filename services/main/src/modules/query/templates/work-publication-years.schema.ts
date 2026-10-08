import { t } from 'elysia';
import { readId } from '../../work/read-contract.ts';
import { templateRequest, templateResponse, TEMPLATE_COST, type ReviewedTemplate } from '../template-schema.ts';
import {
  FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_GRAPH, FIRST_PUBLICATION_PREDICATE, FIRST_PUBLICATION_TYPE,
} from '../year-fact.ts';

const query = 'https://rezics.com/query/work-publication-years';
const year = t.Optional(t.Integer({ minimum: 1, maximum: 9999 }));
export const template = { query, revision: 1,
  request: templateRequest(query, t.Object({ fromYear: year, toYear: year }, { additionalProperties: false })),
  response: templateResponse(query, t.Object({
    id: readId, year: t.Integer({ minimum: 1, maximum: 9999 }), statement: readId,
  }, { additionalProperties: false })),
  scope: 'public', root: 'work',
  serverBoundInputs: ['_work_iri', '_main_iri', 'id', '_sort', '_year'],
  eligibility: {
    kind: 'first-publication', graph: FIRST_PUBLICATION_GRAPH, predicate: FIRST_PUBLICATION_PREDICATE,
    anchor: FIRST_PUBLICATION_ANCHOR, type: FIRST_PUBLICATION_TYPE,
  },
  budgets: TEMPLATE_COST,
  fields: { id: { term: 'id' }, year: { term: 'year', valueType: 'integer' }, statement: { term: 'statement' } },
} as const satisfies ReviewedTemplate;
