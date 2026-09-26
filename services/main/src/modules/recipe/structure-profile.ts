import { createHash } from 'node:crypto';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';
import type { OccurrenceRecord } from '../structure/format.ts';
import type { PlacementState } from '../structure/graph.ts';

const RECIPE_PROFILE = 'https://rezics.com/definition/recipe-structure-v1';

function qualifierId(placement: string): string {
  const hash = createHash('sha256').update(placement).digest('hex');
  return `urn:rezics:recipe-qualifier:${hash}`;
}

function term(value: string): string {
  if (!/^https:\/\/[^\s<>"']+$/.test(value) && !/^urn:[a-z0-9][a-z0-9:._-]*$/i.test(value)) {
    throw new Error('recipe qualifier contains an invalid IRI');
  }
  return `<${value}>`;
}

function project(state: PlacementState, generation: string) {
  const qualifier = state.qualifier;
  if (!qualifier || qualifier.type !== 'ingredient-line' && qualifier.type !== 'recipe-step') return null;
  const id = qualifierId(state.placement);
  const subject = iri(id);
  const triples = [`${subject} rv:generation ${iri(generation)} .`];
  const add = (predicate: string, value: string) => triples.push(`${subject} rv:${predicate} ${value} .`);
  if (qualifier.type === 'ingredient-line') {
    add('originalText', `${lit(qualifier.originalText.value)}@${qualifier.originalText.language}`);
    if (qualifier.amountLexical) add('amountLexical', lit(qualifier.amountLexical));
    if (qualifier.amount) {
      add('amountNumerator', String(qualifier.amount.numerator));
      add('amountDenominator', String(qualifier.amount.denominator));
    }
    if (qualifier.amountUpper) {
      add('amountUpperNumerator', String(qualifier.amountUpper.numerator));
      add('amountUpperDenominator', String(qualifier.amountUpper.denominator));
    }
    if (qualifier.unit) add('unit', term(qualifier.unit));
    if (qualifier.unitText) add('unitText', lit(qualifier.unitText));
    if (qualifier.preparation) add('preparation', `${lit(qualifier.preparation.value)}@${qualifier.preparation.language}`);
    add('optionality', `rv:${qualifier.optional ? 'Optional' : 'Required'}`);
    add('scaling', `rv:${qualifier.scaling === 'linear' ? 'LinearScaling'
      : qualifier.scaling === 'non-linear' ? 'NonLinearScaling' : 'NotScalable'}`);
    for (const occurrence of qualifier.substituteFor) add('substituteFor', iri(occurrence));
    add('parseStatus', `rv:${qualifier.parseStatus === 'parsed' ? 'Parsed'
      : qualifier.parseStatus === 'partial' ? 'PartiallyParsed' : 'Unparsed'}`);
    if (qualifier.residual) add('residual', term(`urn:rezics:${qualifier.residual}`));
    triples.push(`${subject} a rv:IngredientLine .`);
  } else {
    add('instructionText', `${lit(qualifier.instructionText.value)}@${qualifier.instructionText.language}`);
    for (const occurrence of qualifier.usesIngredient) add('usesIngredient', iri(occurrence));
    for (const media of qualifier.media) add('media', term(media));
    add('scaling', `rv:${qualifier.scaling === 'linear' ? 'LinearScaling'
      : qualifier.scaling === 'non-linear' ? 'NonLinearScaling' : 'NotScalable'}`);
    triples.push(`${subject} a rv:RecipeStep .`);
  }
  return { iri: id, triples };
}

async function hydrate(env: WorkActivationEnvironment, state: PlacementState):
  Promise<OccurrenceRecord['qualifier'] | undefined> {
  const query = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?q ?p ?o WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(state.placement)} rv:qualifier ?q . ?q ?p ?o . } }`, 128 * 1024);
  const rows = query.results?.bindings ?? [];
  if (!rows.length) return undefined;
  const values = new Map<string, { value: string; language?: string }[]>();
  for (const row of rows) {
    const predicate = row.p?.value?.slice(row.p.value.lastIndexOf('#') + 1)
      .replace(/^.*\//, '') ?? '';
    const item = row.o;
    if (!predicate || !item?.value) continue;
    const list = values.get(predicate) ?? [];
    list.push({ value: item.value, ...(item['xml:lang'] ? { language: item['xml:lang'] } : {}) });
    values.set(predicate, list);
  }
  const one = (name: string) => values.get(name)?.[0];
  const text = (name: string) => {
    const value = one(name);
    return value ? { value: value.value, language: value.language ?? 'en' } : undefined;
  };
  const number = (name: string) => {
    const value = one(name)?.value;
    return value && /^[0-9]+$/.test(value) ? Number(value) : undefined;
  };
  const rdfType = values.get('type')?.map(value => value.value).find(value => value.endsWith('IngredientLine')
    || value.endsWith('RecipeStep'));
  if (rdfType?.endsWith('IngredientLine')) {
    const originalText = text('originalText');
    const status = one('parseStatus')?.value.split(/[/#]/).at(-1);
    const scalingValue = one('scaling')?.value.split(/[/#]/).at(-1);
    if (!originalText || !status || !scalingValue) return undefined;
    const amountNumerator = number('amountNumerator');
    const amountDenominator = number('amountDenominator');
    const upperNumerator = number('amountUpperNumerator');
    const upperDenominator = number('amountUpperDenominator');
    const qualifier: NonNullable<OccurrenceRecord['qualifier']> = {
      type: 'ingredient-line', originalText,
      ...(one('amountLexical') ? { amountLexical: one('amountLexical')!.value } : {}),
      ...(amountNumerator !== undefined && amountDenominator !== undefined
        ? { amount: { numerator: amountNumerator, denominator: amountDenominator } } : {}),
      ...(upperNumerator !== undefined && upperDenominator !== undefined
        ? { amountUpper: { numerator: upperNumerator, denominator: upperDenominator } } : {}),
      ...(one('unit') ? { unit: one('unit')!.value } : {}),
      ...(one('unitText') ? { unitText: one('unitText')!.value } : {}),
      ...(text('preparation') ? { preparation: text('preparation')! } : {}),
      optional: one('optionality')?.value.endsWith('Optional') ?? false,
      scaling: scalingValue.endsWith('NonLinearScaling') ? 'non-linear'
        : scalingValue.endsWith('NotScalable') ? 'not-scalable' : 'linear',
      substituteFor: (values.get('substituteFor') ?? []).map(item => item.value),
      parseStatus: status.endsWith('PartiallyParsed') ? 'partial'
        : status.endsWith('Unparsed') ? 'unparsed' : 'parsed',
      ...(one('residual') ? { residual: one('residual')!.value.replace('urn:rezics:', '') } : {}),
    };
    return qualifier;
  }
  if (rdfType?.endsWith('RecipeStep')) {
    const instructionText = text('instructionText');
    const scalingValue = one('scaling')?.value.split(/[/#]/).at(-1);
    if (!instructionText || !scalingValue) return undefined;
    return { type: 'recipe-step', instructionText,
      usesIngredient: (values.get('usesIngredient') ?? []).map(item => item.value),
      media: (values.get('media') ?? []).map(item => item.value),
      scaling: scalingValue.endsWith('NonLinearScaling') ? 'non-linear'
        : scalingValue.endsWith('NotScalable') ? 'not-scalable' : 'linear' };
  }
  return undefined;
}

async function validations(env: WorkActivationEnvironment, changed: readonly PlacementState[]) {
  const entries = changed.flatMap(state => {
    if (state.qualifier?.type !== 'ingredient-line' && state.qualifier?.type !== 'recipe-step') return [];
    return [{ shape: `${RECIPE_PROFILE}/${state.qualifier.type === 'ingredient-line'
      ? 'ingredient-line' : 'step'}-shape`, focus: [qualifierId(state.placement)], graphs: [GRAPHS.current] }];
  });
  return entries.length ? profileValidations(env.fuseki, 'recipe-structure-v1', entries) : [];
}

/** Recipe work owns a Main Version Structure whose revisions retain each line occurrence. */
export const structureProfiles: readonly StructureProfileRegistration[] = [{
  id: 'recipe-composition',
  graphProfile: `${RV}RecipeComposition`,
  ownerType: 'https://schema.org/Recipe',
  componentType: `${RV}MainVersion`,
  componentPredicate: `${RV}mainVersion`,
  editScopePrefix: 'work:edit:',
  editPermission: 'work:edit',
  editAction: 'recipe.edit',
  receiptFamily: 'structure-command',
  catalogTargetTypes: ['https://schema.org/Recipe', 'https://schema.org/HowToStep',
    'https://schema.org/HowToSection', 'https://schema.org/Thing'],
  roles: ['group', 'ingredient', 'step', 'equipment'],
  targetRoles: [],
  selectionRequiredRoles: [],
  projectQualifier: project,
  hydrateQualifier: hydrate,
  qualifierValidations: validations,
}];
