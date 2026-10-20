import { checkRecipeQualifier } from './occurrence-validation.ts';
import { createHash } from 'node:crypto';
import { GRAPHS, RV, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { InvalidStructureObject, type OccurrenceRecord, type RecipeMeasure } from '../structure/format.ts';
import type { PlacementState } from '../structure/graph.ts';
import { semanticValueRdf } from '../semantic/value.ts';
import { exactRational } from './quantity.ts';
import { hydrateLegacy, projectLegacy, legacyValidations } from './legacy-projection.ts';

export const RECIPE_FACT_PROFILE = 'https://rezics.com/definition/recipe-facts-v1';
const SCHEMA = 'https://schema.org/';
const PROV = 'http://www.w3.org/ns/prov#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
type Qualifier = NonNullable<OccurrenceRecord['qualifier']>;
type Rational = { numerator: number; denominator: number };

/** Preserve absolute reference IRIs without admitting RDF delimiters or escape sequences. */
function iri(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`\p{Cc}\p{Cs}]+$/u.test(value)
    || /%(?![a-fA-F0-9]{2})/.test(value)) {
    throw new InvalidStructureObject('Recipe fact contains an invalid RDF IRI');
  }
  return `<${value}>`;
}

/** Public measure writers check the same RDF references before registering an admission. */
export function checkRecipeMeasureReferences(measures: readonly RecipeMeasure[]): void {
  for (const measure of measures) {
    for (const reference of [measure.nutrient, measure.unit, measure.evidence]) {
      if (reference !== undefined) iri(reference);
    }
  }
}

export function recipeFactId(placement: string): string {
  return `urn:rezics:recipe-qualifier:${createHash('sha256').update(placement).digest('hex')}`;
}
const triple = (subject: string, predicate: string, object: string) => `${iri(subject)} ${iri(predicate)} ${object} .`;
const language = (value: { value: string; language: string }) => `${lit(value.value)}@${value.language}`;
const type = (subject: string, value: string) => triple(subject, `${RDF}type`, iri(value));
const marker = (subject: string) => triple(subject, `${RV}definitionProfile`, iri(RECIPE_FACT_PROFILE));
const scaling = (value: string) => `${RV}${value === 'linear' ? 'LinearScaling' : value === 'non-linear' ? 'NonLinearScaling' : 'NotScalable'}`;

/** Recipe number pairs use the existing exact scalar RDF codec, including owl:rational. */
export function recipeNumberTerm(value: Rational): string {
  const reduced = exactRational(BigInt(value.numerator), BigInt(value.denominator));
  return semanticValueRdf(reduced.denominator === 1n
    ? { kind: 'integer', lexical: String(reduced.numerator) }
    : { kind: 'rational', lexical: `${reduced.numerator}/${reduced.denominator}` },
  () => { throw new InvalidStructureObject('an exact number cannot allocate a value node'); }).object;
}

function quantity(id: string, value: { amount?: Rational; amountUpper?: Rational; unit?: string; unitText?: string }): string[] {
  return [type(id, `${SCHEMA}QuantitativeValue`), marker(id),
    ...(value.amount ? [triple(id, `${SCHEMA}${value.amountUpper ? 'minValue' : 'value'}`, recipeNumberTerm(value.amount))] : []),
    ...(value.amountUpper ? [triple(id, `${SCHEMA}maxValue`, recipeNumberTerm(value.amountUpper))] : []),
    ...(value.unit ? [triple(id, `${SCHEMA}unitCode`, iri(value.unit))] : []),
    ...(value.unitText ? [triple(id, `${SCHEMA}unitText`, lit(value.unitText))] : [])];
}

/** Only parser evidence stays in the extraction envelope; names, quantities and policies are RDF facts. */
export function projectRecipeFacts(state: PlacementState, generation: string) {
  if (state.qualifierProjection === 'recipe-structure-v1') return projectLegacy(state, generation);
  const q = state.qualifier;
  if (q?.type !== 'ingredient-line' && q?.type !== 'recipe-step') return null;
  const id = recipeFactId(state.placement);
  const triples = [marker(id), triple(id, `${RV}generation`, iri(generation)),
    triple(id, `${RV}scaling`, iri(scaling(q.scaling)))];
  if (q.type === 'ingredient-line') {
    const source = `${id}:extraction`, amount = `${id}:quantity`;
    const evidence = { parseStatus: q.parseStatus,
      ...(q.amountLexical === undefined ? {} : { amountLexical: q.amountLexical }),
      ...(q.textParts === undefined ? {} : { textParts: q.textParts }),
      ...(q.residual === undefined ? {} : { residual: q.residual }) };
    triples.push(type(id, `${SCHEMA}HowToSupply`),
      triple(id, `${SCHEMA}requiredQuantity`, iri(amount)),
      triple(id, `${SCHEMA}valueRequired`, q.optional ? 'false' : 'true'),
      triple(id, `${PROV}wasDerivedFrom`, iri(source)),
      type(source, `${PROV}Entity`), marker(source),
      triple(source, `${SCHEMA}text`, language(q.originalText)),
      triple(source, `${RDF}value`, lit(JSON.stringify(evidence))),
      ...quantity(amount, q));
    if (q.name !== undefined) triples.push(triple(id, `${SCHEMA}name`, lit(q.name)));
    if (q.preparation) triples.push(triple(id, `${SCHEMA}description`, language(q.preparation)));
    for (const reference of q.substituteFor) triples.push(triple(id, `${RV}substituteFor`, iri(reference)));
    if (state.active) triples.push(triple(generation, `${SCHEMA}recipeIngredient`, iri(id)));
  } else {
    // Compatibility with retained text steps. New authored procedures live solely in Content.
    triples.push(type(id, `${SCHEMA}HowToStep`), triple(id, `${SCHEMA}text`, language(q.instructionText)));
    for (const reference of q.usesIngredient) triples.push(triple(id, `${SCHEMA}mentions`, iri(reference)));
    for (const media of q.media) triples.push(triple(id, `${SCHEMA}associatedMedia`, iri(media)));
    if (state.active) triples.push(triple(generation, `${SCHEMA}recipeInstructions`, iri(id)));
  }
  return { iri: id, triples };
}

/** Comparison follows RDF set and exact-number semantics; immutable wire order is retained separately. */
export function canonicalRecipeQualifier(q: Qualifier): Qualifier {
  const number = (value: Rational) => {
    const reduced = exactRational(BigInt(value.numerator), BigInt(value.denominator));
    return { numerator: Number(reduced.numerator), denominator: Number(reduced.denominator) };
  };
  return q.type === 'ingredient-line' ? { ...q,
    ...(q.amount ? { amount: number(q.amount) } : {}), ...(q.amountUpper ? { amountUpper: number(q.amountUpper) } : {}),
    substituteFor: [...new Set(q.substituteFor)].sort() }
    : q.type === 'recipe-step' ? { ...q, usesIngredient: [...new Set(q.usesIngredient)].sort(), media: [...new Set(q.media)].sort() } : q;
}

export async function hydrateRecipeFacts(env: WorkActivationEnvironment, state: PlacementState): Promise<Qualifier | undefined> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?node ?p ?o WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      { ${iri(state.placement)} rv:qualifier ?node . ?node ?p ?o }
      UNION { ${iri(state.placement)} rv:qualifier ?root . ?root <${SCHEMA}requiredQuantity> ?node . ?node ?p ?o }
      UNION { ${iri(state.placement)} rv:qualifier ?root . ?root <${PROV}wasDerivedFrom> ?node . ?node ?p ?o }
    } }`, 128 * 1024)).results?.bindings ?? [];
  const id = recipeFactId(state.placement);
  const nodes = new Map<string, Map<string, { value: string; language?: string }[]>>();
  for (const row of rows) {
    if (!row.node || !row.p || !row.o) continue;
    const fields = nodes.get(row.node.value) ?? new Map();
    const values = fields.get(row.p.value) ?? [];
    values.push({ value: row.o.value, ...(row.o['xml:lang'] ? { language: row.o['xml:lang'] } : {}) });
    fields.set(row.p.value, values); nodes.set(row.node.value, fields);
  }
  const root = nodes.get(id);
  if (root?.get(`${RV}definitionProfile`)?.[0]?.value !== RECIPE_FACT_PROFILE) {
    const legacy = await hydrateLegacy(env, state);
    if (legacy) state.qualifierProjection = 'recipe-structure-v1';
    return legacy;
  }
  const one = (node: string, predicate: string) => nodes.get(node)?.get(predicate)?.[0];
  const text = (node: string, predicate: string) => {
    const value = one(node, predicate);
    if (!value) return undefined;
    if (!value.language) throw new InvalidStructureObject('retained Recipe text lacks its authored language');
    return { value: value.value, language: value.language };
  };
  const values = (predicate: string) => root.get(predicate)?.map(item => item.value) ?? [];
  const policy = one(id, `${RV}scaling`)?.value;
  const scale = policy === `${RV}LinearScaling` ? 'linear' : policy === `${RV}NonLinearScaling` ? 'non-linear' : 'not-scalable';
  let result: unknown;
  if (values(`${RDF}type`).includes(`${SCHEMA}HowToSupply`)) {
    const source = one(id, `${PROV}wasDerivedFrom`)?.value;
    const amount = one(id, `${SCHEMA}requiredQuantity`)?.value;
    if (!source || !amount) throw new InvalidStructureObject('Recipe facts lack their quantity or extraction evidence');
    let extraction: Record<string, unknown>;
    try { extraction = JSON.parse(one(source, `${RDF}value`)?.value ?? ''); }
    catch { throw new InvalidStructureObject('Recipe extraction evidence is invalid'); }
    if (Object.keys(extraction).some(key => !['parseStatus', 'amountLexical', 'textParts', 'residual'].includes(key))) {
      throw new InvalidStructureObject('Recipe extraction evidence contains semantic facts');
    }
    const number = (predicate: string): Rational | undefined => {
      const value = one(amount, `${SCHEMA}${predicate}`)?.value;
      if (value === undefined) return undefined;
      const [n, d = '1'] = value.split('/');
      if (!/^\d+$/.test(n!) || !/^\d+$/.test(d)) throw new InvalidStructureObject('Recipe exact number is invalid');
      return { numerator: Number(n), denominator: Number(d) };
    };
    const lower = number('minValue') ?? number('value'), upper = number('maxValue');
    result = { type: 'ingredient-line', originalText: text(source, `${SCHEMA}text`), ...extraction,
      ...(one(id, `${SCHEMA}name`) ? { name: one(id, `${SCHEMA}name`)!.value } : {}),
      ...(text(id, `${SCHEMA}description`) ? { preparation: text(id, `${SCHEMA}description`) } : {}),
      ...(lower ? { amount: lower } : {}), ...(upper ? { amountUpper: upper } : {}),
      ...(one(amount, `${SCHEMA}unitCode`) ? { unit: one(amount, `${SCHEMA}unitCode`)!.value } : {}),
      ...(one(amount, `${SCHEMA}unitText`) ? { unitText: one(amount, `${SCHEMA}unitText`)!.value } : {}),
      optional: one(id, `${SCHEMA}valueRequired`)?.value === 'false', scaling: scale, substituteFor: values(`${RV}substituteFor`) };
  } else result = { type: 'recipe-step', instructionText: text(id, `${SCHEMA}text`),
    usesIngredient: values(`${SCHEMA}mentions`), media: values(`${SCHEMA}associatedMedia`), scaling: scale };
  return checkRecipeQualifier(result);
}

export async function recipeFactValidations(env: WorkActivationEnvironment, states: readonly PlacementState[]) {
  const legacy = states.filter(state => state.qualifierProjection === 'recipe-structure-v1');
  const entries = states.flatMap(state => {
    const q = state.qualifier;
    if (legacy.includes(state) || q?.type !== 'ingredient-line' && q?.type !== 'recipe-step') return [];
    const id = recipeFactId(state.placement);
    return [{ shape: `${RECIPE_FACT_PROFILE}/${q.type === 'ingredient-line' ? 'ingredient' : 'step'}-shape`,
      focus: [id], graphs: [GRAPHS.current] }, ...(q.type === 'ingredient-line' ? [
      { shape: `${RECIPE_FACT_PROFILE}/quantity-shape`, focus: [`${id}:quantity`], graphs: [GRAPHS.current] },
      { shape: `${RECIPE_FACT_PROFILE}/extraction-shape`, focus: [`${id}:extraction`], graphs: [GRAPHS.current] }] : [])];
  });
  return [...await legacyValidations(env, legacy), ...(entries.length
    ? await profileValidations(env.fuseki, 'recipe-facts-v1', entries) : [])];
}

/** An immutable fact snapshot belongs to the exact Structure revision, never a moving draft Work. */
export function projectRecipeMeasures(measures: readonly RecipeMeasure[], revision: string, owner: string): string {
  checkRecipeMeasureReferences(measures);
  const id = `${revision}/recipe-facts`, nutrition = `${id}/nutrition`;
  const triples = [triple(revision, `${SCHEMA}about`, iri(id)), type(id, `${SCHEMA}Recipe`), marker(id),
    triple(id, `${PROV}specializationOf`, iri(owner))];
  if (measures.some(item => item.kind === 'nutrient')) triples.push(
    triple(id, `${SCHEMA}nutrition`, iri(nutrition)), type(nutrition, `${SCHEMA}NutritionInformation`), marker(nutrition));
  measures.forEach((measure, index) => {
    const node = `${id}/${index}`;
    triples.push(...quantity(node, { amount: measure.value, ...measure }),
      triple(node, `${RV}basis`, iri(`${RV}${measure.basis === 'per-serving' ? 'PerServing' : 'WholeRecipe'}`)),
      triple(node, `${RV}coverage`, iri(`${RV}${measure.coverage === 'complete' ? 'Complete' : measure.coverage === 'partial' ? 'Partial' : 'Unknown'}`)),
      triple(node, `${PROV}wasGeneratedBy`, iri(`${node}/activity`)), type(`${node}/activity`, `${PROV}Activity`), marker(`${node}/activity`),
      triple(`${node}/activity`, `${SCHEMA}description`, lit(measure.provenance)));
    if (measure.evidence) triples.push(triple(node, `${PROV}wasDerivedFrom`, iri(measure.evidence)));
    if (measure.valueLexical) triples.push(triple(node, `${SCHEMA}description`, lit(measure.valueLexical)));
    if (measure.kind === 'nutrient') triples.push(triple(nutrition, `${SCHEMA}additionalProperty`, iri(node)),
      type(node, `${SCHEMA}PropertyValue`), triple(node, `${SCHEMA}propertyID`, iri(measure.nutrient!)));
    else if (measure.kind.endsWith('-duration')) {
      triples.push(type(node, `${SCHEMA}Duration`), triple(id, `${SCHEMA}${measure.kind === 'preparation-duration'
        ? 'prepTime' : measure.kind === 'cooking-duration' ? 'cookTime' : 'totalTime'}`, iri(node)));
    } else triples.push(triple(id, `${SCHEMA}recipeYield`, iri(node)),
      triple(node, `${SCHEMA}propertyID`, iri(`${SCHEMA}${measure.kind === 'servings' ? 'numberOfItems' : 'recipeYield'}`)));
  });
  return triples.join('\n');
}
