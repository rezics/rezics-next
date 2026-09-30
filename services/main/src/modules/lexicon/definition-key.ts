import { checkedNativeIri } from '../semantic/schema.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import { iri, lit, RV } from '../work/activate.ts';

export const KEY_NOTATION = 'http://www.w3.org/2004/02/skos/core#notation';

export function checkedDefinitionKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new SemanticChangeRejected('invalid', 'definition notation is invalid');
  }
  return value;
}

export function definitionKeyIri(definition: string): string {
  return `${checkedNativeIri(definition)}/key`;
}

/** The seed writes this separate lexicon component atomically with its definition.
 * No extra predicate is added to the accepted closed SemanticDefinition subject. */
export function definitionKeyTriples(definition: string, key: string): string {
  return `${iri(definitionKeyIri(definition))} a <${RV}DefinitionKey> ;
    <${RV}keyDefinition> ${iri(definition)} ;
    <${KEY_NOTATION}> ${lit(checkedDefinitionKey(key))}^^<http://www.w3.org/2001/XMLSchema#string> .`;
}
