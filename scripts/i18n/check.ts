import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Interface locales. English is the authoring contract; every other locale must match its keys. */
export const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export type Locale = (typeof locales)[number];
const translated = locales.filter((locale): locale is Exclude<Locale, 'en'> => locale !== 'en');

const root = resolve(import.meta.dir, '../..');
const placeholder = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\}/g;

type Leaf = { kind: string; text: string; names: string[]; invalid: string[]; empty: boolean };
export type Catalog = {
  id: string;
  locales: Partial<Record<Locale, unknown>>;
  /** Locale objects readers actually receive, when those differ from the raw files. */
  resolved?: Partial<Record<Locale, unknown>>;
  loadError?: string;
};

function isNative(value: unknown): value is { $nativeI18n: 1; op: string; pattern?: string } {
  return (
    !!value && typeof value === 'object' && (value as { $nativeI18n?: unknown }).$nativeI18n === 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A string, a native-i18n node, or a function such as a Zone interpolator. */
function isMessageLeaf(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'function' || isNative(value);
}

function localeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => (locales as readonly string[]).includes(key));
}

/** `{ title: { en: '...', 'zh-Hant': '...' } }` from `indexCatalog`. */
function isIndexed(value: unknown): value is Record<string, Record<string, unknown>> {
  if (!isRecord(value) || isNative(value)) return false;
  const rows = Object.values(value);
  if (!rows.length) return false;
  return rows.every((row) => {
    if (!isRecord(row) || isNative(row) || !('en' in row)) return false;
    const keys = localeKeys(row);
    return keys.length >= 2 && keys.every((key) => isMessageLeaf(row[key]));
  });
}

function isCatalogBody(value: unknown): boolean {
  if (!isRecord(value) || isNative(value)) return false;
  const entries = Object.values(value);
  return (
    entries.length === 0 || entries.every((item) => isMessageLeaf(item) || isCatalogBody(item))
  );
}

/** `{ en: { title: '...' }, 'zh-Hant': { title: '...' } }` from `defineMessages` or a Zone table. */
export function isLocaleMap(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || isNative(value) || isIndexed(value)) return false;
  if (!isRecord(value.en) || isNative(value.en)) return false;
  return localeKeys(value).length >= 2 && isCatalogBody(value.en);
}

function collect(
  value: unknown,
  insideInsert: boolean,
  names: Set<string>,
  invalid: string[],
): void {
  if (typeof value === 'string' || typeof value === 'function') {
    const text = typeof value === 'string' ? value : '';
    if (typeof value === 'function') return;
    const found = [...text.matchAll(placeholder)].map((match) => match[1]!);
    const remainder = text.replace(placeholder, '');
    if (remainder.includes('{{') || remainder.includes('}}'))
      invalid.push('contains a malformed placeholder');
    if (!insideInsert && (found.length > 0 || remainder.includes('{{')))
      invalid.push('contains a placeholder outside insert()');
    for (const name of found) names.add(name);
    return;
  }
  if (!isRecord(value)) return;
  if (isNative(value) && value.op === 'insert' && typeof value.pattern === 'string') {
    collect(value.pattern, true, names, invalid);
    return;
  }
  for (const child of Object.values(value)) collect(child, insideInsert, names, invalid);
}

function leaf(value: unknown): Leaf {
  const names = new Set<string>();
  const invalid: string[] = [];
  if (typeof value === 'string') {
    collect(value, false, names, invalid);
    return {
      kind: 'string',
      text: value,
      names: [...names].sort(),
      invalid,
      empty: value.trim() === '',
    };
  }
  if (typeof value === 'function')
    return { kind: 'function', text: '', names: [], invalid, empty: false };
  if (isNative(value)) {
    collect(value, false, names, invalid);
    return {
      kind: `native:${value.op}`,
      text: JSON.stringify(value),
      names: [...names].sort(),
      invalid,
      empty: false,
    };
  }
  return {
    kind: value === null || value === undefined ? 'empty' : typeof value,
    text: '',
    names: [],
    invalid: ['unsupported message'],
    empty: true,
  };
}

/** Every message leaf as `path -> leaf`. Nested plain objects use dotted paths; native-i18n nodes stay one leaf. */
export function flatten(
  value: unknown,
  prefix = '',
  out = new Map<string, Leaf>(),
): Map<string, Leaf> {
  if (isRecord(value) && !isNative(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out.set(prefix, leaf(undefined));
    for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  if (prefix || typeof value === 'string' || isNative(value) || typeof value === 'function')
    out.set(prefix, leaf(value));
  return out;
}

function differs(left: Leaf, right: Leaf): boolean {
  return left.kind !== right.kind || left.text !== right.text;
}

/**
 * Compare one English catalog with the raw locale objects readers' files export.
 * `resolved` is the object `defineMessages` / `indexCatalog` actually serves, when a
 * locale file exists separately and can be dropped on the floor.
 */
export function catalogIssues(
  source: Partial<Record<Locale, unknown>>,
  resolved?: Partial<Record<Locale, unknown>>,
  requireAll = false,
): string[] {
  const issues: string[] = [];
  const english = flatten(source.en);
  if (english.size === 0) issues.push('english catalog has no keys');
  for (const [key, message] of english) {
    if (message.empty) issues.push(`en empty ${key}`);
    for (const error of message.invalid) issues.push(`en ${error} ${key}`);
  }
  const present = translated.filter((locale) => source[locale] !== undefined);
  if (requireAll && english.size > 0 && present.length === 0) {
    issues.push('english catalog is not in any other locale');
    return issues;
  }
  if (requireAll) {
    for (const locale of translated) {
      if (source[locale] === undefined) issues.push(`${locale} catalog is missing`);
    }
  }
  for (const locale of present) {
    const translatedLeaves = flatten(source[locale]);
    const resolvedLeaves = resolved?.[locale] !== undefined ? flatten(resolved[locale]) : undefined;
    for (const [key, message] of english) {
      const found = translatedLeaves.get(key);
      if (!found) {
        issues.push(`${locale} missing ${key}`);
        continue;
      }
      if (found.empty) issues.push(`${locale} empty ${key}`);
      if (found.kind !== message.kind) issues.push(`${locale} kind mismatch ${key}`);
      if (found.names.join('\0') !== message.names.join('\0'))
        issues.push(`${locale} placeholder mismatch ${key}`);
      for (const error of found.invalid) issues.push(`${locale} ${error} ${key}`);
      if (resolvedLeaves && differs(found, message)) {
        const served = resolvedLeaves.get(key);
        if (!served || !differs(served, message))
          issues.push(`${locale} falls back to English for ${key}`);
      }
    }
    for (const key of translatedLeaves.keys()) {
      if (!english.has(key)) issues.push(`${locale} extra ${key}`);
    }
    for (const [key, message] of translatedLeaves) {
      if (english.has(key)) continue;
      for (const error of message.invalid) issues.push(`${locale} ${error} ${key}`);
    }
  }
  return issues;
}

async function importModule(rel: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(resolve(root, rel)).href)) as Record<string, unknown>;
}

function sliceIndexed(
  indexed: Record<string, Record<string, unknown>>,
  locale: Locale,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(indexed).map(([key, row]) => [key, row[locale]]));
}

function fromMap(id: string, map: Record<string, unknown>): Catalog {
  const source: Partial<Record<Locale, unknown>> = {};
  for (const locale of locales) if (locale in map) source[locale] = map[locale];
  return { id, locales: source };
}

function readLocaleFiles(directory: string): Partial<Record<Locale, string>> {
  if (!existsSync(resolve(root, directory))) return {};
  const found: Partial<Record<Locale, string>> = {};
  for (const name of readdirSync(resolve(root, directory))) {
    const locale = translated.find((item) => name === `${item}.ts`);
    if (locale) found[locale] = `${directory}/${name}`;
  }
  return found;
}

async function catalogsFromModule(
  id: string,
  mod: Record<string, unknown>,
  files: Partial<Record<Locale, string>>,
  seen: Set<unknown>,
): Promise<Catalog[]> {
  const maps = Object.values(mod).filter(isLocaleMap);
  const indexed = Object.values(mod).filter(isIndexed);
  for (const map of maps) seen.add(map);
  const localeMap = maps[0];
  const english =
    mod.englishMessages ??
    mod.default ??
    localeMap?.en ??
    (isCatalogBody(mod.messages) ? mod.messages : undefined);
  const hasFiles = Object.keys(files).length > 0;
  if (!hasFiles && localeMap) return [fromMap(id, localeMap)];
  if (english === undefined) return [];
  const source: Partial<Record<Locale, unknown>> = { en: english };
  for (const [locale, rel] of Object.entries(files) as [Locale, string][]) {
    const loaded = await importModule(rel);
    source[locale] = loaded.default ?? loaded.messages;
  }
  let resolved: Partial<Record<Locale, unknown>> | undefined;
  if (hasFiles && localeMap) {
    resolved = {};
    for (const locale of translated) resolved[locale] = localeMap[locale];
  } else if (hasFiles && indexed[0]) {
    resolved = {};
    for (const locale of translated) resolved[locale] = sliceIndexed(indexed[0], locale);
  }
  return [{ id, locales: source, resolved }];
}

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const rel = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

/** Feature barrels, inline `defineMessages` modules, official Zone tables and the UI copy table. */
export async function discoverCatalogs(): Promise<Catalog[]> {
  const catalogs: Catalog[] = [];
  const seen = new Set<unknown>();
  const loaded = new Set<string>();

  for (const app of ['web', 'accounts'] as const) {
    const base = `apps/${app}/features`;
    for (const entry of readdirSync(resolve(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const feature = entry.name;
      const barrel = `${base}/${feature}/messages.ts`;
      const enFile = `${base}/${feature}/messages/en.ts`;
      const hasBarrel = existsSync(resolve(root, barrel));
      const hasEn = existsSync(resolve(root, enFile));
      if (!hasBarrel && !hasEn) continue;
      const id = `${app}/${feature}`;
      try {
        const mod = await importModule(hasEn ? enFile : barrel);
        const barrelMod = hasBarrel && hasEn ? await importModule(barrel) : mod;
        if (hasBarrel) loaded.add(barrel);
        const files = readLocaleFiles(`${base}/${feature}/messages`);
        catalogs.push(
          ...(await catalogsFromModule(
            id,
            {
              ...mod,
              ...barrelMod,
              englishMessages: barrelMod.englishMessages ?? mod.englishMessages,
              default: hasEn ? mod.default : barrelMod.default,
            },
            files,
            seen,
          )),
        );
        if (existsSync(resolve(root, `${base}/${feature}/messages`))) {
          for (const name of readdirSync(resolve(root, `${base}/${feature}/messages`))) {
            if (
              !name.endsWith('.ts') ||
              name.endsWith('.test.ts') ||
              translated.some((locale) => name === `${locale}.ts`) ||
              name === 'en.ts'
            )
              continue;
            const rel = `${base}/${feature}/messages/${name}`;
            const extra = await importModule(rel);
            loaded.add(rel);
            for (const map of Object.values(extra).filter(isLocaleMap)) {
              if (seen.has(map)) continue;
              seen.add(map);
              catalogs.push(fromMap(`${id}/${name.replace(/\.ts$/, '')}`, map));
            }
          }
        }
      } catch (error) {
        catalogs.push({
          id,
          locales: {},
          loadError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  for (const rel of [...walk('apps/web/features'), ...walk('apps/accounts/features')]) {
    if (loaded.has(rel) || !readFileSync(resolve(root, rel), 'utf8').includes('defineMessages('))
      continue;
    try {
      const mod = await importModule(rel);
      for (const map of Object.values(mod).filter(isLocaleMap)) {
        if (seen.has(map)) continue;
        seen.add(map);
        const id = rel
          .replace(/^apps\/(web|accounts)\/features\//, '$1/')
          .replace(/\/messages\//, '/')
          .replace(/\.ts$/, '');
        catalogs.push(fromMap(id, map));
      }
    } catch (error) {
      catalogs.push({
        id: rel,
        locales: {},
        loadError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const zones = resolve(root, 'apps/web/zones/official');
  for (const entry of readdirSync(zones, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `apps/web/zones/official/${entry.name}/strings.ts`;
    if (!existsSync(resolve(root, rel))) continue;
    try {
      const mod = await importModule(rel);
      const map = isLocaleMap(mod.localeStrings)
        ? mod.localeStrings
        : Object.values(mod).find(isLocaleMap);
      if (!map)
        catalogs.push({
          id: `zone/${entry.name}`,
          locales: {},
          loadError: 'no per-locale string table',
        });
      else catalogs.push(fromMap(`zone/${entry.name}`, map));
    } catch (error) {
      catalogs.push({
        id: `zone/${entry.name}`,
        locales: {},
        loadError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const ui = await importModule('packages/ui/src/i18n/copy.ts');
    const map = isLocaleMap(ui.copy) ? ui.copy : Object.values(ui).find(isLocaleMap);
    if (!map) catalogs.push({ id: 'ui/copy', locales: {}, loadError: 'no per-locale copy table' });
    else catalogs.push(fromMap('ui/copy', map));
  } catch (error) {
    catalogs.push({
      id: 'ui/copy',
      locales: {},
      loadError: error instanceof Error ? error.message : String(error),
    });
  }

  return catalogs;
}

export async function auditCatalogs(): Promise<string[]> {
  const issues: string[] = [];
  for (const catalog of await discoverCatalogs()) {
    if (catalog.loadError) {
      issues.push(`${catalog.id}: ${catalog.loadError}`);
      continue;
    }
    for (const issue of catalogIssues(catalog.locales, catalog.resolved, true))
      issues.push(`${catalog.id}: ${issue}`);
  }
  return issues;
}

if (import.meta.main) {
  const issues = await auditCatalogs();
  const ids = new Map<string, string[]>();
  for (const issue of issues) {
    const id = issue.slice(0, issue.indexOf(':'));
    const list = ids.get(id) ?? [];
    list.push(issue.slice(id.length + 2));
    ids.set(id, list);
  }
  if (ids.size === 0) console.log('Catalogs match.');
  for (const [id, list] of ids) {
    console.error(`${id}: ${list.length} issue(s)`);
    for (const issue of list) console.error(`- ${issue}`);
  }
  if (issues.length) process.exitCode = 1;
}
