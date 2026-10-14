import ts from 'typescript-6';
import { indexedSource, type AstNode } from './repo-index.ts';

// The guards use TypeScript's node vocabulary for their rules. This view maps
// oxc's indexed syntax to that vocabulary without invoking a second parser.
const kindNames: Record<string, string> = {
  Program: 'SourceFile', Identifier: 'Identifier', PrivateIdentifier: 'PrivateIdentifier',
  ExpressionStatement: 'ExpressionStatement', VariableDeclarator: 'VariableDeclaration',
  VariableDeclaration: 'VariableStatement', FunctionDeclaration: 'FunctionDeclaration',
  FunctionExpression: 'FunctionExpression', ArrowFunctionExpression: 'ArrowFunction',
  ClassDeclaration: 'ClassDeclaration', ClassExpression: 'ClassExpression',
  BlockStatement: 'Block', CallExpression: 'CallExpression', NewExpression: 'NewExpression',
  ConditionalExpression: 'ConditionalExpression', BinaryExpression: 'BinaryExpression',
  LogicalExpression: 'BinaryExpression', AssignmentExpression: 'BinaryExpression',
  UnaryExpression: 'PrefixUnaryExpression', ArrayExpression: 'ArrayLiteralExpression',
  ObjectExpression: 'ObjectLiteralExpression', Property: 'PropertyAssignment',
  ParenthesizedExpression: 'ParenthesizedExpression', TSAsExpression: 'AsExpression',
  TSSatisfiesExpression: 'SatisfiesExpression', TSNonNullExpression: 'NonNullExpression',
  ImportDeclaration: 'ImportDeclaration', ImportSpecifier: 'ImportSpecifier',
  IfStatement: 'IfStatement', ReturnStatement: 'ReturnStatement', AwaitExpression: 'AwaitExpression',
  ThisExpression: 'ThisKeyword', MethodDefinition: 'MethodDeclaration',
};
const operators: Record<string, ts.SyntaxKind> = {
  '+': ts.SyntaxKind.PlusToken, '-': ts.SyntaxKind.MinusToken, '!': ts.SyntaxKind.ExclamationToken,
  '||': ts.SyntaxKind.BarBarToken, '&&': ts.SyntaxKind.AmpersandAmpersandToken,
};
const children = new WeakMap<ts.Node, () => ts.Node[]>();
const sourceViews = new WeakMap<AstNode, ts.SourceFile>();
type SourceContext = {
  text: string;
  ast?: ts.SourceFile;
  make?: (raw: AstNode, parent?: ts.Node) => ts.Node;
};
type IndexedNode = ts.Node & { sourceContext: SourceContext; rawSyntax: AstNode };
const nodePrototype = {
  getStart(this: IndexedNode) { return this.pos; },
  getFullStart(this: IndexedNode) { return this.pos; },
  getEnd(this: IndexedNode) { return this.end; },
  getText(this: IndexedNode) { return this.sourceContext.text.slice(this.pos, this.end); },
  getSourceFile(this: IndexedNode) { return this.sourceContext.ast; },
};

export function indexedSourceFile(source: { file: string; text: string }): ts.SourceFile {
  const indexed = indexedSource(source);
  const rawAst = indexed.runtimeAst ?? indexed.ast;
  const existing = sourceViews.get(rawAst);
  if (existing) return existing;
  const text = source.text;
  let positions: number[] | undefined;
  const offset = indexedOffsets(text);
  const wrappers = new WeakMap<object, ts.Node>();
  let ast: ts.SourceFile;
  const sourceContext: SourceContext = { text };
  const make = (raw: AstNode, parent?: ts.Node): ts.Node => {
    const previous = wrappers.get(raw);
    if (previous) return previous;
    const start = offset(raw.start), end = offset(raw.end);
    const node = Object.assign(Object.create(nodePrototype), {
      kind: ts.SyntaxKind[(kindNames[raw.type] ?? 'Unknown') as keyof typeof ts.SyntaxKind],
      pos: start, end, parent, sourceContext, rawSyntax: raw,
    }) as ts.Node;
    wrappers.set(raw, node);
    const view = node as unknown as Record<string, unknown>;
    const child = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(child);
      if (value && typeof value === 'object' && 'type' in value && 'start' in value)
        return make(value as AstNode, node);
      return value;
    };
    const set = (key: string, value: unknown) => { view[key] = value; };
    const get = (key: string, value: unknown) => {
      Object.defineProperty(view, key, { configurable: true, enumerable: true, get: () => {
        const result = child(value); Object.defineProperty(view, key, { configurable: true, enumerable: true, writable: true, value: result }); return result;
      }});
    };
    const rename = (key: string, value: unknown) => get(key, value);
    if (raw.type === 'Identifier' || raw.type === 'PrivateIdentifier') set('text', raw.name);
    if (raw.type === 'Literal') {
      set('kind', typeof raw.value === 'string' ? ts.SyntaxKind.StringLiteral : typeof raw.value === 'number' ? ts.SyntaxKind.NumericLiteral : raw.value === true ? ts.SyntaxKind.TrueKeyword : raw.value === false ? ts.SyntaxKind.FalseKeyword : ts.SyntaxKind.NullKeyword);
      set('text', String(raw.value));
    }
    if (raw.type === 'MemberExpression') {
      set('kind', raw.computed ? ts.SyntaxKind.ElementAccessExpression : ts.SyntaxKind.PropertyAccessExpression);
      rename('expression', raw.object); rename(raw.computed ? 'argumentExpression' : 'name', raw.property);
    }
    if (raw.type === 'VariableDeclarator') { rename('name', raw.id); rename('initializer', raw.init); }
    if (raw.type === 'CallExpression' || raw.type === 'NewExpression') {
      rename('expression', raw.callee); rename('arguments', raw.arguments);
    }
    if (['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(raw.type)) rename('expression', raw.expression);
    const parameters = (input: AstNode[]) => input.map(parameter => {
      const binding = parameter.type === 'TSParameterProperty' ? parameter.parameter as AstNode : parameter;
      const name = binding.type === 'AssignmentPattern' ? binding.left : binding.type === 'RestElement' ? binding.argument : binding;
      const result = make(parameter, node) as unknown as Record<string, unknown>;
      result.name = child(name);
      if (binding.type === 'AssignmentPattern') result.initializer = child(binding.right);
      return result;
    });
    const lazyParameters = (input: AstNode[]) => Object.defineProperty(view, 'parameters', {
      configurable: true,
      get: () => {
        const result = parameters(input);
        Object.defineProperty(view, 'parameters', { value: result });
        return result;
      },
    });
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(raw.type)) {
      rename('name', raw.id); rename('body', raw.body);
      lazyParameters((raw.params as AstNode[]) ?? []);
    }
    if (raw.type === 'MethodDefinition') {
      const value = raw.value as AstNode;
      set('kind', raw.kind === 'constructor' ? ts.SyntaxKind.Constructor : raw.kind === 'get' ? ts.SyntaxKind.GetAccessor : raw.kind === 'set' ? ts.SyntaxKind.SetAccessor : ts.SyntaxKind.MethodDeclaration);
      if (raw.kind !== 'constructor') rename('name', raw.key);
      rename('body', value.body);
      lazyParameters((value.params as AstNode[]) ?? []);
    }
    if (raw.type === 'ClassDeclaration' || raw.type === 'ClassExpression') rename('name', raw.id);
    if (raw.type === 'Property') { rename('name', raw.key); rename('initializer', raw.value); }
    if (raw.type === 'UnaryExpression') { set('operator', operators[String(raw.operator)]); rename('operand', raw.argument); }
    if (['BinaryExpression', 'LogicalExpression', 'AssignmentExpression'].includes(raw.type)) {
      rename('left', raw.left); rename('right', raw.right);
      set('operatorToken', { kind: operators[String(raw.operator)] ?? ts.SyntaxKind.Unknown });
    }
    if (raw.type === 'IfStatement') { rename('expression', raw.test); rename('thenStatement', raw.consequent); rename('elseStatement', raw.alternate); }
    if (raw.type === 'ConditionalExpression') { rename('condition', raw.test); rename('whenTrue', raw.consequent); rename('whenFalse', raw.alternate); }
    if (raw.type === 'ArrayExpression') rename('elements', raw.elements);
    if (raw.type === 'Program') { set('pos', 0); rename('statements', raw.body); set('fileName', source.file); set('text', text); set('getLineAndCharacterOfPosition', (at: number) => {
      if (!positions) {
        positions = [0];
        for (let index = 0; index < text.length; index++) if (text[index] === '\n') positions.push(index + 1);
      }
      let low = 0, high = positions.length;
      while (low + 1 < high) { const mid = (low + high) >> 1; if (positions[mid] <= at) low = mid; else high = mid; }
      return { line: low, character: at - positions[low] };
    }); }
    if (raw.type === 'ImportDeclaration') {
      rename('moduleSpecifier', raw.source);
      set('importClause', { namedBindings: { kind: ts.SyntaxKind.NamedImports, elements: (raw.specifiers as AstNode[]).filter(specifier => specifier.type === 'ImportSpecifier').map(specifier => make(specifier, node)) } });
    }
    if (raw.type === 'ImportSpecifier') { rename('name', raw.local); rename('propertyName', raw.imported); }
    if (raw.type === 'TemplateLiteral') {
      const quasis = raw.quasis as AstNode[], expressions = raw.expressions as AstNode[];
      const literal = (quasi: AstNode) => {
        const result = make(quasi, node) as unknown as Record<string, unknown>;
        result.kind = quasis.length === 1 ? ts.SyntaxKind.Unknown : quasi === quasis[0] ? ts.SyntaxKind.TemplateHead : quasi === quasis.at(-1) ? ts.SyntaxKind.TemplateTail : ts.SyntaxKind.TemplateMiddle;
        result.text = (quasi.value as {cooked: string | null; raw: string}).cooked ?? (quasi.value as {raw: string}).raw;
        return result;
      };
      set('kind', expressions.length ? ts.SyntaxKind.TemplateExpression : ts.SyntaxKind.NoSubstitutionTemplateLiteral);
      if (!expressions.length) set('text', literal(quasis[0]).text);
      else { set('head', literal(quasis[0])); set('templateSpans', expressions.map((expression, i) => ({expression: make(expression, node), literal: literal(quasis[i + 1])}))); }
    }
    children.set(node, () => {
      const result: ts.Node[] = [];
      const visit = (value: unknown) => {
        if (Array.isArray(value)) { for (const item of value) visit(item); }
        else if (value && typeof value === 'object' && 'type' in value && 'start' in value) result.push(make(value as AstNode, node));
      };
      if (raw.type === 'ClassDeclaration' || raw.type === 'ClassExpression') {
        visit(raw.id); visit(raw.superClass); visit((raw.body as AstNode).body);
      } else if (raw.type === 'MethodDefinition') {
        visit(raw.key); const value = raw.value as AstNode; visit(value.params); visit(value.body);
      } else for (const [key, value] of Object.entries(raw)) if (key !== 'comments') visit(value);
      children.set(node, () => result);
      return result;
    });
    return node;
  };
  sourceContext.make = make;
  ast = make(rawAst) as ts.SourceFile;
  sourceContext.ast = ast;
  sourceViews.set(rawAst, ast);
  return ast;
}

export function forEachIndexedChild(node: ts.Node, visit: (node: ts.Node) => unknown): void {
  for (const child of children.get(node)?.() ?? []) visit(child);
}

/** Translate native parser byte spans once for each non-ASCII input. */
export function indexedOffsets(text: string): (value: number) => number {
  const boundaries: { end: number; delta: number }[] = [];
  let delta = 0;
  for (const match of text.matchAll(/[^\x00-\x7f]/gu)) {
    delta += Buffer.byteLength(match[0]) - match[0].length;
    boundaries.push({ end: match.index + match[0].length + delta, delta });
  }
  if (!boundaries.length) return value => value;
  return value => {
    let low = 0, high = boundaries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (boundaries[middle].end <= value) low = middle + 1;
      else high = middle;
    }
    return value - (low ? boundaries[low - 1].delta : 0);
  };
}

const selectedSyntax = new WeakMap<ts.Node, Map<string, ts.Node[]>>();
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition']);
const sqlOperation = /\b(?:select|update|insert|delete|begin|commit|rollback|perform|create|alter|drop|for)\b|pg_advisory_/i;

/** Traverse indexed facts directly; adapting unrelated type syntax costs more
 * than these guards' rules. Parent chains are adapted only for selected nodes. */
function selectIndexedNodes(scope: ts.Node, mode: 'source' | 'declarations' | 'relations'): ts.Node[] {
  const modes = selectedSyntax.get(scope) ?? new Map<string, ts.Node[]>();
  const previous = modes.get(mode);
  if (previous) return previous;
  const indexed = scope as IndexedNode;
  const path: AstNode[] = [];
  const result: ts.Node[] = [];
  const nodeForPath = () => {
    let parent = scope.parent;
    for (let index = 0; index < path.length; index++) {
      const raw = path[index];
      const prior = path[index - 1];
      if (raw.type === 'ClassBody' || (raw.type === 'FunctionExpression' && prior?.type === 'MethodDefinition' && prior.value === raw)) continue;
      parent = indexed.sourceContext.make!(raw, parent);
    }
    return parent!;
  };
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { for (const child of value) walk(child); return; }
    if (!value || typeof value !== 'object' || !('type' in value) || !('start' in value)) return;
    const raw = value as AstNode;
    const parent = path.at(-1);
    const methodBody = raw.type === 'FunctionExpression' && parent?.type === 'MethodDefinition' && parent.value === raw;
    if (mode === 'declarations' && raw !== indexed.rawSyntax && functionTypes.has(raw.type) && !methodBody) return;
    path.push(raw);
    const selected = mode === 'declarations'
      ? raw.type === 'VariableDeclarator'
      : mode === 'relations'
        ? raw.type === 'TemplateLiteral' || (raw.type === 'Literal' && typeof raw.value === 'string' && raw.value.includes('.'))
      : raw.type === 'ImportDeclaration' || raw.type === 'VariableDeclarator' || raw.type === 'CallExpression' ||
        (functionTypes.has(raw.type) && !methodBody) || raw.type === 'TemplateLiteral' ||
        (raw.type === 'Literal' && typeof raw.value === 'string' && sqlOperation.test(raw.value));
    if (selected) result.push(nodeForPath());
    if (mode === 'relations' && raw.type === 'TemplateLiteral') { path.pop(); return; }
    for (const [key, child] of Object.entries(raw)) if (key !== 'comments') walk(child);
    path.pop();
  };
  walk(indexed.rawSyntax);
  modes.set(mode, result);
  selectedSyntax.set(scope, modes);
  return result;
}

export function indexedSourceNodes(source: { file: string; text: string }): ts.Node[] {
  return selectIndexedNodes(indexedSourceFile(source), 'source');
}

export function indexedScopedDeclarations(scope: ts.Node): ts.VariableDeclaration[] {
  return selectIndexedNodes(scope, 'declarations') as ts.VariableDeclaration[];
}

export function indexedRelationNodes(source: { file: string; text: string }): ts.Node[] {
  return selectIndexedNodes(indexedSourceFile(source), 'relations');
}
