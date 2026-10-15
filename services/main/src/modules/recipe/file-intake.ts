import { importRecipe, MAX_RECIPE_IMPORT_BYTES, MAX_RECIPE_JSON_DEPTH, measureRecipeJSON,
  RecipeNotImportable, RecipeInstructionNotSupported, type RecipeImport } from './importer.ts';
import { RECIPE_UNIT_DEFINITIONS, RecipeUnitNotRegistered } from './display.ts';
import { isStructureUnitReference } from '../structure/format.ts';
import { MAX_RETAINED_SOURCE_BYTES } from '../source/intake.ts';

export const MAX_RECIPE_FILE_BYTES = MAX_RETAINED_SOURCE_BYTES;
const SCHEMA_CONTEXT = 'https://schema.org';
const REMOTE_URL = /(?:\b[a-z][a-z\d+.-]*:\/\/|\/\/|(?:^|\s)(?:www\.)?[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}(?:\/[^\s]*)?)/i;
const HTML_MARKUP = /<\/?[a-z][^>]*>/i;
const SCRIPT_URL = /\b(?:javascript|vbscript|data)\s*:/i;
const GRAPH_KEYWORDS = new Set(['@graph', '@id', '@reverse', '@included', '@list', '@value']);
const IMPORTABLE_FIELDS = new Set(['inLanguage', 'recipeIngredient', 'recipeInstructions']);

export class RecipeFileInvalid extends Error {}
export class RecipeFileTooLarge extends RecipeNotImportable {
  constructor(measured: number, allowed = MAX_RECIPE_FILE_BYTES) {
    super({ status: 'not-importable', code: 'recipe_not_importable', limit: 'bytes', measured, allowed });
  }
}

function invalid(message: string): never {
  throw new RecipeFileInvalid(message);
}

function checkMediaType(value: string | null): void {
  if (!value) invalid('Recipe file must use application/json or application/ld+json');
  const [mediaType, ...parameters] = value.split(';').map(part => part.trim());
  if (mediaType?.toLowerCase() !== 'application/json'
    && mediaType?.toLowerCase() !== 'application/ld+json') {
    invalid('Recipe file must use application/json or application/ld+json');
  }
  if (parameters.some(parameter => !/^charset\s*=\s*utf-8$/i.test(parameter))) {
    invalid('Recipe file must be UTF-8');
  }
}

type InspectionLocation = 'other' | 'ingredients' | 'ingredient' | 'unit-code';

function inspect(value: unknown, root: boolean, context: string | undefined,
  state: { recipes: number },
  location: InspectionLocation = 'other'): void {
  if (typeof value === 'string') {
    if (HTML_MARKUP.test(value) || SCRIPT_URL.test(value)) invalid('HTML and scripts are not recipe files');
    if (location === 'unit-code' && (isStructureUnitReference(value) || REMOTE_URL.test(value))
      && !RECIPE_UNIT_DEFINITIONS.has(value)) {
      throw new RecipeUnitNotRegistered(value);
    }
    if (REMOTE_URL.test(value) && !(root && value === SCHEMA_CONTEXT && context === value)
      && !(location === 'unit-code' && RECIPE_UNIT_DEFINITIONS.has(value))) {
      invalid('Recipe file cannot contain remote URLs');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) inspect(child, false, context, state,
      location === 'ingredients' ? 'ingredient' : 'other');
    return;
  }
  if (!value || typeof value !== 'object') return;

  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (GRAPH_KEYWORDS.has(key) || /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/)/i.test(key)) {
      invalid('Recipe file cannot contain JSON-LD graph references');
    }
    if (/^scripts?$/i.test(key)) invalid('Recipe file cannot contain scripts');
    if (key.startsWith('@') && !(root && key === '@context') && key !== '@type') {
      invalid('Recipe file contains an unsupported JSON-LD keyword');
    }
    if (key === '@context' && (!root || child !== SCHEMA_CONTEXT)) {
      invalid('Recipe file must use the fixed Schema.org context');
    }
    if (key === '@context') continue;
    if (key === '@type') {
      if (typeof child !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(child)) {
        invalid('Recipe types must use a local Schema.org name');
      }
      if (root) {
        if (child !== 'Recipe') invalid('File must contain one Schema.org Recipe');
        state.recipes++;
      } else if (child === 'Recipe') {
        invalid('Recipe file cannot contain a second Recipe');
      }
    }
    // Only the two ingredient-list forms consumed by the importer admit inert unit identifiers.
    const childLocation: InspectionLocation = root && key === 'recipeIngredient'
      || location === 'ingredients' && key === 'itemListElement' && Array.isArray(child)
      ? 'ingredients' : location === 'ingredient' && key === 'unitCode' && typeof child === 'string'
        ? 'unit-code' : 'other';
    inspect(child, false, context, state, childLocation);
  }
}

/** Read the raw request body with a hard byte ceiling before parsing or retaining it. */
export async function readRecipeFileBytes(request: Request, maximum = MAX_RECIPE_FILE_BYTES): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
      invalid('Recipe file content length is invalid');
    }
    if (Number(declared) > maximum) throw new RecipeFileTooLarge(Number(declared), maximum);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - length) {
        void reader.cancel().catch(() => undefined);
        throw new RecipeFileTooLarge(length + value.byteLength, maximum);
      }
      chunks.push(value);
      length += value.byteLength;
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Accept only a single local Schema.org Recipe; no JSON-LD processor or remote fetch is used. */
export function parseRecipeFile(bytes: Uint8Array, mediaType: string | null): {
  source: Record<string, unknown>; preview: RecipeImport;
} {
  if (bytes.byteLength > MAX_RECIPE_FILE_BYTES || bytes.byteLength > MAX_RECIPE_IMPORT_BYTES) {
    throw new RecipeFileTooLarge(bytes.byteLength, Math.min(MAX_RECIPE_FILE_BYTES, MAX_RECIPE_IMPORT_BYTES));
  }
  checkMediaType(mediaType);
  let document: unknown;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('Recipe file is not valid UTF-8 JSON'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    invalid('Recipe file must have one Recipe object at its root');
  }
  const root = document as Record<string, unknown>;
  if (root['@type'] !== 'Recipe') invalid('File must contain one Schema.org Recipe');
  const context = root['@context'];
  if (context !== undefined && context !== SCHEMA_CONTEXT) {
    invalid('Recipe file must use the fixed Schema.org context');
  }
  if (mediaType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/ld+json'
    && context !== SCHEMA_CONTEXT) {
    invalid('JSON-LD Recipe file must name the fixed Schema.org context');
  }
  const state = { recipes: 0 };
  const shape = measureRecipeJSON(root);
  if (shape.depth > MAX_RECIPE_JSON_DEPTH || shape.values > 8192) {
    invalid('Recipe file exceeds the supported JSON structure bound');
  }
  inspect(root, true, typeof context === 'string' ? context : undefined, state);
  if (state.recipes !== 1) invalid('File must contain one Schema.org Recipe');

  const source: Record<string, unknown> = {};
  for (const field of IMPORTABLE_FIELDS) {
    if (Object.hasOwn(root, field)) source[field] = root[field];
  }
  let preview: RecipeImport;
  try { preview = importRecipe(source, 'recipe-file-preview'); }
  catch (error) {
    if (error instanceof RecipeNotImportable || error instanceof RecipeInstructionNotSupported) throw error;
    invalid(error instanceof Error ? error.message : 'Recipe content is invalid');
  }
  if (!preview.ingredients.length && !preview.steps.length && !preview.sections.length) {
    invalid('Recipe file has no importable occurrences');
  }
  return { source, preview };
}

/** Cancel a body left unread by authorization or media-type rejection. */
export function cancelRecipeFileBody(request: Request): void {
  if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined);
}
