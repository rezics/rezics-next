import { createHash } from 'node:crypto';
import type { OccurrenceRecord } from '../structure/format.ts';

export interface ImportedIngredient {
  sourceKey: string;
  qualifier: Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'ingredient-line' }>;
}
export interface ImportedStep { sourceKey: string; text: string; language: string; section: number }
export interface ImportedSection { sourceKey: string; label: string; language: string }
export interface RecipeImport {
  sections: ImportedSection[];
  ingredients: ImportedIngredient[];
  steps: ImportedStep[];
  residual: string;
}

export interface RecipeSourceSupportCandidate {
  sourceKey: string;
  sourceField: 'recipeIngredient' | 'recipeInstructions';
  sourcePointer: string;
  slot: 'structure-occurrence-v1#qualifier.originalText.value'
    | 'structure-occurrence-v1#qualifier.instructionText.value';
}

const textOf = (value: unknown): string | undefined => typeof value === 'string' && value.trim()
  ? value.trim() : undefined;
const languageOf = (value: unknown, fallback = 'en'): string => typeof value === 'string'
  && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value) ? value : fallback;

function exactAmount(lexical: string): { numerator: number; denominator: number } | undefined {
  const match = lexical.match(/^\s*(?:(\d+)\s+(\d+)\/(\d+)|(\d+)\/(\d+)|(\d+))(?:\s+|$)/);
  if (!match) return undefined;
  let numerator: bigint;
  let denominator: bigint;
  if (match[1] !== undefined) {
    numerator = BigInt(match[1]) * BigInt(match[3]!) + BigInt(match[2]!);
    denominator = BigInt(match[3]!);
  } else if (match[4] !== undefined) {
    numerator = BigInt(match[4]); denominator = BigInt(match[5]!);
  } else { numerator = BigInt(match[6]!); denominator = 1n; }
  if (denominator < 1n || numerator > 1_000_000_000_000n || denominator > 1_000_000_000_000n) {
    return undefined;
  }
  const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
  const divisor = gcd(numerator, denominator);
  return { numerator: Number(numerator / divisor), denominator: Number(denominator / divisor) };
}

function exactStructuredAmount(lexical: string) {
  const decimal = /^(\d+)\.(\d{1,12})$/.exec(lexical);
  if (!decimal) return exactAmount(lexical);
  return exactAmount(`${BigInt(decimal[1]!) * 10n ** BigInt(decimal[2]!.length)
    + BigInt(decimal[2]!)} / ${10n ** BigInt(decimal[2]!.length)}`.replace(/\s/g, ''));
}

function ingredient(value: string, sourceKey: string): ImportedIngredient {
  const amount = exactAmount(value);
  const remainder = amount ? value.replace(/^\s*(?:(?:\d+)\s+\d+\/\d+|\d+\/\d+|\d+)(?:\s+|$)/, '') : '';
  const unitText = remainder.match(/^([\p{L}]+)\b/u)?.[1];
  return { sourceKey, qualifier: { type: 'ingredient-line', originalText: { value, language: 'en' },
    amountLexical: value,
    ...(amount ? { amount } : {}), ...(unitText ? { unitText } : {}), optional: false,
    scaling: 'linear', substituteFor: [], parseStatus: amount ? 'partial' : 'unparsed' } };
}

function structuredIngredient(value: Record<string, unknown>, sourceKey: string,
  language: string): ImportedIngredient | undefined {
  const name = textOf(value.name);
  const rawValue = typeof value.value === 'number' && Number.isFinite(value.value)
    ? String(value.value) : textOf(value.value);
  const original = textOf(value.text) ?? [rawValue, textOf(value.unitText) ?? textOf(value.unitCode), name]
    .filter(Boolean).join(' ');
  if (!original) return undefined;
  const amount = rawValue ? exactStructuredAmount(rawValue) : undefined;
  const code = textOf(value.unitCode);
  const unit = code?.startsWith('https://') ? code : undefined;
  const unitText = textOf(value.unitText) ?? (unit ? undefined : code);
  return { sourceKey, qualifier: { type: 'ingredient-line', originalText: { value: original, language },
    ...(rawValue ? { amountLexical: rawValue } : {}), ...(amount ? { amount } : {}),
    ...(unit ? { unit } : {}), ...(unitText ? { unitText } : {}), optional: false,
    scaling: 'linear', substituteFor: [], parseStatus: amount ? 'partial' : 'unparsed' } };
}

function instruction(value: unknown): string | undefined {
  const direct = textOf(value);
  if (direct) return direct;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return textOf(row.text) ?? textOf(row.name) ?? textOf(row.description);
  }
  return undefined;
}

/** Parse a bounded Schema.org Recipe object while retaining its full source as a digest anchor. */
export function importRecipe(value: unknown, sourceKey: string): RecipeImport {
  const raw = JSON.stringify(value);
  if (raw === undefined || raw.length > 65_536) throw new Error('recipe source exceeds 64 KiB or is absent');
  const residual = createHash('sha256').update(raw).digest('hex');
  const root = typeof value === 'string' ? { recipeInstructions: value } : value as Record<string, unknown>;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('recipe source must be an object or text');
  const language = languageOf(root.inLanguage);
  const sections: ImportedSection[] = [];
  const ingredientRows = Array.isArray(root.recipeIngredient) ? root.recipeIngredient
    : root.recipeIngredient && typeof root.recipeIngredient === 'object'
      && Array.isArray((root.recipeIngredient as Record<string, unknown>).itemListElement)
      ? (root.recipeIngredient as { itemListElement: unknown[] }).itemListElement : [];
  const ingredients = ingredientRows.flatMap((item, index) => {
    const pointer = `${sourceKey}#/recipeIngredient/${index}`;
    const direct = textOf(item);
    if (direct) {
      const imported = ingredient(direct, pointer);
      imported.qualifier.originalText.language = language;
      return [imported];
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const imported = structuredIngredient(row, pointer, languageOf(row.inLanguage, language));
    return imported ? [imported] : [];
  });
  const steps: ImportedStep[] = [];
  const addInstructions = (rows: unknown[], section: number, pointer: string, inheritedLanguage: string,
    depth = 0) => {
    if (depth > 8 || rows.length > 128 || steps.length + ingredients.length + sections.length > 128) {
      throw new Error('recipe import exceeds its instruction bound');
    }
    for (const [index, item] of rows.entries()) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const row = item as Record<string, unknown>;
        const nested = Array.isArray(row.itemListElement) ? row.itemListElement : undefined;
        if (nested) {
          const label = textOf(row.name) ?? `Section ${sections.length + 1}`;
          const sectionId = sections.push({ sourceKey: `${sourceKey}#${pointer}/${index}`,
            label, language: languageOf(row.inLanguage, inheritedLanguage) }) - 1;
          addInstructions(nested, sectionId, `${pointer}/${index}/itemListElement`,
            languageOf(row.inLanguage, inheritedLanguage), depth + 1);
          continue;
        }
      }
      const text = instruction(item);
      if (text) steps.push({ sourceKey: `${sourceKey}#${pointer}/${index}`,
        text, language: item && typeof item === 'object' && !Array.isArray(item)
          ? languageOf((item as Record<string, unknown>).inLanguage, inheritedLanguage)
          : inheritedLanguage, section });
      if (steps.length + ingredients.length + sections.length > 128) {
        throw new Error('recipe import exceeds the 128 occurrence batch bound');
      }
    }
  };
  const instructions = root.recipeInstructions;
  if (typeof instructions === 'string') addInstructions([instructions], -1, '/recipeInstructions', language);
  else if (Array.isArray(instructions)) addInstructions(instructions, -1, '/recipeInstructions', language);
  if (sections.length + ingredients.length + steps.length > 128) {
    throw new Error('recipe import exceeds the 128 occurrence batch bound');
  }
  if (sections.some(item => item.sourceKey.length > 200 || item.label.length > 500)
    || ingredients.some(item => item.sourceKey.length > 200
      || item.qualifier.originalText.value.length > 1000
      || (item.qualifier.amountLexical?.length ?? 0) > 100
      || (item.qualifier.unitText?.length ?? 0) > 100)
    || steps.some(item => item.sourceKey.length > 200 || item.text.length > 4000)) {
    throw new Error('recipe source contains a value beyond the native Structure bound');
  }
  return { sections, ingredients, steps, residual };
}

/** Only bind source text that equals the exact accepted native child value. */
export function recipeSourceSupportCandidates(source: unknown, imported: RecipeImport):
  RecipeSourceSupportCandidate[] {
  const at = (pointer: string): unknown => {
    let value = source;
    for (const part of pointer.slice(1).split('/')) {
      if (Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(part)) value = value[Number(part)];
      else if (value && typeof value === 'object' && Object.hasOwn(value, part)) {
        value = (value as Record<string, unknown>)[part];
      } else return undefined;
    }
    return value;
  };
  const pointerOf = (key: string) => key.slice(key.indexOf('#') + 1);
  const candidate = (sourceKey: string, nativeText: string,
    sourceField: RecipeSourceSupportCandidate['sourceField'],
    slot: RecipeSourceSupportCandidate['slot']): RecipeSourceSupportCandidate | undefined => {
    let base = pointerOf(sourceKey);
    if (!base.startsWith(`/${sourceField}/`)) return undefined;
    let raw = at(base);
    if (raw === undefined && sourceField === 'recipeInstructions'
      && base === '/recipeInstructions/0' && typeof at('/recipeInstructions') === 'string') {
      base = '/recipeInstructions'; raw = at(base);
    }
    if (raw === undefined && sourceField === 'recipeIngredient'
      && base.startsWith('/recipeIngredient/')) {
      const nested = base.replace('/recipeIngredient/', '/recipeIngredient/itemListElement/');
      if (at(nested) !== undefined) { base = nested; raw = at(base); }
    }
    const suffix = raw === nativeText ? '' : raw && typeof raw === 'object'
      ? ['text', 'name', 'description'].find(field => (raw as Record<string, unknown>)[field] === nativeText)
      : undefined;
    const sourcePointer = `${base}${suffix ? `/${suffix}` : ''}`;
    if (raw !== nativeText && !suffix || sourcePointer.length > 200
      || sourcePointer.split('/').length > 9) return undefined;
    return { sourceKey, sourceField, sourcePointer, slot };
  };
  return [
    ...imported.ingredients.map(item => candidate(item.sourceKey, item.qualifier.originalText.value,
      'recipeIngredient', 'structure-occurrence-v1#qualifier.originalText.value')),
    ...imported.steps.map(item => candidate(item.sourceKey, item.text,
      'recipeInstructions', 'structure-occurrence-v1#qualifier.instructionText.value')),
  ].filter((item): item is RecipeSourceSupportCandidate => item !== undefined);
}
