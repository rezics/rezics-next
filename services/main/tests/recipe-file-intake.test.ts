import { expect, test } from 'bun:test';
import { MAX_RECIPE_FILE_BYTES, parseRecipeFile, readRecipeFileBytes,
  RecipeFileInvalid, RecipeFileTooLarge } from '../src/modules/recipe/file-intake.ts';
import { RECIPE_UNIT_DEFINITIONS, RecipeUnitNotRegistered } from '../src/modules/recipe/display.ts';
import { MAX_RECIPE_IMPORT_BYTES, RecipeNotImportable } from '../src/modules/recipe/importer.ts';

const asBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const recipe = { '@type': 'Recipe', recipeIngredient: ['1 1/2 cups cream'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Cool gently.' }] };

test('file intake accepts one Schema.org Recipe and only projects importable fields', () => {
  const parsed = parseRecipeFile(asBytes({ ...recipe, '@context': 'https://schema.org',
    name: 'Crème brûlée', image: 'a handwritten recipe card' }), 'application/ld+json');
  expect(parsed.source).toEqual({ recipeIngredient: recipe.recipeIngredient,
    recipeInstructions: recipe.recipeInstructions });
  expect(parsed.preview.ingredients[0]?.qualifier.amount).toEqual({ numerator: 3, denominator: 2 });
  expect(parseRecipeFile(asBytes(recipe), 'application/json; charset=utf-8').preview.steps).toHaveLength(1);
});

test('file intake rejects invalid types, HTML, script content, remote URLs and JSON-LD graph features', () => {
  const invalidFiles: Array<[unknown, string]> = [
    [recipe, 'text/html'],
    [{ ...recipe, name: '<script>alert(1)</script>' }, 'application/json'],
    [{ ...recipe, recipeInstructions: ['Open https://example.com before cooking'] }, 'application/json'],
    [{ ...recipe, description: 'More at cookbook.example.com' }, 'application/json'],
    [{ ...recipe, recipeInstructions: ['Use data:text/html,<script>no</script>'] }, 'application/json'],
    [{ ...recipe, '@graph': [recipe] }, 'application/ld+json'],
    [{ ...recipe, '@context': 'https://attacker.example/context.jsonld' }, 'application/ld+json'],
    [{ ...recipe, recipeInstructions: [{ '@type': 'Recipe', recipeIngredient: ['salt'] }] }, 'application/json'],
    [{ '@type': 'Recipe', scripts: ['alert(1)'], recipeIngredient: ['salt'] }, 'application/json'],
    [{ '@type': 'Recipe', recipeIngredient: ['salt'], recipeInstructions: ['<b>serve</b>'] }, 'application/json'],
    [{ '@type': 'Recipe', recipeIngredient: [], recipeInstructions: [] }, 'application/json'],
  ];
  for (const [document, mediaType] of invalidFiles) {
    expect(() => parseRecipeFile(asBytes(document), mediaType)).toThrow(RecipeFileInvalid);
  }
  expect(() => parseRecipeFile(Buffer.from('{'), 'application/json')).toThrow(RecipeFileInvalid);
  expect(() => parseRecipeFile(asBytes(recipe), 'application/xml')).toThrow(RecipeFileInvalid);
  expect(() => parseRecipeFile(asBytes({ ...recipe, '@context': { '@vocab': 'https://schema.org' } }),
    'application/ld+json')).toThrow(RecipeFileInvalid);
});

test('file intake accepts exactly 256 KiB and rejects the next byte before parsing', async () => {
  const prefix = '{"@type":"Recipe","recipeIngredient":["1 cup flour"],"name":"';
  const suffix = '"}';
  const exact = Buffer.from(`${prefix}${'x'.repeat(MAX_RECIPE_FILE_BYTES - Buffer.byteLength(prefix)
    - Buffer.byteLength(suffix))}${suffix}`);
  expect(exact.byteLength).toBe(MAX_RECIPE_FILE_BYTES);
  expect(parseRecipeFile(exact, 'application/json').preview.ingredients).toHaveLength(1);

  const tooLarge = Buffer.concat([exact, Buffer.from(' ')]);
  expect(() => parseRecipeFile(tooLarge, 'application/json')).toThrow(RecipeFileTooLarge);
  const request = new Request('http://main.local/upload', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: new Blob([tooLarge]) });
  await expect(readRecipeFileBytes(request)).rejects.toBeInstanceOf(RecipeFileTooLarge);
});

test('file intake admits each native unit identifier only in consumed ingredient rows', () => {
  expect(RECIPE_UNIT_DEFINITIONS.size).toBeGreaterThan(0);
  for (const unitCode of RECIPE_UNIT_DEFINITIONS.keys()) {
    const ingredient = { '@type': 'PropertyValue', text: '200 g butter', name: 'butter',
      value: '200', unitText: 'g', unitCode };
    for (const recipeIngredient of [[ingredient], { itemListElement: [ingredient] }]) {
      const parsed = parseRecipeFile(asBytes({ ...recipe, '@context': 'https://schema.org',
        recipeIngredient }), 'application/ld+json');
      expect(parsed.preview.ingredients[0]?.qualifier.unit).toBe(unitCode);
      expect(parsed.preview.ingredients[0]?.qualifier.originalText.value).toBe('200 g butter');
    }
  }
});

test('file intake rejects unknown or altered unit identifiers and identifiers outside their field', () => {
  for (const unitCode of RECIPE_UNIT_DEFINITIONS.keys()) {
    const ingredient = { text: '200 g butter', value: '200', unitCode };
    const documents = [
      { ...recipe, unitCode },
      { ...recipe, description: unitCode },
      { ...recipe, recipeInstructions: [{ text: 'Stir gently.', unitCode }] },
      { ...recipe, recipeIngredient: [unitCode] },
      { ...recipe, recipeIngredient: [{ ...ingredient, name: unitCode }] },
      { ...recipe, recipeIngredient: [{ ...ingredient, text: unitCode }] },
      { ...recipe, recipeIngredient: [{ ...ingredient, unitText: unitCode }] },
      { ...recipe, recipeIngredient: [{ text: 'butter', metadata: { unitCode } }] },
      { ...recipe, recipeIngredient: [{ text: 'butter', unitCode: [unitCode] }] },
      { ...recipe, recipeIngredient: [{ text: 'butter', unitCode: { value: unitCode } }] },
      { ...recipe, recipeIngredient: [[ingredient]] },
      { ...recipe, recipeIngredient: ingredient },
      { ...recipe, recipeIngredient: { itemListElement: ['butter'], unitCode } },
      { ...recipe, recipeIngredient: { itemListElement: [[ingredient]] } },
      { ...recipe, metadata: { recipeIngredient: [ingredient] } },
    ];
    for (const document of documents) {
      expect(() => parseRecipeFile(asBytes(document), 'application/json')).toThrow(RecipeFileInvalid);
    }
    for (const altered of [`${unitCode}?download=1`, `${unitCode}#term`, `${unitCode}/`,
      ` ${unitCode}`, `${unitCode} `, unitCode.replace('https:', 'http:')]) {
      expect(() => parseRecipeFile(asBytes({ ...recipe,
        recipeIngredient: [{ ...ingredient, unitCode: altered }] }), 'application/json'))
        .toThrow(RecipeUnitNotRegistered);
    }
  }
  for (const unitCode of ['https://qudt.org/vocab/unit/UnknownUnit', 'https://schema.org',
    'https://example.com/unit/GM']) {
    expect(() => parseRecipeFile(asBytes({ ...recipe,
      recipeIngredient: [{ text: '200 g butter', unitCode }] }), 'application/json'))
      .toThrow(RecipeUnitNotRegistered);
  }
});

test('hostile strings remain invalid across recipe fields and nested shapes', () => {
  const hostileStrings = ['<b>butter</b>', '<SCRIPT>alert(1)</SCRIPT>', 'javascript:alert(1)',
    'vbscript:run()', 'data:text/plain,hello', 'https://example.com/recipe', '//example.com/recipe',
    'www.example.com/recipe', 'https://schema.org'];
  for (const hostile of hostileStrings) {
    const documents = [
      { ...recipe, name: hostile },
      { ...recipe, recipeIngredient: [hostile] },
      { ...recipe, recipeIngredient: [{ text: 'butter', unitCode: hostile }] },
      { ...recipe, recipeIngredient: { itemListElement: [{ text: hostile }] } },
      { ...recipe, recipeInstructions: [{ '@type': 'HowToStep', text: hostile }] },
      { ...recipe, metadata: [{ nested: { description: hostile } }] },
    ];
    for (const [index, document] of documents.entries()) {
      expect(() => parseRecipeFile(asBytes(document), 'application/json')).toThrow(
        index === 2 && hostileStrings.indexOf(hostile) >= 5
          ? RecipeUnitNotRegistered : RecipeFileInvalid);
    }
  }
});

test('hostile graph keywords, scripts and structure bounds remain invalid', () => {
  const hostileKeys = ['@graph', '@id', '@reverse', '@included', '@list', '@value', '@unknown',
    '@context', 'script', 'ScRiPtS', 'https://example.com/property', '//example.com/property'];
  for (const key of hostileKeys) {
    for (const metadata of [{ [key]: 'blocked' }, [{ nested: { [key]: 'blocked' } }]]) {
      expect(() => parseRecipeFile(asBytes({ ...recipe, metadata }), 'application/json'))
        .toThrow(RecipeFileInvalid);
    }
  }
  let nested: unknown = 'safe text';
  for (let depth = 0; depth < 33; depth++) nested = { nested };
  for (const metadata of [nested, Array.from({ length: 8193 }, () => 'safe text')]) {
    expect(() => parseRecipeFile(asBytes({ ...recipe, metadata }), 'application/json'))
      .toThrow(RecipeFileInvalid);
  }
  expect(() => parseRecipeFile(asBytes({ ...recipe, '@context': 'https://schema.org/' }),
    'application/ld+json')).toThrow(RecipeFileInvalid);
});

test('shared shape measurement retains the 8192-value boundary with or without the fixed context', () => {
  for (const context of [undefined, 'https://schema.org']) {
    const document = { '@type': 'Recipe', ...(context ? { '@context': context } : {}),
      recipeIngredient: ['salt'], metadata: Array.from({ length: 8187 }, () => 'safe') };
    expect(parseRecipeFile(asBytes(document), 'application/json').preview.ingredients).toHaveLength(1);
    document.metadata.push('one too many');
    expect(() => parseRecipeFile(asBytes(document), 'application/json')).toThrow(RecipeFileInvalid);
  }
});

test('file intake retains typed occurrence outcomes from normalization', () => {
  const document = { '@type': 'Recipe', recipeIngredient: Array.from({ length: 129 }, () => 'salt') };
  let error: unknown;
  try { parseRecipeFile(asBytes(document), 'application/json'); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RecipeNotImportable);
  expect(error).not.toBeInstanceOf(RecipeFileInvalid);
  expect(error).toMatchObject({ code: 'recipe_not_importable', limit: 'occurrences',
    measured: 129, allowed: 128 });
});

test('byte limit outcomes carry the exact parsed, declared and cumulative stream sizes', async () => {
  const allowed = Math.min(MAX_RECIPE_FILE_BYTES, MAX_RECIPE_IMPORT_BYTES);
  const bytes = new Uint8Array(allowed + 1);
  let parsedError: unknown;
  try { parseRecipeFile(bytes, 'application/json'); }
  catch (caught) { parsedError = caught; }
  expect(parsedError).toBeInstanceOf(RecipeFileTooLarge);
  expect(parsedError).toBeInstanceOf(RecipeNotImportable);
  expect(parsedError).toMatchObject({ code: 'recipe_not_importable', limit: 'bytes',
    measured: bytes.byteLength, allowed });

  const declaredSize = MAX_RECIPE_FILE_BYTES + 27;
  const declared = new Request('http://main.local/upload', { method: 'POST',
    headers: { 'content-length': String(declaredSize) }, body: 'salt' });
  await expect(readRecipeFileBytes(declared)).rejects.toMatchObject({
    code: 'recipe_not_importable', limit: 'bytes', measured: declaredSize,
    allowed: MAX_RECIPE_FILE_BYTES });

  let canceled = false;
  const chunks = [new Uint8Array(MAX_RECIPE_FILE_BYTES - 7), new Uint8Array(19)];
  const streamed = new Request('http://main.local/upload', { method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
      },
      cancel() { canceled = true; },
    }) });
  await expect(readRecipeFileBytes(streamed)).rejects.toMatchObject({
    code: 'recipe_not_importable', limit: 'bytes', measured: MAX_RECIPE_FILE_BYTES + 12,
    allowed: MAX_RECIPE_FILE_BYTES });
  expect(canceled).toBe(true);
});

test('unregistered native identities are typed unit refusals, never inferred from a namespace', () => {
  const unitCode = 'https://rezics.com/id/00000000-0000-4000-8000-000000000090';
  const ingredient = { text: '200 g butter', value: '200', unitCode };
  expect(() => parseRecipeFile(asBytes({ ...recipe, recipeIngredient: [ingredient] }), 'application/json'))
    .toThrow(RecipeUnitNotRegistered);
  for (const altered of [`${unitCode}?a=1`, `${unitCode}#unit`, `${unitCode}/`,
    ` ${unitCode}`, `${unitCode} `, `${unitCode}\n`, `${unitCode}\r\n`,
    unitCode.replace('rezics.com', 'rezics.com.attacker.example')]) {
    expect(() => parseRecipeFile(asBytes({ ...recipe,
      recipeIngredient: [{ ...ingredient, unitCode: altered }] }), 'application/json'))
      .toThrow(RecipeUnitNotRegistered);
  }
  for (const document of [{ ...recipe, recipeIngredient: [{ text: unitCode }] },
    { ...recipe, description: unitCode }, { ...recipe, recipeInstructions: [{ text: 'Stir.', unitCode }] }]) {
    expect(() => parseRecipeFile(asBytes(document), 'application/json')).toThrow(RecipeFileInvalid);
  }
});
