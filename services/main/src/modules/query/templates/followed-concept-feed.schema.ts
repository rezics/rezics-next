import { t } from 'elysia';
import { readId,readName } from '../../work/read-contract.ts';
import { templateRequest,templateResponse,templateParameters,TEMPLATE_COST,type ReviewedTemplate } from '../template-schema.ts';
const query='https://rezics.com/query/followed-concept-feed';
export const template={query,revision:1,
  request:templateRequest(query,t.Object({roots:templateParameters.roots},{additionalProperties:false})),
  response:templateResponse(query,t.Object({id:readId,concept:readId,name:readName})),
  scope:'public',root:'concept',serverBoundInputs:['_work_iri','_main_iri','id','_sort','main'],
  hydrateBindings:{main:['mainVersion']},
  eligibility:{kind:'discovery-concept',order:'newest'},budgets:TEMPLATE_COST,
  fields:{id:{term:'id'},concept:{term:'concept'},name:{summary:'id',path:'name'}},
} as const satisfies ReviewedTemplate;
