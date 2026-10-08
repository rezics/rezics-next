import { t } from 'elysia';
import { creditItem, workCreditRole } from '../../work/read-contract.ts';
import { templateRequest, templateResponse, templateParameters, TEMPLATE_COST, type ReviewedTemplate } from '../template-schema.ts';
const query='https://rezics.com/query/work-credits';
const work='https://rezics.com/vocab/work';
const current='urn:rezics:graph:current';
export const template={query,revision:1,
  request:templateRequest(query,t.Object({roots:templateParameters.roots,role:t.Optional(workCreditRole)},{additionalProperties:false})),response:templateResponse(query,creditItem),
  scope:'work',root:'work',sourceCredits:true,serverBoundInputs:['_work_iri','_main_iri','id','_sort','key','ordinal','_source_confirmed','_role'],
  hydrateBindings:{revision:['creditRevision']},
  eligibility:{kind:'rdf',selectors:[
    {graph:current,predicate:work,type:'https://rezics.com/vocab/AuthorCredit',root:'work'},
    {graph:current,predicate:work,type:'https://rezics.com/vocab/NativeAgentCredit',root:'work'},
  ]},budgets:TEMPLATE_COST,
  fields:{id:{term:'id'},role:{term:'role'},participantKind:{term:'participantKind'},provider:{term:'provider',nullable:true},
    key:{term:'key',nullable:true},ordinal:{term:'ordinal',valueType:'integer',nullable:true},agent:{term:'agent',nullable:true},
    displayName:{author:'key',path:'displayName'},handle:{constant:null},nameSource:{author:'key',path:'nameSource',optional:true},confirmation:{term:'confirmation',optional:true}},
} as const satisfies ReviewedTemplate;
