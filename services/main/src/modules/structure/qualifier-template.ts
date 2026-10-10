import { createHash } from 'node:crypto';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { InvalidStructureObject, type OccurrenceRecord } from './format.ts';
import type { PlacementState } from './graph.ts';

/** A declared qualifier field. Kinds are the ones the object format already stores. */
export type QualifierField =
  | { name: string; kind: 'text'; predicate: string; required?: boolean; maxLength?: number }
  | { name: string; kind: 'lang-text'; predicate: string; required?: boolean }
  | { name: string; kind: 'enum'; predicate: string; required?: boolean; values: Readonly<Record<string, string>> }
  | { name: string; kind: 'boolean'; predicate: string; required?: boolean; trueValue: string; falseValue: string }
  | { name: string; kind: 'rational'; numerator: string; denominator: string }
  | { name: string; kind: 'iri'; predicate: string; required?: boolean; native?: boolean }
  | { name: string; kind: 'iri-list'; predicate: string; required?: boolean; native?: boolean }
  | { name: string; kind: 'object-ref'; predicate: string; prefix: string };

export interface QualifierTemplate {
  /** Stored qualifier id. `fields` reads `values`; a legacy type reads flat properties. */
  id: string;
  form: 'fields' | 'flat';
  flatType?: string;
  rdfType: string;
  idPrefix: string;
  fields: readonly QualifierField[];
  /** Placement edge the Work cycle guard reads. Not a qualifier field. */
  composedWork?: boolean;
  /** Write fields on the placement. A separate qualifier node would need its own reviewed shape. */
  onPlacement?: boolean;
}

type FieldValue = string | boolean | { numerator: number; denominator: number }
  | { value: string; language: string } | string[];

function term(value: string, native = false): string {
  if (native) return iri(value);
  if (!/^https:\/\/[^\s<>"']+$/.test(value) && !/^urn:[a-z0-9][a-z0-9:._-]*$/i.test(value)) {
    throw new InvalidStructureObject('qualifier contains an invalid IRI');
  }
  return `<${value}>`;
}

function localName(value: string): string {
  return value.slice(Math.max(value.lastIndexOf('#'), value.lastIndexOf('/')) + 1);
}

function readFlat(qualifier: NonNullable<OccurrenceRecord['qualifier']>, name: string): FieldValue | undefined {
  if (qualifier.type === 'fields') return qualifier.values[name] as FieldValue | undefined;
  const record = qualifier as unknown as Record<string, FieldValue | undefined>;
  return record[name];
}

function qualifierId(template: QualifierTemplate, placement: string): string {
  return `${template.idPrefix}${createHash('sha256').update(placement).digest('hex')}`;
}

function matches(template: QualifierTemplate, qualifier: OccurrenceRecord['qualifier']): boolean {
  if (!qualifier) return false;
  if (template.form === 'fields') return qualifier.type === 'fields' && qualifier.id === template.id;
  return qualifier.type === template.flatType;
}

/** Project one declared qualifier. Legacy profiles keep their predicate spelling. */
export function projectQualifierFields(template: QualifierTemplate, state: PlacementState,
  generation: string): { iri: string; triples: readonly string[] } | null {
  if (!matches(template, state.qualifier) || !state.qualifier) return null;
  const id = template.onPlacement ? state.placement : qualifierId(template, state.placement);
  const subject = iri(id);
  const triples = template.onPlacement ? [] : [`${subject} a rv:${template.rdfType} ; rv:generation ${iri(generation)} .`];
  for (const field of template.fields) {
    const value = readFlat(state.qualifier, field.name);
    if (value === undefined || (Array.isArray(value) && value.length === 0 && field.kind === 'iri-list' && !field.required)) {
      if (field.kind !== 'iri-list' && field.kind !== 'rational' && 'required' in field && field.required) {
        throw new InvalidStructureObject(`${field.name} is required`);
      }
      continue;
    }
    const add = (predicate: string, object: string) => triples.push(`${subject} rv:${predicate} ${object} .`);
    if (field.kind === 'text' && typeof value === 'string') add(field.predicate, lit(value));
    else if (field.kind === 'lang-text' && typeof value === 'object' && value && 'value' in value && 'language' in value) {
      add(field.predicate, `${lit(value.value)}@${value.language}`);
    } else if (field.kind === 'enum' && typeof value === 'string') {
      const mapped = field.values[value];
      if (!mapped) throw new InvalidStructureObject(`${field.name} differs from its format`);
      add(field.predicate, `<${mapped}>`);
    } else if (field.kind === 'boolean' && typeof value === 'boolean') {
      add(field.predicate, `<${value ? field.trueValue : field.falseValue}>`);
    } else if (field.kind === 'rational' && typeof value === 'object' && value && 'numerator' in value) {
      add(field.numerator, String(value.numerator));
      add(field.denominator, String(value.denominator));
    } else if (field.kind === 'iri' && typeof value === 'string') add(field.predicate, term(value, field.native));
    else if (field.kind === 'iri-list' && Array.isArray(value)) {
      for (const item of value) add(field.predicate, term(item, field.native));
    } else if (field.kind === 'object-ref' && typeof value === 'string') {
      add(field.predicate, term(`${field.prefix}${value}`));
    } else if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      throw new InvalidStructureObject(`${field.name} differs from its format`);
    }
  }
  if (template.composedWork && state.active && state.target) {
    triples.push(`${iri(state.placement)} rv:composedWork ${iri(state.target)} .`);
  }
  return { iri: id, triples };
}

/** Rebuild the stored qualifier from the predicates its template declared. */
export async function hydrateQualifierFields(template: QualifierTemplate, env: WorkActivationEnvironment,
  state: PlacementState): Promise<OccurrenceRecord['qualifier'] | undefined> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?p ?o WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${template.onPlacement
      ? `${iri(state.placement)} ?p ?o`
      : `${iri(state.placement)} rv:qualifier ?q . ?q a rv:${template.rdfType} ; ?p ?o`} . } }`, 128 * 1024);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return undefined;
  const values = new Map<string, { value: string; language?: string }[]>();
  for (const row of rows) {
    const predicate = localName(row.p?.value ?? '');
    const item = row.o;
    if (!predicate || predicate === 'type' || !item?.value) continue;
    const list = values.get(predicate) ?? [];
    list.push({ value: item.value, ...(item['xml:lang'] ? { language: item['xml:lang'] } : {}) });
    values.set(predicate, list);
  }
  const one = (name: string) => values.get(name)?.[0];
  const built: Record<string, FieldValue> = {};
  for (const field of template.fields) {
    if (field.kind === 'text') {
      const value = one(field.predicate)?.value;
      if (value === undefined) { if (field.required) return undefined; continue; }
      built[field.name] = value;
    } else if (field.kind === 'lang-text') {
      const value = one(field.predicate);
      if (!value?.language) { if (field.required) return undefined; continue; }
      built[field.name] = { value: value.value, language: value.language };
    } else if (field.kind === 'enum') {
      const value = one(field.predicate)?.value;
      const mapped = Object.entries(field.values).find(([, iriValue]) => iriValue === value)?.[0];
      if (!mapped) { if (field.required) return undefined; continue; }
      built[field.name] = mapped;
    } else if (field.kind === 'boolean') {
      const value = one(field.predicate)?.value;
      if (value === field.trueValue) built[field.name] = true;
      else if (value === field.falseValue) built[field.name] = false;
      else if (field.required) return undefined;
    } else if (field.kind === 'rational') {
      const numerator = one(field.numerator)?.value;
      const denominator = one(field.denominator)?.value;
      if (numerator === undefined || denominator === undefined) continue;
      built[field.name] = { numerator: Number(numerator), denominator: Number(denominator) };
    } else if (field.kind === 'iri') {
      const value = one(field.predicate)?.value;
      if (value === undefined) { if (field.required) return undefined; continue; }
      built[field.name] = value;
    } else if (field.kind === 'iri-list') {
      const list = (values.get(field.predicate) ?? []).map(item => item.value);
      if (!list.length && !field.required) continue;
      built[field.name] = list;
    } else if (field.kind === 'object-ref') {
      const value = one(field.predicate)?.value;
      if (value === undefined) continue;
      built[field.name] = value.startsWith(field.prefix) ? value.slice(field.prefix.length) : value;
    }
  }
  if (template.form === 'fields') return { type: 'fields', id: template.id, values: built };
  return { type: template.flatType, ...built } as OccurrenceRecord['qualifier'];
}
