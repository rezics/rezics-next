import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export interface WebSource { path: string; source: string }
export interface ContinuationInventory { [group: string]: { files: number; digest: string } }

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const production = (path: string) => /\.[cm]?[jt]sx?$/.test(path)
  && !/(?:^|\/)(?:__tests__|fixtures|test|tests)(?:\/|\.)|\.(?:test|spec|stories)\.|(?:^|\/)[^/]*fixtures\./.test(path);

/**
 * A conservative inventory gate, not a proof that a cursor reaches a control.
 * Review changed groups against the operation contract before updating their
 * digests. Include importers so a caller cannot silently drop an adapter's
 * continuation. This intentionally also requires review for unrelated edits
 * inside a watched consumer; it does not infer UI reachability from syntax.
 */
export function continuationInventory(sources: readonly WebSource[]): ContinuationInventory {
  const files = new Map(sources.filter(file => production(file.path)).map(file => [file.path, file]));
  const imports = new Map<string, string[]>();
  const watched = new Set<string>();
  const printed = new Map<string, string>();
  for (const file of files.values()) {
    printed.set(file.path, file.source);
    const dependencies: string[] = [];
    // False positives are deliberate: a frozen inventory must not approve a
    // new capped array merely because the call bypassed the typed client.
    if (/\b(?:items|nextCursor|continuation|cursor|after|before|limit|offset|hasMore)\b|\bfetch\s*\(|\.\s*(?:get|post|slice|map|flatMap|filter)\s*\(/.test(file.source)) watched.add(file.path);
    for (const match of file.source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
        const target = normalize(join(dirname(file.path), match[1]!));
        const stem = target.replace(/\.[jt]sx?$/, '');
        const resolved = [target, `${stem}.ts`, `${stem}.tsx`, `${target}/index.ts`, `${target}/index.tsx`]
          .find(candidate => files.has(candidate));
        if (resolved) dependencies.push(resolved);
    }
    imports.set(file.path, dependencies);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [path, dependencies] of imports) {
      if (!watched.has(path) && dependencies.some(dependency => watched.has(dependency))) {
        watched.add(path); changed = true;
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const path of [...watched].sort()) {
    const group = path.split('/').slice(0, 4).join('/');
    const entries = groups.get(group) ?? [];
    entries.push(`${path}:${hash(printed.get(path)!)}`);
    groups.set(group, entries);
  }
  return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right))
    .map(([group, entries]) => [group, { files: entries.length, digest: hash(entries.join('\n')) }]));
}

export function changedContinuationGroups(current: ContinuationInventory, accepted: ContinuationInventory): string[] {
  return [...new Set([...Object.keys(current), ...Object.keys(accepted)])].sort()
    .filter(group => current[group]?.digest !== accepted[group]?.digest)
    .map(group => `${group}: review opaque forwarding, dropped continuations and capped-list remainder routes`);
}

export async function webSources(root: string): Promise<WebSource[]> {
  const sources: WebSource[] = [];
  for await (const path of new Bun.Glob('apps/web/**/*.{ts,tsx,js,jsx,mts,cts}').scan({ cwd: root })) {
    if (production(path)) sources.push({ path, source: readFileSync(join(root, path), 'utf8') });
  }
  return sources;
}
