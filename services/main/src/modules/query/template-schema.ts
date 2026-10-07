import { t } from 'elysia';
import type { TSchema } from 'typebox';
import { readId, readLanguage, pageFields } from '../work/read-contract.ts';
import type { SeekSelector } from './seek-index.ts';

export const TEMPLATE_COST = { roots:64, page:20, maxPage:64, candidates:256, hops:2, sourceCredits:128 } as const;
export const templateParameters = { roots:t.Array(readId,{ minItems:1,maxItems:64,uniqueItems:true }),
  contentLanguage:t.Optional(readLanguage), kind:t.Optional(t.Union([t.Literal('text-variant'),t.Literal('release')])) };
export const templatePresentation = t.Object({ language:t.Optional(readLanguage), actingSubject:t.Optional(readId) },{additionalProperties:false});
export const templatePaging = { limit:t.Optional(t.Integer({minimum:1,maximum:64,default:20})),
  cursor:t.Optional(t.String({minLength:1,maxLength:2048})) };
export function templateRequest<const I extends string,S extends TSchema>(query:I, parameters:S) {
  return t.Object({profile:t.Literal('template-query-v1'),query:t.Literal(query),revision:t.Literal(1),parameters,
    presentation:t.Optional(templatePresentation),...templatePaging},{additionalProperties:false});
}
export function templateResponse<const I extends string, S extends TSchema>(query:I,item:S) {
  return t.Object({profile:t.Literal('template-result-v1'),query:t.Literal(query),revision:t.Literal(1),
    items:t.Array(item,{maxItems:64}),complete:t.Boolean(),...pageFields});
}
export interface TemplateInput { profile:'template-query-v1'; query:string;revision:1;
  parameters:{ roots:string[];contentLanguage?:string;kind?:'text-variant'|'release' };
  presentation?:{language?:string;actingSubject?:string};limit?:number;cursor?:string }
export type TemplateField = { term:string; valueType?:'boolean'|'integer'; nullable?:boolean;optional?:boolean }
  | { constant: string | number | boolean | null }
  | { summary:string; path:'name' }
  | { author:string; path:'displayName'|'nameSource'; optional?:boolean };
export interface ReviewedTemplate { query:string;revision:1;request:TSchema;response:TSchema;
  scope:'work'|'public';root:'work'|'concept';
  serverBoundInputs:readonly string[];
  eligibility:{ kind:'rdf';selectors:readonly SeekSelector[] } | {kind:'discovery-concept';order:'newest'};
  budgets:typeof TEMPLATE_COST;
  fields:Record<string,TemplateField>;
  sourceCredits?:boolean;
  hydrateBindings?:Readonly<Record<string,readonly string[]>>;
}
