/** Indentation subset used by the catalogue fixtures. No YAML library is installed. */
export type CatalogueYaml = string | CatalogueYaml[] | { [key: string]: CatalogueYaml };

/** Parse the catalogue fixture subset: comments, nested maps, block lists and flow sequences. */
export function parseCatalogueYaml(source: string): { [key: string]: CatalogueYaml } {
  const lines = joinFlows(source.split('\n').map(stripComment)).flatMap(line => {
    const text = line.replace(/\s+$/, '');
    if (!text.trim()) return [];
    const indent = text.match(/^ */)?.[0].length ?? 0;
    if (indent % 2 !== 0) throw new Error(`catalogue YAML indent is not even: ${text.trim()}`);
    return [{ indent, text: text.trim() }];
  });
  const [value, next] = parseBlock(lines, 0, 0);
  if (next !== lines.length) throw new Error('catalogue YAML has unconsumed lines');
  if (!value || Array.isArray(value) || typeof value === 'string') {
    throw new Error('catalogue YAML root must be a map');
  }
  return value;
}

function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === '#' && !quoted) return line.slice(0, index);
  }
  return line;
}

function joinFlows(lines: string[]): string[] {
  const joined: string[] = [];
  let buffer = '';
  let depth = 0;
  for (const line of lines) {
    if (!buffer && !line.trim()) continue;
    buffer = buffer ? `${buffer} ${line.trim()}` : line.replace(/\s+$/, '');
    depth += bracketDepth(line);
    if (depth === 0) {
      joined.push(buffer);
      buffer = '';
    } else if (depth < 0) throw new Error('catalogue YAML flow has an extra ]');
  }
  if (buffer) throw new Error('catalogue YAML flow is missing ]');
  return joined;
}

function bracketDepth(line: string): number {
  let depth = 0;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '[') depth += 1;
    else if (!quoted && char === ']') depth -= 1;
  }
  return depth;
}

function parseBlock(lines: { indent: number; text: string }[], index: number, indent: number,
): [CatalogueYaml, number] {
  if (index >= lines.length || lines[index]!.indent < indent) {
    throw new Error('catalogue YAML expected a nested block');
  }
  if (lines[index]!.indent > indent) throw new Error(`catalogue YAML jumped indent: ${lines[index]!.text}`);
  if (lines[index]!.text.startsWith('- ')) return parseSequence(lines, index, indent);
  const map: { [key: string]: CatalogueYaml } = {};
  while (index < lines.length && lines[index]!.indent === indent) {
    if (lines[index]!.text.startsWith('- ')) throw new Error('catalogue YAML mixes a list into a map');
    const { key, value } = splitEntry(lines[index]!.text);
    index += 1;
    if (value === undefined) {
      const [child, next] = parseBlock(lines, index, indent + 2);
      map[key] = child;
      index = next;
    } else map[key] = parseScalar(value);
  }
  return [map, index];
}

function parseSequence(lines: { indent: number; text: string }[], index: number, indent: number,
): [CatalogueYaml[], number] {
  const items: CatalogueYaml[] = [];
  while (index < lines.length && lines[index]!.indent === indent && lines[index]!.text.startsWith('- ')) {
    const text = lines[index]!.text.slice(2).trim();
    index += 1;
    if (!text || (text.endsWith(':') && !text.startsWith('['))) {
      const key = text.endsWith(':') ? text.slice(0, -1).trim() : '';
      const [child, next] = parseBlock(lines, index, indent + 2);
      items.push(key ? { [key]: child } : child);
      index = next;
    } else items.push(parseScalar(text));
  }
  return [items, index];
}

function splitEntry(text: string): { key: string; value: string | undefined } {
  if (text.startsWith('[')) return { key: '', value: text };
  const match = /^([^:]+):(.*)$/.exec(text);
  if (!match) throw new Error(`catalogue YAML entry has no key: ${text}`);
  const value = match[2]!.trim();
  return { key: match[1]!.trim(), value: value ? value : undefined };
}

function parseScalar(text: string): CatalogueYaml {
  if (text.startsWith('[')) return parseFlow(text);
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\"/g, '"');
  }
  return text;
}

function parseFlow(text: string): CatalogueYaml[] {
  if (!text.endsWith(']')) throw new Error(`catalogue YAML flow is not closed: ${text}`);
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of inner) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (quoted) throw new Error(`catalogue YAML flow quote is open: ${text}`);
  parts.push(current.trim());
  return parts.map(parseScalar);
}
