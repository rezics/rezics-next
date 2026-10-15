import { parseSync, visitorKeys, type Node } from 'oxc-parser';

// Keep only the latest content per path. Guard fixtures can edit a file between scans.
const parsed = new Map<string, { source: string; program: Node }>();
const children = new WeakMap<Node, Node[]>();
const dataModules = new WeakMap<Node, boolean>();

/** Literal dictionaries cannot produce or consume pages. Inspect their shape
 * once instead of building flow units for every translated string. */
export function isWebDataModule(node: Node): boolean {
  const previous = dataModules.get(node);
  if (previous !== undefined) return previous;
  const inert = (node: Node): boolean => {
    switch (node.type) {
      case 'Program': return node.body.every(inert);
      case 'ImportDeclaration': return true;
      case 'ExportNamedDeclaration': return !node.declaration || inert(node.declaration);
      case 'ExportDefaultDeclaration': return inert(node.declaration);
      case 'VariableDeclaration': return node.declarations.every(inert);
      case 'VariableDeclarator': return node.id.type === 'Identifier' && !!node.init && inert(node.init);
      case 'TSAsExpression': case 'TSSatisfiesExpression': case 'ParenthesizedExpression': return inert(node.expression);
      case 'ObjectExpression': return node.properties.every(inert);
      case 'ArrayExpression': return node.elements.every(item => !item || inert(item));
      case 'Property': return !node.computed && node.kind === 'init'
        && (node.key.type === 'Identifier' || node.key.type === 'Literal')
        && !['limit', 'nextCursor', 'continuation', 'after', 'before', 'cursor'].includes(
          node.key.type === 'Identifier' ? node.key.name : String(node.key.value)) && inert(node.value);
      case 'Literal': return true;
      default: return false;
    }
  };
  const result = inert(node);
  dataModules.set(node, result);
  return result;
}

export function webProgram(file: { path: string; source: string }): Node {
  const previous = parsed.get(file.path);
  if (previous?.source === file.source) return previous.program;
  const result = parseSync(file.path, file.source);
  if (result.errors.length) throw new Error(`${file.path}: ${result.errors[0]!.message}`);
  const program = result.program;
  parsed.set(file.path, { source: file.source, program });
  return program;
}

export function webChildren(node: Node): Node[] {
  const previous = children.get(node);
  if (previous) return previous;
  const result: Node[] = [];
  const fields = node as unknown as Record<string, unknown>;
  for (const key of visitorKeys[node.type] ?? []) {
    const value = fields[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === 'object' && 'type' in child) result.push(child as Node);
    } else if (value && typeof value === 'object' && 'type' in value) result.push(value as Node);
  }
  children.set(node, result);
  return result;
}
