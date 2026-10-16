import { checkRecipeQualifier } from './occurrence-validation.ts';
import { createHash } from 'node:crypto';
import type { OccurrenceRecord } from '../structure/format.ts';
import { isStructureUnitReference, checkIngredientTextParts } from '../structure/format.ts';
import { matchRecipeUnit, type RecipeUnitImportability } from './display.ts';

export interface ImportedIngredient {
  sourceKey: string;
  qualifier: Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'ingredient-line' }>;
}
export interface ImportedStep {
  sourceKey: string; sourcePointer: string; text: string; language: string;
  /** Index in sections, or -1 for the Recipe root. */
  section: number;
  /** Preorder shared with sections, preserving interleaved siblings. */
  order: number;
}
export interface ImportedSection {
  sourceKey: string; label: string; language: string;
  /** Index in sections, or -1 for the Recipe root. */
  parent: number;
  order: number;
}
export interface RecipeImport {
  sections: ImportedSection[];
  ingredients: ImportedIngredient[];
  steps: ImportedStep[];
  residual: string;
}

export const MAX_RECIPE_IMPORT_BYTES = 256 * 1024;
export const MAX_RECIPE_IMPORT_OCCURRENCES = 128;
export const MAX_RECIPE_SECTION_DEPTH = 16;
export const MAX_RECIPE_JSON_DEPTH = 32;

/** Every object-property and array-element edge contributes to parsed JSON depth. */
export function measureRecipeJSON(value: unknown): { depth: number; values: number } {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let depth = 0, values = 0;
  while (pending.length) {
    const item = pending.pop()!;
    depth = Math.max(depth, item.depth);
    values++;
    if (Array.isArray(item.value)) {
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else if (item.value && typeof item.value === 'object') {
      const row = item.value as Record<string, unknown>;
      for (const [key, child] of Object.entries(row)) {
        // The fixed context is checked separately by intake, as before this shared measure.
        if (item.depth === 0 && key === '@context' && child === 'https://schema.org') {
          depth = Math.max(depth, item.depth + 1);
          continue;
        }
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return { depth, values };
}

export type RecipeCapacityRefusal = {
  status: 'not-importable'; code: 'recipe_not_importable';
  limit: 'occurrences' | 'bytes' | 'depth' | 'section-depth'; measured: number; allowed: number;
};
export type RecipeImportability = { status: 'importable' } | RecipeCapacityRefusal | RecipeUnitImportability;

export function recipeImportability(occurrences: number, bytes: number, depth = 0): RecipeImportability {
  if (bytes > MAX_RECIPE_IMPORT_BYTES) return { status: 'not-importable',
    code: 'recipe_not_importable', limit: 'bytes', measured: bytes, allowed: MAX_RECIPE_IMPORT_BYTES };
  if (occurrences > MAX_RECIPE_IMPORT_OCCURRENCES) return { status: 'not-importable',
    code: 'recipe_not_importable', limit: 'occurrences', measured: occurrences,
    allowed: MAX_RECIPE_IMPORT_OCCURRENCES };
  if (depth > MAX_RECIPE_JSON_DEPTH) return { status: 'not-importable',
    code: 'recipe_not_importable', limit: 'depth', measured: depth, allowed: MAX_RECIPE_JSON_DEPTH };
  return { status: 'importable' };
}

export class RecipeInstructionNotSupported extends Error {
  readonly code = 'recipe_instruction_not_supported';
  constructor(readonly sourcePointer: string) {
    super(`Unrecognized Recipe instruction at ${sourcePointer}`);
    this.name = 'RecipeInstructionNotSupported';
  }
}

export class RecipeNotImportable extends Error {
  constructor(readonly importability: RecipeCapacityRefusal) {
    super(`Recipe import exceeds its ${importability.limit} limit (${importability.measured} > ${importability.allowed})`);
    this.name = 'RecipeNotImportable';
  }

  get code() { return this.importability.code; }
  get limit() { return this.importability.limit; }
  get measured() { return this.importability.measured; }
  get allowed() { return this.importability.allowed; }
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
const originalTextOf = (value: unknown): string | undefined => typeof value === 'string' && value.length
  ? value : undefined;
const languageOf = (value: unknown, fallback = 'en'): string => typeof value === 'string'
  && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value) ? value : fallback;

const vulgarFractions: Readonly<Record<string, readonly [number, number]>> = {
  '¼': [1, 4], '½': [1, 2], '¾': [3, 4],
  '⅐': [1, 7], '⅑': [1, 9], '⅒': [1, 10], '⅓': [1, 3], '⅔': [2, 3],
  '⅕': [1, 5], '⅖': [2, 5], '⅗': [3, 5], '⅘': [4, 5], '⅙': [1, 6],
  '⅚': [5, 6], '⅛': [1, 8], '⅜': [3, 8], '⅝': [5, 8], '⅞': [7, 8],
};
const fractionToken = String.raw`\d+\s+\d+[\/⁄]\d+|\d+[\/⁄]\d+|\d+\s*[¼-¾⅐-⅞]|[¼-¾⅐-⅞]`;
const amountToken = String.raw`(?:${fractionToken}|\d+\.\d+|\d+)`;
const amountEnd = String.raw`(?=$|[^\p{L}\p{N}])`;
const amountPrefix = new RegExp(String.raw`^(\s*)(${amountToken})${amountEnd}`, 'u');
const rangePrefix = new RegExp(String.raw`^(\s*)(${amountToken})(?:\s+(?:to|or)\s+|\s*[-–]\s*)(${amountToken})${amountEnd}`, 'u');

interface ExactAmount { numerator: number; denominator: number }
interface ParsedAmount {
  amount: ExactAmount;
  amountUpper?: ExactAmount;
  amountLexical: string;
  span: { start: number; end: number };
  remainder: string;
}

function exactAmount(lexical: string): ExactAmount | undefined {
  const decimal = /^(\d+)\.(\d{1,12})$/.exec(lexical);
  if (decimal) return exactAmount(`${BigInt(decimal[1]!) * 10n ** BigInt(decimal[2]!.length)
    + BigInt(decimal[2]!)} / ${10n ** BigInt(decimal[2]!.length)}`.replace(/\s/g, ''));
  const match = /^(?:(\d+)\s+(\d+)[\/⁄](\d+)|(\d+)[\/⁄](\d+)|(\d+)?\s*([¼-¾⅐-⅞])|(\d+))$/u.exec(lexical);
  if (!match) return undefined;
  let numerator: bigint;
  let denominator: bigint;
  if (match[1] !== undefined) {
    numerator = BigInt(match[1]) * BigInt(match[3]!) + BigInt(match[2]!);
    denominator = BigInt(match[3]!);
  } else if (match[4] !== undefined) {
    numerator = BigInt(match[4]); denominator = BigInt(match[5]!);
  } else if (match[7] !== undefined) {
    const fraction = vulgarFractions[match[7]]!;
    denominator = BigInt(fraction[1]);
    numerator = BigInt(match[6] ?? '0') * denominator + BigInt(fraction[0]);
  } else { numerator = BigInt(match[8]!); denominator = 1n; }
  if (denominator < 1n || numerator > 1_000_000_000_000n || denominator > 1_000_000_000_000n) {
    return undefined;
  }
  const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
  const divisor = gcd(numerator, denominator);
  return { numerator: Number(numerator / divisor), denominator: Number(denominator / divisor) };
}

function ingredientAmount(lexical: string): ParsedAmount | undefined {
  const range = rangePrefix.exec(lexical);
  if (range) {
    const amount = exactAmount(range[2]!);
    const amountUpper = exactAmount(range[3]!);
    if (!amount || !amountUpper || BigInt(amount.numerator) * BigInt(amountUpper.denominator)
      > BigInt(amountUpper.numerator) * BigInt(amount.denominator)) return undefined;
    const span = { start: range[1]!.length, end: range[0].length };
    return { amount, amountUpper, span, amountLexical: lexical.slice(span.start, span.end),
      remainder: lexical.slice(span.end) };
  }
  const match = amountPrefix.exec(lexical);
  if (!match) return undefined;
  // A failed range must not fall back to its lower endpoint as a scalar amount.
  const remainder = lexical.slice(match[0].length);
  if (/^\s*(?:(?:to|or)\s+|[-–]\s*)[\d¼-¾⅐-⅞]/u.test(remainder)) return undefined;
  const amount = exactAmount(match[2]!);
  const span = { start: match[1]!.length, end: match[0].length };
  return amount ? { amount, span, amountLexical: lexical.slice(span.start, span.end), remainder } : undefined;
}

const italianNumbers: Readonly<Record<string, number>> = {
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6,
  sette: 7, otto: 8, nove: 9, dieci: 10, mezzo: 0.5, mezza: 0.5,
};
const italianUnitToken = String.raw`chilogrammi|chilogrammo|decilitri|decilitro|millilitri|millilitro|grammi|grammo|cucchiai|cucchiaio|cucchiaini|cucchiaino|litri|litro|pizzichi|pizzico|prese|presa|gr\.|kg|g|ml|dl|l`;
const italianUnit = new RegExp(String.raw`^(?:${italianUnitToken})(?=$|[^\p{L}\p{N}])`, 'iu');
const italianNumberToken = Object.keys(italianNumbers).join('|');

function ingredientUnit(value: string, start: number, language: string) {
  const local = language.split('-')[0] === 'it' ? italianUnit.exec(value.slice(start)) : undefined;
  return local ? { start, end: start + local[0].length } : matchRecipeUnit(value, start);
}

/** Numbers in references are not quantities. Ambiguous counts retain wording alone. */
function writtenIngredient(value: string, language: string): Partial<ImportedIngredient['qualifier']> | undefined {
  // Never salvage a later endpoint from an invalid leading quantity.
  if (/^\s*[-\d¼-¾⅐-⅞]/u.test(value)) return undefined;
  const italian = language.split('-')[0] === 'it';
  const candidates: Array<{ parsed: ParsedAmount; unit?: { start: number; end: number }; start: number; end: number }> = [];
  const unitAt = (start: number) => ingredientUnit(value, start, language);
  // Parenthetical catalogue/cross references (e.g. Artusi's "vedi N. 323") stay source text.
  const outside = (start: number) => value.lastIndexOf('(', start) <= value.lastIndexOf(')', start);
  const numeric = new RegExp(String.raw`(?<![\p{L}\p{N}/⁄.\-])${amountToken}${amountEnd}`, 'gu');
  for (const match of value.matchAll(numeric)) {
    const start = match.index;
    if (!outside(start) || /\bvedi\s+N\.\s*$/iu.test(value.slice(0, start))) continue;
    const parsed = ingredientAmount(value.slice(start));
    if (!parsed) return undefined;
    // A range is one quantity, not two independent candidates.
    if (candidates.some(candidate => start < candidate.parsed.span.end)) continue;
    parsed.span = { start, end: start + parsed.span.end };
    const after = parsed.span.end + (value.slice(parsed.span.end).match(/^\s*/u)?.[0].length ?? 0);
    const following = unitAt(after);
    const prefix = value.slice(0, start);
    const preceding = italian ? new RegExp(String.raw`(?:^|[\s,])(${italianUnitToken}|N\.)\s*$`, 'iu').exec(prefix) : undefined;
    const unit = following ?? (preceding && preceding[1]!.toLowerCase() !== 'n.'
      ? { start: start - preceding[0].length + preceding[0].indexOf(preceding[1]!),
        end: prefix.trimEnd().length } : undefined);
    const trailingCount = italian && prefix.trim() && /^[\s.]*$/u.test(parsed.remainder);
    if (!unit && !preceding && !trailingCount) continue;
    candidates.push({ parsed, unit, start: preceding ? start - preceding[0].length : start,
      end: following?.end ?? parsed.span.end });
  }
  if (candidates.length === 1) {
    const { parsed, unit, start, end } = candidates[0]!;
    if (italian && /\b(?:oppure|e)\b/iu.test(value) && new RegExp(String.raw`\b(?:${italianNumberToken})\b`, 'iu').test(value)) {
      return { amountLexical: value.trim().replace(/\.$/u, '').slice(0, 100), parseStatus: 'partial' };
    }
    const before = value.slice(0, start).trim().replace(/[,;:]\s*$/u, '');
    const after = value.slice(end).trim().replace(/^di\s+/iu, '').replace(/\.$/u, '');
    return { amount: parsed.amount, ...(parsed.amountUpper ? { amountUpper: parsed.amountUpper } : {}),
      amountLexical: parsed.amountLexical, ...(unit ? { unitText: value.slice(unit.start, unit.end) } : {}),
      ...(!after || after === '.' ? { name: before } : !before ? { name: after } : {}), parseStatus: 'partial' };
  }
  if (!italian || candidates.length) return undefined;
  const qualitative = /\b(?:q\.\s*b\.|quanto basta|quanto una noce)\.?/iu.exec(value);
  if (qualitative) return { amountLexical: qualitative[0], parseStatus: 'partial' };
  const words = new RegExp(String.raw`\b(${italianNumberToken})(?:\s+o\s+(${italianNumberToken}))?\b`, 'giu');
  const matches = [...value.matchAll(words)].filter(match => outside(match.index));
  if (!matches.length) return undefined;
  const first = matches[0]!;
  const lexical = matches.length > 1 ? value.slice(first.index).trim().replace(/\.$/u, '') : first[0];
  // Alternatives and compound counts have wording, but no single scalar quantity.
  if (matches.length > 1) return { amountLexical: lexical.slice(0, 100), parseStatus: 'partial' };
  const number = italianNumbers[first[1]!.toLowerCase()]!;
  const upper = first[2] ? italianNumbers[first[2].toLowerCase()] : undefined;
  const exact = (n: number): ExactAmount => n === 0.5 ? { numerator: 1, denominator: 2 } : { numerator: n, denominator: 1 };
  if (upper !== undefined && upper < number) return undefined;
  const end = first.index + first[0].length;
  const unit = unitAt(end + (value.slice(end).match(/^\s*/u)?.[0].length ?? 0));
  const before = value.slice(0, first.index).trim().replace(/[,;:]\s*$/u, '');
  const after = value.slice(unit?.end ?? end).trim().replace(/^di\s+/iu, '').replace(/\.$/u, '');
  return { amount: exact(number), ...(upper !== undefined ? { amountUpper: exact(upper) } : {}),
    amountLexical: lexical, ...(unit ? { unitText: value.slice(unit.start, unit.end) } : {}),
    ...(!after ? { name: before } : !before ? { name: after } : {}), parseStatus: 'partial' };
}

function ingredient(value: string, sourceKey: string, language: string): ImportedIngredient {
  const parsed = ingredientAmount(value);
  const afterSpace = (start: number) => {
    while (start < value.length && /\s/u.test(value[start]!)) start++;
    return start;
  };
  const unitSpan = parsed ? ingredientUnit(value, afterSpace(parsed.span.end), language) : undefined;
  const textParts = parsed ? { amount: parsed.span, ...(unitSpan ? { unit: unitSpan } : {}),
    name: { start: afterSpace(unitSpan?.end ?? parsed.span.end), end: value.length } } : undefined;
  const unitText = textParts?.unit ? value.slice(textParts.unit.start, textParts.unit.end) : undefined;
  const written = !parsed ? writtenIngredient(value, language) : undefined;
  return { sourceKey, qualifier: { type: 'ingredient-line', originalText: { value, language },
    ...(parsed ? { amountLexical: parsed.amountLexical, textParts } : {}),
    ...(parsed ? { amount: parsed.amount, ...(parsed.amountUpper ? { amountUpper: parsed.amountUpper } : {}) } : {}),
    ...(unitText ? { unitText } : {}), optional: false,
    scaling: 'linear', substituteFor: [], parseStatus: parsed ? 'partial' : 'unparsed', ...written } };
}

function structuredIngredient(value: Record<string, unknown>, sourceKey: string,
  language: string): ImportedIngredient | undefined {
  const name = typeof value.name === 'string' ? value.name : undefined;
  const quantityText = (input: unknown) => typeof input === 'number' && Number.isFinite(input)
    ? String(input) : textOf(input);
  const rawValue = quantityText(value.value);
  const rawUpper = quantityText(value.maxValue);
  const code = textOf(value.unitCode);
  const unit = isStructureUnitReference(code) ? code : undefined;
  const unitText = (value.parseStatus === undefined ? textOf(value.unitText)
    : originalTextOf(value.unitText)) ?? (unit ? undefined : code);
  const hasQuantity = Object.hasOwn(value, 'value') || Object.hasOwn(value, 'maxValue');
  const quantity = Object.hasOwn(value, 'maxValue') ? `${rawValue ?? ''} to ${rawUpper ?? ''}`
    : hasQuantity ? rawValue ?? '' : undefined;
  const original = typeof value.text === 'string' ? value.text : name;
  if (original === undefined) return undefined;
  const fields = quantity !== undefined ? ingredientAmount(quantity) : undefined;
  const parsed = fields && !fields.remainder.trim() ? fields : undefined;
  const textParts = value.textParts === undefined ? undefined : checkIngredientTextParts(value.textParts);
  const amountLexical = typeof value.amountLexical === 'string' ? value.amountLexical : undefined;
  if (value.amountLexical !== undefined && amountLexical === undefined) {
    throw new Error('ingredient amount lexical must be text');
  }
  const qualifier: ImportedIngredient['qualifier'] = { type: 'ingredient-line', originalText: { value: original, language },
    ...(name !== undefined ? { name } : {}),
    ...(textParts ? { textParts } : {}),
    ...(amountLexical !== undefined ? { amountLexical } : {}),
    ...(parsed ? { amount: parsed.amount, ...(parsed.amountUpper ? { amountUpper: parsed.amountUpper } : {}) } : {}),
    ...(unit ? { unit } : {}), ...(unitText ? { unitText } : {}), optional: value.optional === true,
    scaling: 'linear', substituteFor: [], parseStatus: quantity !== undefined && !parsed ? 'unparsed'
      : value.parseStatus === 'parsed'
      || value.parseStatus === 'partial' || value.parseStatus === 'unparsed'
      ? value.parseStatus : parsed ? 'partial' : 'unparsed' };
  return { sourceKey, qualifier: checkRecipeQualifier(qualifier) as ImportedIngredient['qualifier'] };
}

function instruction(value: unknown): string | undefined {
  const direct = originalTextOf(value);
  if (direct) return direct;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return originalTextOf(row.text) ?? textOf(row.name) ?? textOf(row.description);
  }
  return undefined;
}

function oneOrMany(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Parse a bounded Schema.org Recipe object while retaining its full source as a digest anchor. */
export function importRecipe(value: unknown, sourceKey: string): RecipeImport {
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error('recipe source is absent');
  const sourceBytes = Buffer.byteLength(raw, 'utf8');
  if (sourceBytes > MAX_RECIPE_IMPORT_BYTES) {
    throw new RecipeNotImportable({ status: 'not-importable', code: 'recipe_not_importable',
      limit: 'bytes', measured: sourceBytes, allowed: MAX_RECIPE_IMPORT_BYTES });
  }
  const residual = createHash('sha256').update(raw).digest('hex');
  const root = typeof value === 'string' ? { recipeInstructions: value } : value as Record<string, unknown>;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('recipe source must be an object or text');
  const language = languageOf(root.inLanguage);
  const sections: ImportedSection[] = [];
  const ingredientRows = Array.isArray(root.recipeIngredient) ? root.recipeIngredient
    : root.recipeIngredient && typeof root.recipeIngredient === 'object'
      && Array.isArray((root.recipeIngredient as Record<string, unknown>).itemListElement)
      ? (root.recipeIngredient as { itemListElement: unknown[] }).itemListElement : [];
  // Native exports also include a text representation for ordinary consumers.
  // Match multiplicities, so repeated ingredients remain separate occurrences.
  const pairedText = new Map<string, number>();
  for (const item of ingredientRows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row['@type'] === 'PropertyValue' && typeof row.text === 'string'
      && ['parsed', 'partial', 'unparsed'].includes(String(row.parseStatus))) {
      pairedText.set(row.text, (pairedText.get(row.text) ?? 0) + 1);
    }
  }
  const ingredients = ingredientRows.flatMap((item, index) => {
    const pointer = `${sourceKey}#/recipeIngredient/${index}`;
    const direct = originalTextOf(item);
    if (direct) {
      const paired = pairedText.get(direct) ?? 0;
      if (paired) { pairedText.set(direct, paired - 1); return []; }
      const imported = ingredient(direct, pointer, language);
      imported.qualifier.originalText.language = language;
      return [imported];
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const imported = structuredIngredient(row, pointer, languageOf(row.inLanguage, language));
    return imported ? [imported] : [];
  });
  const steps: ImportedStep[] = [];
  let order = 0;
  const addInstructions = (value: unknown, section: number, pointer: string, inheritedLanguage: string,
    depth = 0) => {
    if (depth > MAX_RECIPE_SECTION_DEPTH) throw new RecipeNotImportable({ status: 'not-importable',
      code: 'recipe_not_importable', limit: 'section-depth', measured: depth, allowed: MAX_RECIPE_SECTION_DEPTH });
    const rows = oneOrMany(value);
    for (const [index, item] of rows.entries()) {
      const sourcePointer = Array.isArray(value) ? `${pointer}/${index}` : pointer;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const row = item as Record<string, unknown>;
        if (row['@type'] === 'HowToSection') {
          const label = originalTextOf(row.name) ?? `Section ${sections.length + 1}`;
          const sectionId = sections.push({ sourceKey: `${sourceKey}#/recipeInstructions/${order}`,
            label, language: languageOf(row.inLanguage, inheritedLanguage), parent: section,
            order: order++ }) - 1;
          addInstructions(row.itemListElement, sectionId, `${sourcePointer}/itemListElement`,
            languageOf(row.inLanguage, inheritedLanguage), depth + 1);
          continue;
        }
        if (row['@type'] !== undefined && row['@type'] !== 'HowToStep') {
          throw new RecipeInstructionNotSupported(sourcePointer);
        }
      }
      const text = instruction(item);
      if (!text) throw new RecipeInstructionNotSupported(sourcePointer);
      steps.push({ sourceKey: `${sourceKey}#/recipeInstructions/${order}`,
        sourcePointer, order: order++,
        text, language: item && typeof item === 'object' && !Array.isArray(item)
          ? languageOf((item as Record<string, unknown>).inLanguage, inheritedLanguage)
          : inheritedLanguage, section });
    }
  };
  addInstructions(root.recipeInstructions, -1, '/recipeInstructions', language);
  const occurrences = sections.length + ingredients.length + steps.length;
  if (occurrences > MAX_RECIPE_IMPORT_OCCURRENCES) {
    throw new RecipeNotImportable({ status: 'not-importable', code: 'recipe_not_importable',
      limit: 'occurrences', measured: occurrences, allowed: MAX_RECIPE_IMPORT_OCCURRENCES });
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
    slot: RecipeSourceSupportCandidate['slot'], pointer?: string): RecipeSourceSupportCandidate | undefined => {
    let base = pointer ?? pointerOf(sourceKey);
    if (base !== `/${sourceField}` && !base.startsWith(`/${sourceField}/`)) return undefined;
    let raw = at(base);
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
      'recipeInstructions', 'structure-occurrence-v1#qualifier.instructionText.value', item.sourcePointer)),
  ].filter((item): item is RecipeSourceSupportCandidate => item !== undefined);
}
