// Stabilize and dev both edit shared test files, and the commonest conflict between them is two sides adding an import
// on neighbouring lines. Such a hunk has one safe resolution: keep every import the file still uses, merging named
// imports from the same module into valid declarations whose evaluation order both sides already agree on. Anything
// else in a hunk is left to a person.

const HUNK = /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm;
const IMPORT = /^import\s+(?:(type)\s+)?(.*?)\s+from\s+(['"])([^'"]+)\3;?\s*$/;
const SIDE_EFFECT = /^import\s+(['"])([^'"]+)\1;?\s*$/;

type Named = { exported: string; local: string; typeOnly: boolean };
type Line = {
  module: string;
  typeOnly: boolean;
  defaultName?: string | undefined;
  namespace?: string | undefined;
  named: Named[];
  clashes: Set<string>;
};
type Item = { kind: 'effect'; raw: string; module: string } | { kind: 'bind'; line: Line };

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

function bindingKey(line: Line) {
  return `${line.typeOnly ? 'type ' : ''}${line.module}`;
}

function runtimeModule(line: Line) {
  if (line.typeOnly) return undefined;
  if (line.defaultName || line.namespace || line.named.some((item) => !item.typeOnly)) return line.module;
  return undefined;
}

function render(line: Line): string {
  const prefix = `import ${line.typeOnly ? 'type ' : ''}`;
  const from = ` from '${line.module}';\n`;
  const named = line.named.length ? `{ ${line.named.map(renderNamed).join(', ')} }` : '';
  // `import * as ns, { named }` is invalid; keep default with the namespace when both exist.
  if (line.namespace && named) {
    const ns = line.defaultName ? `${line.defaultName}, * as ${line.namespace}` : `* as ${line.namespace}`;
    return `${prefix}${ns}${from}${prefix}${named}${from}`;
  }
  const parts = [
    ...(line.defaultName ? [line.defaultName] : []),
    ...(line.namespace ? [`* as ${line.namespace}`] : []),
    ...(named ? [named] : []),
  ];
  return `${prefix}${parts.join(', ')}${from}`;
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

function parseItems(text: string): Item[] | undefined {
  const items: Item[] = [];
  for (const raw of text.split('\n').filter((line) => line.trim())) {
    const trimmed = raw.trim();
    const side = SIDE_EFFECT.exec(trimmed);
    if (side) {
      items.push({ kind: 'effect', raw: trimmed, module: side[2]! });
      continue;
    }
    const line = parse(raw);
    if (!line) return undefined;
    items.push({ kind: 'bind', line });
  }
  return items;
}

function mergeBindings(ours: Item[], theirs: Item[]): Map<string, Line> | undefined {
  const byModule = new Map<string, Line>();
  for (const item of [...ours, ...theirs]) {
    if (item.kind === 'effect') continue;
    const key = bindingKey(item.line);
    const merged = byModule.get(key);
    if (!merged) {
      byModule.set(key, item.line);
      continue;
    }
    if (
      (item.line.defaultName && merged.defaultName && item.line.defaultName !== merged.defaultName) ||
      (item.line.namespace && merged.namespace && item.line.namespace !== merged.namespace)
    )
      return undefined;
    merged.defaultName ??= item.line.defaultName;
    merged.namespace ??= item.line.namespace;
    for (const named of item.line.named) mergeNamed(merged, named);
  }
  return byModule;
}

function keepBinding(line: Line, used: (name: string) => boolean, bound: Set<string>): Line | 'clash' | undefined {
  if ([...line.clashes].some(used)) return 'clash';
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
  if (!locals.length) return undefined;
  if (locals.some((name) => bound.has(name))) return 'clash';
  for (const name of locals) bound.add(name);
  return next;
}

function runtimeKeys(items: Item[], kept: Map<string, Line>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let key: string | undefined;
    if (item.kind === 'effect') key = item.module;
    else {
      const line = kept.get(bindingKey(item.line));
      if (line) key = runtimeModule(line);
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function mergeOrder(ours: string[], theirs: string[]): string[] | undefined {
  const nodes = [...new Set([...ours, ...theirs])];
  const next = new Map(nodes.map((node) => [node, new Set<string>()]));
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const seq of [ours, theirs]) {
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]!;
      const b = seq[i]!;
      const succs = next.get(a)!;
      if (succs.has(b)) continue;
      succs.add(b);
      indegree.set(b, indegree.get(b)! + 1);
    }
  }
  const priority = [...ours, ...theirs.filter((key) => !ours.includes(key))];
  const result: string[] = [];
  const ready = nodes.filter((node) => indegree.get(node) === 0);
  while (ready.length) {
    let pick = 0;
    for (let i = 1; i < ready.length; i++) if (priority.indexOf(ready[i]!) < priority.indexOf(ready[pick]!)) pick = i;
    const node = ready.splice(pick, 1)[0]!;
    result.push(node);
    for (const other of next.get(node)!) {
      const degree = indegree.get(other)! - 1;
      indegree.set(other, degree);
      if (degree === 0) ready.push(other);
    }
  }
  return result.length === nodes.length ? result : undefined;
}

function firstSeen(ours: Item[], theirs: Item[], kept: Map<string, Line>): Item[] {
  const slots: Item[] = [];
  const seenEffect = new Set<string>();
  const seenBind = new Set<string>();
  for (const item of [...ours, ...theirs]) {
    if (item.kind === 'effect') {
      if (seenEffect.has(item.raw)) continue;
      seenEffect.add(item.raw);
      slots.push(item);
      continue;
    }
    const key = bindingKey(item.line);
    if (seenBind.has(key)) continue;
    seenBind.add(key);
    const line = kept.get(key);
    if (line) slots.push({ kind: 'bind', line });
  }
  return slots;
}

function arrange(slots: Item[], order: string[]): Item[] {
  const rank = new Map(order.map((key, i) => [key, i]));
  let prev = -0.5;
  const decorated = slots.map((item, i) => {
    const key = item.kind === 'effect' ? item.module : runtimeModule(item.line);
    if (key !== undefined) {
      prev = rank.get(key)!;
      return { item, i, sort: prev };
    }
    return { item, i, sort: prev + 0.5 };
  });
  decorated.sort((a, b) => a.sort - b.sort || a.i - b.i);
  return decorated.map((entry) => entry.item);
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
    const ours = parseItems(hunk[1]!);
    const theirs = parseItems(hunk[2]!);
    if (!ours || !theirs) return undefined;
    const byModule = mergeBindings(ours, theirs);
    if (!byModule) return undefined;
    const bound = new Set<string>();
    const kept = new Map<string, Line>();
    for (const [key, line] of byModule) {
      const next = keepBinding(line, used, bound);
      if (next === 'clash') return undefined;
      if (next) kept.set(key, next);
    }
    const order = mergeOrder(runtimeKeys(ours, kept), runtimeKeys(theirs, kept));
    if (!order) return undefined;
    const replacement = arrange(firstSeen(ours, theirs, kept), order)
      .map((item) => (item.kind === 'effect' ? `${item.raw}\n` : render(item.line)))
      .join('');
    result = result.slice(0, hunk.index!) + replacement + result.slice(hunk.index! + hunk[0].length);
  }
  return result;
}
