import { t } from 'elysia';
import { adoptionItem } from '../../work/read-contract.ts';
import { templateRequest, templateResponse, templateParameters, TEMPLATE_COST, type ReviewedTemplate } from '../template-schema.ts';
const query='https://rezics.com/query/work-adoptions';
export const template={query,revision:1,
  request:templateRequest(query,t.Object({roots:templateParameters.roots},{additionalProperties:false})),response:templateResponse(query,adoptionItem),
  scope:'work',root:'work',serverBoundInputs:['_work_iri','_main_iri','id','_sort'],
  hydrateBindings:{realm:['realm'],selection:['selectionHead'],contribution:['selectionContribution'],decision:['selectionDecision'],draft:['selectionDraft']},
  eligibility:{kind:'rdf',selectors:[{graph:'urn:rezics:graph:current',predicate:'https://rezics.com/vocab/work',type:'https://rezics.com/vocab/RealmPublicationSlot',root:'work'}]},budgets:TEMPLATE_COST,
  fields:{realm:{term:'realm'},name:{summary:'realm',path:'name'},selection:{term:'selection'},contribution:{term:'contribution'},language:{term:'language'}},
} as const satisfies ReviewedTemplate;
