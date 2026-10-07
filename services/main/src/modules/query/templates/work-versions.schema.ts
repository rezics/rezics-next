import { t } from 'elysia';
import { versionItem } from '../../work/read-contract.ts';
import { templateRequest, templateResponse, templateParameters, TEMPLATE_COST, type ReviewedTemplate } from '../template-schema.ts';
const query='https://rezics.com/query/work-versions';
export const template={query,revision:1,
  request:templateRequest(query,t.Object(templateParameters,{additionalProperties:false})),response:templateResponse(query,versionItem),
  scope:'work',root:'work',serverBoundInputs:['_work_iri','_main_iri','id','_sort','_contentLanguage','_kind'],
  hydrateBindings:{decision:['publicationHead','publicationDecision'],revision:['selectedDraft','publicationDraft']},
  eligibility:{kind:'rdf',selectors:[
    {graph:'urn:rezics:graph:current',predicate:'https://rezics.com/vocab/work',type:'https://rezics.com/vocab/TextContribution',root:'work'},
    {graph:'urn:rezics:graph:revisions',predicate:'https://rezics.com/vocab/work',type:'https://rezics.com/vocab/FixedRelease',root:'work'},
  ]},budgets:TEMPLATE_COST,
  fields:{id:{term:'id'},kind:{term:'kind'},language:{term:'language'},contribution:{term:'contribution'},revision:{term:'revision'},selected:{term:'selected',valueType:'boolean'}},
} as const satisfies ReviewedTemplate;
