// Stabilize and dev both edit shared test files, and the commonest conflict between them is two sides adding an import
// on neighbouring lines. Such a hunk has one safe resolution: keep every import the file still uses, merging named
// imports from the same module. Anything else in a hunk is left to a person.

const HUNK = /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm;
const IMPORT = /^import\s+(?:(type)\s+)?(.*?)\s+from\s+(['"])([^'"]+)\3;?\s*$/;
const SIDE_EFFECT = /^import\s+(['"])[^'"]+\1;?\s*$/;

type Named = { exported: string; local: string; typeOnly: boolean };
type Line = {
  module: string;
  typeOnly: boolean;
  defaultName?: string | undefined;
  namespace?: string | undefined;
  named: Named[];
  clashes: Set<string>;
};

function parseNamed(part: string): Named | undefined {
  const typeOnly = /^type\s+\S/.test(part);
  const body = typeOnly ? part.replace(/^type\s+/, '').trim() : part;
  const pieces = body.split(/\s+as\s+/);
  if (pieces.length > 2) return undefined;
  const exported = pieces[0]!.trim();
  const local = (pieces[1] ?? pieces[0])!.trim();
  if (!/^\w+$/.test(exported) || !/^\w+$/.test(local)) return undefined;
  return { exported, local, typeOnly };
}

function renderNamed(item: Named): string {
  const body = item.exported === item.local ? item.exported : `${item.exported} as ${item.local}`;
  return item.typeOnly ? `type ${body}` : body;
}

function parse(line: string): Line | undefined {
  const match = IMPORT.exec(line.trim());
  if (!match) return undefined;
  const [, typeOnly, clause, , module] = match;
  const result: Line = { module: module!, typeOnly: typeOnly === 'type', named: [], clashes: new Set() };
  let rest = clause!.trim();
  const braces = /\{([^{}]*)\}/.exec(rest);
  if (braces) {
    for (const part of braces[1]!
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)) {
      const named = parseNamed(part);
      if (!named) return undefined;
      result.named.push(named);
    }
    rest = rest.replace(braces[0], '').trim();
  }
  for (const part of rest
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const namespace = /^\*\s+as\s+(\w+)$/.exec(part);
    if (namespace) result.namespace = namespace[1];
    else if (/^\w+$/.test(part)) result.defaultName = part;
    else return undefined;
  }
  return result;
}

function render(line: Line): string {
  const parts = [
    ...(line.defaultName ? [line.defaultName] : []),
    ...(line.namespace ? [`* as ${line.namespace}`] : []),
    ...(line.named.length ? [`{ ${line.named.map(renderNamed).join(', ')} }`] : []),
  ];
  return `import ${line.typeOnly ? 'type ' : ''}${parts.join(', ')} from '${line.module}';\n`;
}

function mergeNamed(into: Line, item: Named) {
  const existing = into.named.find((other) => other.local === item.local);
  if (!existing) {
    into.named.push(item);
    return;
  }
  if (existing.exported !== item.exported) {
    into.clashes.add(item.local);
    return;
  }
  if (existing.typeOnly && !item.typeOnly) existing.typeOnly = false;
}

/** The file with every import-only conflict hunk resolved, or undefined when a hunk holds anything else. */
export function resolveImportConflicts(text: string): string | undefined {
  const hunks = [...text.matchAll(HUNK)];
  if (!hunks.length || text.includes('\n|||||||')) return undefined;
  let outside = text;
  for (const hunk of hunks) outside = outside.replace(hunk[0], '');
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(outside)) return undefined;
  const used = (name: string) => new RegExp(`\\b${name}\\b`).test(outside);
  let result = text;
  for (const hunk of hunks.reverse()) {
    const lines = `${hunk[1]}${hunk[2]}`.split('\n').filter((line) => line.trim());
    const sideEffects: string[] = [];
    const byModule = new Map<string, Line>();
    for (const raw of lines) {
      if (SIDE_EFFECT.test(raw.trim())) {
        if (!sideEffects.includes(raw.trim())) sideEffects.push(raw.trim());
        continue;
      }
      const line = parse(raw);
      if (!line) return undefined;
      const key = `${line.typeOnly ? 'type ' : ''}${line.module}`;
      const merged = byModule.get(key);
      if (!merged) {
        byModule.set(key, line);
        continue;
      }
      if (
        (line.defaultName && merged.defaultName && line.defaultName !== merged.defaultName) ||
        (line.namespace && merged.namespace && line.namespace !== merged.namespace)
      )
        return undefined;
      merged.defaultName ??= line.defaultName;
      merged.namespace ??= line.namespace;
      for (const item of line.named) mergeNamed(merged, item);
    }
    const kept: Line[] = [];
    const bound = new Set<string>();
    for (const line of byModule.values()) {
      if ([...line.clashes].some(used)) return undefined;
      const next: Line = {
        module: line.module,
        typeOnly: line.typeOnly,
        named: line.named.filter((item) => used(item.local)),
        clashes: line.clashes,
      };
      if (line.defaultName && used(line.defaultName)) next.defaultName = line.defaultName;
      if (line.namespace && used(line.namespace)) next.namespace = line.namespace;
      const locals = [next.defaultName, next.namespace, ...next.named.map((item) => item.local)].filter(
        (name): name is string => Boolean(name),
      );
      if (!locals.length) continue;
      // The same name bound from two modules cannot be decided here.
      if (locals.some((name) => bound.has(name))) return undefined;
      for (const name of locals) bound.add(name);
      kept.push(next);
    }
    const replacement = sideEffects.map((line) => `${line}\n`).join('') + kept.map(render).join('');
    result = result.slice(0, hunk.index!) + replacement + result.slice(hunk.index! + hunk[0].length);
  }
  return result;
}
