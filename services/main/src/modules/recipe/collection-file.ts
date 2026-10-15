import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readCollectionArchive } from './collection-archive.ts';
import { authoredDocumentBody } from '../../../../content/src/document-body.ts';
import { RecipeNotImportable } from './importer.ts';
import type { DocumentNode, DocumentSnapshot, JsonValue } from '@rezics/document';
import { canonicalLanguage } from '../display-language/tag.ts';
import { importRecipe, measureRecipeJSON, type RecipeImport } from './importer.ts';
import { RecipeFileInvalid } from './file-intake.ts';

export type RecipeCollectionFormat = 'paprikarecipes' | 'melarecipes' | 'melarecipe';
export const RECIPE_COLLECTION_LIMITS = { bytes: 16 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024,
  recipes: 5_000, recipeBytes: 256 * 1024, page: 8 } as const;
export const recipeCollectionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
function invalid(message: string): never { throw new RecipeFileInvalid(message); }
export interface CollectionFileEntry { name: string; bytes?: Uint8Array; value?: unknown; error?: string }
export interface CollectionRecipe {
  provider: 'paprika' | 'mela'; identity: string; title: string; language: string;
  source: Record<string, unknown>; parsed: RecipeImport; document: DocumentSnapshot;
  categories: string[]; rating?: unknown; photos: string[]; retainedOnly: string[];
}

function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { return invalid('Recipe must contain UTF-8 JSON'); }
}

/** Mela documents a ZIP collection; JSON arrays from other exporters are also accepted.
 * Archive names are never paths on disk. Both compression layers have independent budgets. */
export function readRecipeCollection(bytes: Uint8Array, format: RecipeCollectionFormat): CollectionFileEntry[] {
  if (bytes.byteLength > RECIPE_COLLECTION_LIMITS.bytes) invalid('Recipe collection exceeds its byte budget');
  if (format === 'melarecipe') return [{ name: 'recipe.melarecipe', bytes }];
  if (format === 'melarecipes' && bytes[0] !== 0x50) {
    const value = json(bytes);
    const rows = Array.isArray(value) ? value : value && typeof value === 'object'
      ? (value as Record<string, unknown>).recipes : undefined;
    if (!Array.isArray(rows) || !rows.length || rows.length > RECIPE_COLLECTION_LIMITS.recipes) {
      invalid('Mela collection must contain a bounded recipe array or ZIP');
    }
    return rows.map((value, index) => ({ name: `${index}.melarecipe`, value }));
  }
  let count = 0, expanded = 0;
  const names = new Set<string>();
  const entries: CollectionFileEntry[] = [];
  try {
    const files = readCollectionArchive(bytes, entry => {
      if (++count > RECIPE_COLLECTION_LIMITS.recipes || names.has(entry.name)
        || /[\u0000-\u001f\\]/.test(entry.name) || entry.name.startsWith('/')
        || entry.name.split('/').some(part => part === '..' || part === '.' || part === '__proto__')) {
        invalid('Recipe ZIP has duplicate, unsafe or too many entries');
      }
      names.add(entry.name);
      expanded += entry.originalSize;
      if (expanded > RECIPE_COLLECTION_LIMITS.expandedBytes) invalid('Recipe ZIP exceeds its expanded byte budget');
      if (entry.name.endsWith('/')) return false;
      const suffix = format === 'paprikarecipes' ? '.paprikarecipe' : '.melarecipe';
      if (!entry.name.toLowerCase().endsWith(suffix)) {
        entries.push({ name: entry.name, error: 'unsupported-archive-entry' });
        return false;
      }
      if (entry.originalSize > RECIPE_COLLECTION_LIMITS.recipeBytes) {
        entries.push({ name: entry.name, error: 'recipe-byte-limit' });
        return false;
      }
      return true;
    });
    let decoded = 0;
    for (const [name, entry] of Object.entries(files)) {
      try {
        const raw = format === 'paprikarecipes' ? gunzipSync(entry,
          { maxOutputLength: RECIPE_COLLECTION_LIMITS.recipeBytes }) : entry;
        decoded += raw.byteLength;
        if (decoded > RECIPE_COLLECTION_LIMITS.expandedBytes) invalid('Recipe collection exceeds its decoded byte budget');
        entries.push({ name, bytes: raw });
      } catch (error) {
        if (error instanceof RecipeFileInvalid) throw error;
        entries.push({ name, error: 'invalid-or-oversized-gzip' });
      }
    }
  } catch (error) {
    if (error instanceof RecipeFileInvalid) throw error;
    invalid('Recipe collection is not a supported ZIP');
  }
  if (!entries.length) invalid('Recipe collection is empty');
  return entries;
}

const document = (content: DocumentNode[]): DocumentSnapshot => ({ version: 'rezics-document-v1',
  profile: 'blocks', doc: { type: 'doc', content } });
const paragraph = (id: string, text: string): DocumentNode => ({ type: 'paragraph', attrs: { id },
  ...(text ? { content: [{ type: 'text', text }] } : {}) });

export function normalizeCollectionRecipe(entry: CollectionFileEntry, format: RecipeCollectionFormat): CollectionRecipe {
  try {
    const recipe = normalize(entry, format);
    authoredDocumentBody({ document: recipe.document });
    return recipe;
  } catch (error) {
    if (error instanceof RecipeFileInvalid || error instanceof RecipeNotImportable) throw error;
    return invalid(error instanceof Error ? error.message : 'Invalid recipe');
  }
}

function normalize(entry: CollectionFileEntry, format: RecipeCollectionFormat): CollectionRecipe {
  if (entry.error) invalid(entry.error);
  const input = entry.bytes ? json(entry.bytes) : entry.value;
  const shape = measureRecipeJSON(input);
  if (shape.depth > 32 || shape.values > 8192 || Buffer.byteLength(JSON.stringify(input) ?? '') > RECIPE_COLLECTION_LIMITS.recipeBytes) {
    invalid('Recipe exceeds its JSON budget');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Recipe must be a JSON object');
  const source = input as Record<string, unknown>, paprika = format === 'paprikarecipes';
  const text = (key: string, maximum = 32_000): string => {
    const value = source[key];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > maximum) invalid(`Invalid recipe field: ${key}`);
    return value;
  };
  const title = text(paprika ? 'name' : 'title', 200);
  if (!title.trim() || /[\u0000-\u001f\u007f]/.test(title)) invalid('Recipe needs a bounded title');
  const language = canonicalLanguage(text('inLanguage', 35) || 'und');
  if (!language) invalid('Invalid recipe language');
  const id = text(paprika ? 'uid' : 'id', 2048);
  const identity = id || recipeCollectionDigest(source);
  const ingredients = text('ingredients').split(/\r?\n/).filter(line => line.trim());
  // The established exchange parser owns exact fractions, ranges and absent units.
  const parsed = importRecipe({ '@type': 'Recipe', inLanguage: language,
    recipeIngredient: ingredients, recipeInstructions: [] }, `recipe-collection:${recipeCollectionDigest([format, identity])}`);
  const directions = text(paprika ? 'directions' : 'instructions');
  const lines = directions.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > 128 || lines.some(line => line.length > 4000)) invalid('Recipe procedure exceeds its step budget');
  const blocks: DocumentNode[] = [];
  if (lines.length) blocks.push({ type: 'extensionBlock', attrs: { id: 'procedure',
    definition: 'https://rezics.com/definition/procedure-v1', version: '1', fallback: directions,
    payload: { items: lines.map((line, index) => ({ type: 'HowToStep', id: `step-${index}`,
      document: document([paragraph(`line-${index}`, line)]) })) } as unknown as JsonValue } });
  for (const key of [paprika ? 'description' : 'text', 'notes']) {
    const value = text(key);
    if (value) blocks.push(paragraph(key, value));
  }
  if (!blocks.length) blocks.push(paragraph('empty', ''));
  const categories = source.categories ?? [];
  if (!Array.isArray(categories) || categories.length > 20
    || categories.some(item => typeof item !== 'string' || !item.trim() || item.length > 300)) invalid('Invalid recipe categories');
  const photos: string[] = [];
  const addPhoto = (photo: unknown) => {
    if (typeof photo !== 'string') invalid('Invalid recipe photo');
    if (photo) photos.push(photo);
  };
  if (paprika) {
    if (source.photo_data) addPhoto(source.photo_data);
    if (source.photos !== undefined) {
      if (!Array.isArray(source.photos)) invalid('Invalid recipe photos');
      for (const photo of source.photos) addPhoto(photo && typeof photo === 'object' ? photo.data : undefined);
    }
  } else if (source.images !== undefined) {
    if (!Array.isArray(source.images)) invalid('Invalid recipe images');
    source.images.forEach(addPhoto);
  }
  if (photos.length > 16) invalid('Too many recipe photos');
  const mapped = new Set([paprika ? 'name' : 'title', paprika ? 'uid' : 'id', 'inLanguage', 'ingredients',
    paprika ? 'directions' : 'instructions', paprika ? 'description' : 'text', 'notes', 'categories',
    'rating', 'photo_data', 'photos', 'images']);
  return { provider: paprika ? 'paprika' : 'mela', identity, title, language, source, parsed,
    document: document(blocks), categories: [...new Set(categories as string[])],
    ...(source.rating !== undefined ? { rating: source.rating } : {}), photos,
    retainedOnly: Object.keys(source).filter(key => !mapped.has(key)) };
}
