import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
type Locale = (typeof locales)[number];
type Token = { value: string; kind: 'word' | 'string' | 'punct'; start: number; end: number };
export type Message = { bindings: string[]; placeholders: string[]; placeholderErrors: string[] };
type Catalog = Map<string, Message>;
type CatalogSpec = { app: 'web' | 'accounts'; namespace: string; english: string; inline?: boolean;
  localeFiles?: Partial<Record<Locale, string>> };

const webFeatures = ['auth', 'author', 'catalogue', 'concept', 'discover', 'feed', 'home', 'library', 'manage', 'onboarding', 'profile', 'realm',
  'search', 'settings', 'shell', 'studio', 'work', 'work-page', 'zones'] as const;
const accountsFeatures = ['shell', 'auth', 'consent', 'account', 'admin'] as const;
const specs: CatalogSpec[] = [
  ...webFeatures.map(feature => {
    const namespace = feature === 'work-page' ? 'workPage' : feature;
    const base = `apps/web/features/${feature}/messages`;
    // A feature with a messages/ directory keeps one file per locale; the rest are still inline.
    if (existsSync(resolve(root, base))) {
      return { app: 'web' as const, namespace, english: `${base}.ts`, localeFiles: Object.fromEntries(
        locales.filter(locale => locale !== 'en').map(locale => [locale, `${base}/${locale}.ts`])) as
          Partial<Record<Locale, string>> };
    }
    return { app: 'web' as const, namespace, english: `${base}.ts`, inline: true };
  }),
  ...accountsFeatures.map(feature => {
    const namespace = feature === 'shell' ? 'common' : feature;
    const base = `apps/accounts/features/${feature}/messages`;
    return { app: 'accounts' as const, namespace, english: `${base}/en.ts`, localeFiles: Object.fromEntries(
      locales.filter(locale => locale !== 'en').map(locale => [locale, `${base}/${locale}.ts`])) as
        Partial<Record<Locale, string>> };
  }),
];

function tokenize(source: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < source.length;) {
    const start = index;
    const char = source[index]!;
    if (/\s/.test(char)) { index++; continue; }
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index++;
      let value = '';
      while (index < source.length) {
        const current = source[index++]!;
        if (current === '\\') {
          const escaped = source[index++];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped ?? '';
        } else if (current === quote) break;
        else value += current;
      }
      result.push({ value, kind: 'string', start, end: index });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      index++;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) index++;
      result.push({ value: source.slice(start, index), kind: 'word', start, end: index });
      continue;
    }
    if (/[0-9]/.test(char)) {
      index++;
      while (index < source.length && /[0-9.]/.test(source[index]!)) index++;
      result.push({ value: source.slice(start, index), kind: 'word', start, end: index });
      continue;
    }
    result.push({ value: char, kind: 'punct', start, end: ++index });
  }
  return result;
}

function matching(tokens: Token[], open: number): number | undefined {
  const closeFor: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const firstClose = closeFor[tokens[open]?.value ?? ''];
  if (!firstClose) return undefined;
  const stack = [firstClose];
  for (let index = open + 1; index < tokens.length; index++) {
    const value = tokens[index]!.value;
    if (closeFor[value]) stack.push(closeFor[value]!);
    else if (value === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return index;
    }
  }
  return undefined;
}

type Property = { key: string; start: number; end: number };
function properties(tokens: Token[], open: number): Property[] {
  const close = matching(tokens, open);
  if (close === undefined) return [];
  const result: Property[] = [];
  let index = open + 1;
  while (index < close) {
    if (tokens[index]!.value === ',' || tokens[index]!.value === ';') { index++; continue; }
    const keyToken = tokens[index]!;
    if (keyToken.value === '...') { index++; continue; }
    if (keyToken.kind !== 'word' && keyToken.kind !== 'string') { index++; continue; }
    const key = keyToken.value;
    index++;
    if (tokens[index]?.value !== ':') {
      result.push({ key, start: index - 1, end: index });
      while (index < close && tokens[index]!.value !== ',') index++;
      continue;
    }
    const start = ++index;
    const stack: string[] = [];
    const closing: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
    while (index < close) {
      const value = tokens[index]!.value;
      if (closing[value]) stack.push(closing[value]!);
      else if (value === stack.at(-1)) stack.pop();
      else if (value === ',' && !stack.length) break;
      index++;
    }
    result.push({ key, start, end: index });
  }
  return result;
}

function variableObject(tokens: Token[], name: string): number | undefined {
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index]!.value !== 'const' || tokens[index + 1]!.value !== name) continue;
    let equals = index + 2;
    while (equals < tokens.length && tokens[equals]!.value !== '=' && tokens[equals]!.value !== ';') equals++;
    if (tokens[equals]?.value !== '=') continue;
    for (let value = equals + 1; value < tokens.length && tokens[value]!.value !== ';'; value++) {
      if (tokens[value]!.value === '{') return value;
    }
  }
  return undefined;
}

function defaultObject(tokens: Token[]): number | undefined {
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index]!.value === 'export' && tokens[index + 1]!.value === 'default') {
      for (let value = index + 2; value < tokens.length; value++) if (tokens[value]!.value === '{') return value;
    }
  }
  return undefined;
}

function inlineObject(tokens: Token[]): number | undefined {
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index]!.value !== 'const' || tokens[index + 1]!.value !== 'messages') continue;
    let cursor = index + 2;
    while (cursor < tokens.length && tokens[cursor]!.value !== '=') cursor++;
    while (cursor < tokens.length && tokens[cursor]!.value !== 'defineMessages') cursor++;
    if (tokens[cursor]?.value !== 'defineMessages') continue;
    while (cursor < tokens.length && tokens[cursor]!.value !== '{') cursor++;
    if (tokens[cursor]?.value === '{') return cursor;
  }
  return undefined;
}

type Range = { start: number; end: number };

function argumentsOf(tokens: Token[], open: number): Range[] {
  const close = matching(tokens, open);
  if (close === undefined) return [];
  const result: Range[] = [];
  const closing: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  let start = open + 1;
  for (let index = start; index < close; index++) {
    const value = tokens[index]!.value;
    if (closing[value]) stack.push(closing[value]!);
    else if (value === stack.at(-1)) stack.pop();
    else if (value === ',' && !stack.length) {
      result.push({ start, end: index });
      start = index + 1;
    }
  }
  if (start < close) result.push({ start, end: close });
  return result;
}

function analyzePlaceholders(tokens: Token[], start: number, end: number): Message {
  const inserts: Range[] = [];
  const plurals: Range[] = [];
  const bindings = new Set<string>();
  for (let index = start; index < end - 1; index++) {
    const name = tokens[index]!.value;
    if ((name !== 'insert' && name !== 'plural') || tokens[index + 1]?.value !== '(') continue;
    const args = argumentsOf(tokens, index + 1);
    if (name === 'insert' && args[0]) inserts.push(args[0]);
    if (name === 'plural' && args[0]) plurals.push(args[0]);
    const variables = args[1];
    if (variables && tokens[variables.start]?.value === '{') {
      for (const property of properties(tokens, variables.start)) bindings.add(property.key);
    }
  }

  const placeholders = new Set<string>();
  const placeholderErrors: string[] = [];
  for (let index = start; index < end; index++) {
    const token = tokens[index]!;
    if (token.kind !== 'string' || (!token.value.includes('{{') && !token.value.includes('}}'))) continue;
    const pattern = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\}/g;
    const matches = [...token.value.matchAll(pattern)];
    const remainder = token.value.replace(pattern, '');
    if (remainder.includes('{{') || remainder.includes('}}')) {
      placeholderErrors.push('contains a malformed or literal placeholder');
    }
    for (const match of matches) placeholders.add(match[1]!);
    const inInsert = inserts.some(range => index >= range.start && index < range.end);
    if (!inInsert) placeholderErrors.push('contains a placeholder outside insert()');
  }

  const undeclared = [...placeholders].filter(name => !bindings.has(name)
    && !(name === 'value' && plurals.length > 0)).sort();
  if (undeclared.length) placeholderErrors.push(`uses undeclared placeholder${undeclared.length === 1 ? '' : 's'}: ${undeclared.join(', ')}`);
  return { bindings: [...bindings].sort(), placeholders: [...placeholders].sort(),
    placeholderErrors: [...new Set(placeholderErrors)] };
}

/** Inspect one message expression; exported so the checker contract has focused regression tests. */
export function inspectMessagePlaceholders(source: string): Message {
  const tokens = tokenize(source);
  return analyzePlaceholders(tokens, 0, tokens.length);
}

export function unlistedWebFeatures(features: readonly string[], checked: readonly string[]): string[] {
  return features.filter(feature => !checked.includes(feature)).sort();
}

export function hasPlaceholderMismatch(english: Message, translated: Message): boolean {
  return english.placeholders.join('\0') !== translated.placeholders.join('\0');
}

function flatten(tokens: Token[], open: number, prefix = '', aliases = new Map<string, number>(), result: Catalog = new Map()): Catalog {
  for (const property of properties(tokens, open)) {
    const value = tokens[property.start];
    if (!value) continue;
    if (value.value === '{' && matching(tokens, property.start) === property.end - 1) {
      flatten(tokens, property.start, prefix ? `${prefix}.${property.key}` : property.key, aliases, result);
      continue;
    }
    if (property.end - property.start === 1 && value.kind === 'word' && aliases.has(value.value)) {
      flatten(tokens, aliases.get(value.value)!, prefix ? `${prefix}.${property.key}` : property.key, aliases, result);
      continue;
    }
    const key = prefix ? `${prefix}.${property.key}` : property.key;
    result.set(key, analyzePlaceholders(tokens, property.start, property.end));
  }
  return result;
}

function readFile(path: string): Token[] | undefined {
  try { return tokenize(readFileSync(resolve(root, path), 'utf8')); }
  catch { return undefined; }
}

function readCatalog(spec: CatalogSpec, locale: Locale): Catalog {
  if (spec.inline) {
    const tokens = readFile(spec.english);
    if (!tokens) return new Map();
    const open = inlineObject(tokens);
    if (open === undefined) return new Map();
    const aliases = new Map<string, number>();
    for (const name of ['en', 'zhCN']) {
      const object = variableObject(tokens, name);
      if (object !== undefined) aliases.set(name, object);
    }
    const name = locale === 'zh-Hans' ? 'zh-Hans' : locale;
    const property = properties(tokens, open).find(entry => entry.key === name)
      ?? (locale === 'zh-Hans' ? properties(tokens, open).find(entry => entry.key === 'zh-CN') : undefined);
    if (!property) return new Map();
    const value = tokens[property.start]!;
    const object = value.kind === 'word' && aliases.has(value.value) ? aliases.get(value.value) : property.start;
    return object === undefined ? new Map() : flatten(tokens, object, '', aliases);
  }

  const path = locale === 'en' ? spec.english : spec.localeFiles?.[locale];
  const tokens = path ? readFile(path) : undefined;
  if (!tokens) return new Map();
  const open = locale === 'en' && spec.app === 'web'
    ? variableObject(tokens, 'en') ?? variableObject(tokens, 'messages') : defaultObject(tokens);
  return open === undefined ? new Map() : flatten(tokens, open);
}

function runCheck(): void {
  const failures: string[] = [];
  const featureRoot = resolve(root, 'apps/web/features');
  const discoveredFeatures = readdirSync(featureRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(resolve(featureRoot, entry.name, 'messages.ts')))
    .map(entry => entry.name);
  const unlisted = unlistedWebFeatures(discoveredFeatures, webFeatures);
  if (unlisted.length) failures.push(`web features missing from the checker list: ${unlisted.join(', ')}`);

  for (const spec of specs) {
    const english = readCatalog(spec, 'en');
    const expectedKeys = new Set(english.keys());
    for (const locale of locales) {
      const translated = locale === 'en' ? english : readCatalog(spec, locale);
      const actualKeys = new Set(translated.keys());
      const missing = [...expectedKeys].filter(key => !actualKeys.has(key)).sort();
      const extra = [...actualKeys].filter(key => !expectedKeys.has(key)).sort();
      const placeholders = [...actualKeys].filter(key => expectedKeys.has(key)
        && hasPlaceholderMismatch(english.get(key)!, translated.get(key)!)).sort();
      const invalidPlaceholders = [...translated].flatMap(([key, message]) => message.placeholderErrors.map(error => `${key} (${error})`));
      const status = `missing=${missing.length}${missing.length ? ` [${missing.join(', ')}]` : ''}; `
        + `extra=${extra.length}${extra.length ? ` [${extra.join(', ')}]` : ''}; `
        + `placeholder mismatches=${placeholders.length}${placeholders.length ? ` [${placeholders.join(', ')}]` : ''}; `
        + `invalid placeholders=${invalidPlaceholders.length}${invalidPlaceholders.length ? ` [${invalidPlaceholders.join(', ')}]` : ''}`;
      console.log(`${spec.app}/${locale}/${spec.namespace}: ${status}`);
      if (extra.length) failures.push(`${spec.app}/${locale}/${spec.namespace} extra keys: ${extra.join(', ')}`);
      if (placeholders.length) failures.push(
        `${spec.app}/${locale}/${spec.namespace} placeholder mismatches: ${placeholders.join(', ')}`);
      if (invalidPlaceholders.length) failures.push(
        `${spec.app}/${locale}/${spec.namespace} invalid placeholders: ${invalidPlaceholders.join(', ')}`);
    }
  }

  if (failures.length) {
    console.error('\nCatalog errors:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) runCheck();
