import { t } from 'elysia';
import { creditItem } from '../../work/read-contract.ts';
import { templateRequest, templateResponse, templateParameters, TEMPLATE_COST, type ReviewedTemplate } from '../template-schema.ts';
const query='https://rezics.com/query/work-credits';
export const template={query,revision:1,
  request:templateRequest(query,t.Object({roots:templateParameters.roots},{additionalProperties:false})),response:templateResponse(query,creditItem),
  scope:'work',root:'work',sourceCredits:true,serverBoundInputs:['_work_iri','_main_iri','id','_sort','key','ordinal','_source_confirmed'],
  hydrateBindings:{revision:['creditRevision']},
  eligibility:{kind:'rdf',selectors:[{graph:'urn:rezics:graph:current',predicate:'https://rezics.com/vocab/work',type:'https://rezics.com/vocab/AuthorCredit',root:'work'}]},budgets:TEMPLATE_COST,
  fields:{id:{term:'id'},role:{constant:'author'},participantKind:{constant:'external-reference'},provider:{constant:'open-library'},key:{term:'key'},ordinal:{term:'ordinal',valueType:'integer'},
    agent:{constant:null},displayName:{author:'key',path:'displayName'},handle:{constant:null},nameSource:{author:'key',path:'nameSource',optional:true},confirmation:{term:'confirmation',optional:true}},
} as const satisfies ReviewedTemplate;
