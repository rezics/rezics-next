import ts from 'typescript-6';
import {
  indexedSource,
  type AstNode,
  type IndexedFile,
  type SqlAncestor,
  type SyntaxSpan,
  type VariableFact,
} from './repo-index.ts';

// The guards use TypeScript's node vocabulary for their rules. This view maps
// oxc's indexed syntax to that vocabulary without invoking a second parser.
const kindNames: Record<string, string> = {
  Program: 'SourceFile',
  Identifier: 'Identifier',
  PrivateIdentifier: 'PrivateIdentifier',
  ExpressionStatement: 'ExpressionStatement',
  VariableDeclarator: 'VariableDeclaration',
  VariableDeclaration: 'VariableStatement',
  FunctionDeclaration: 'FunctionDeclaration',
  FunctionExpression: 'FunctionExpression',
  ArrowFunctionExpression: 'ArrowFunction',
  ClassDeclaration: 'ClassDeclaration',
  ClassExpression: 'ClassExpression',
  BlockStatement: 'Block',
  CallExpression: 'CallExpression',
  NewExpression: 'NewExpression',
  ConditionalExpression: 'ConditionalExpression',
  BinaryExpression: 'BinaryExpression',
  LogicalExpression: 'BinaryExpression',
  AssignmentExpression: 'BinaryExpression',
  UnaryExpression: 'PrefixUnaryExpression',
  ArrayExpression: 'ArrayLiteralExpression',
  OmittedExpression: 'OmittedExpression',
  ObjectExpression: 'ObjectLiteralExpression',
  Property: 'PropertyAssignment',
  ParenthesizedExpression: 'ParenthesizedExpression',
  TSAsExpression: 'AsExpression',
  TSSatisfiesExpression: 'SatisfiesExpression',
  TSNonNullExpression: 'NonNullExpression',
  ImportDeclaration: 'ImportDeclaration',
  ImportSpecifier: 'ImportSpecifier',
  IfStatement: 'IfStatement',
  ReturnStatement: 'ReturnStatement',
  AwaitExpression: 'AwaitExpression',
  ThisExpression: 'ThisKeyword',
  MethodDefinition: 'MethodDeclaration',
};
const operators: Record<string, ts.SyntaxKind> = {
  '+': ts.SyntaxKind.PlusToken,
  '-': ts.SyntaxKind.MinusToken,
  '!': ts.SyntaxKind.ExclamationToken,
  '||': ts.SyntaxKind.BarBarToken,
  '&&': ts.SyntaxKind.AmpersandAmpersandToken,
};
const children = new WeakMap<ts.Node, () => ts.Node[]>();
const rawChildren = new WeakMap<AstNode, readonly AstNode[]>();
const noSyntaxChildren: readonly AstNode[] = [];
function syntaxChildren(raw: AstNode): readonly AstNode[] {
  const existing = rawChildren.get(raw);
  if (existing) return existing;
  let result: AstNode[] | undefined;
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) collect(child);
    } else if (value && typeof value === 'object' && 'type' in value && 'start' in value)
      (result ??= []).push(value as AstNode);
  };
  for (const key of Object.keys(raw)) if (key !== 'comments') collect(raw[key]);
  const found = result ?? noSyntaxChildren;
  rawChildren.set(raw, found);
  return found;
}
const sourceViews = new WeakMap<AstNode, ts.SourceFile>();
type SourceContext = {
  file: string;
  text: string;
  ast?: ts.SourceFile;
  make?: (raw: AstNode, parent?: ts.Node) => ts.Node;
  offset: (value: number) => number;
  variableFacts?: VariableFact[];
  declarations?: WeakMap<VariableFact, ts.VariableDeclaration>;
  declarationIndex?: IndexedFile;
};
type IndexedNode = ts.Node & { sourceContext: SourceContext; rawSyntax: AstNode };
const nodePrototype = {
  getStart(this: IndexedNode) {
    return this.pos;
  },
  getFullStart(this: IndexedNode) {
    return this.pos;
  },
  getEnd(this: IndexedNode) {
    return this.end;
  },
  getText(this: IndexedNode) {
    return this.sourceContext.text.slice(this.pos, this.end);
  },
  getSourceFile(this: IndexedNode) {
    return this.sourceContext.ast;
  },
};

export function indexedSourceFile(
  source: { file: string; text: string },
  syntax?: AstNode,
): ts.SourceFile {
  const rawAst =
    syntax ??
    (() => {
      const indexed = indexedSource(source);
      return indexed.runtimeAst ?? indexed.ast;
    })();
  const existing = sourceViews.get(rawAst);
  if (existing) return existing;
  const text = source.text;
  let positions: number[] | undefined;
  const offset = indexedOffsets(text);
  const wrappers = new WeakMap<object, ts.Node>();
  let ast: ts.SourceFile;
  const sourceContext: SourceContext = { file: source.file, text, offset };
  const make = (raw: AstNode, parent?: ts.Node): ts.Node => {
    const previous = wrappers.get(raw);
    if (previous) return previous;
    const start = offset(raw.start),
      end = offset(raw.end);
    const node = Object.assign(Object.create(nodePrototype), {
      kind: ts.SyntaxKind[(kindNames[raw.type] ?? 'Unknown') as keyof typeof ts.SyntaxKind],
      pos: start,
      end,
      parent,
      sourceContext,
      rawSyntax: raw,
    }) as ts.Node;
    wrappers.set(raw, node);
    const view = node as unknown as Record<string, unknown>;
    const child = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(child);
      if (value && typeof value === 'object' && 'type' in value && 'start' in value)
        return make(value as AstNode, node);
      return value;
    };
    const set = (key: string, value: unknown) => {
      view[key] = value;
    };
    const get = (key: string, value: unknown) => {
      Object.defineProperty(view, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          const result = child(value);
          Object.defineProperty(view, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: result,
          });
          return result;
        },
      });
    };
    const rename = (key: string, value: unknown) => get(key, value);
    if (raw.type === 'Identifier' || raw.type === 'PrivateIdentifier')
      set(
        'text',
        raw.type === 'PrivateIdentifier' ? `#${String(raw.name).replace(/^#/, '')}` : raw.name,
      );
    if (raw.type === 'Literal') {
      set(
        'kind',
        typeof raw.value === 'string'
          ? ts.SyntaxKind.StringLiteral
          : typeof raw.value === 'number'
            ? ts.SyntaxKind.NumericLiteral
            : raw.value === true
              ? ts.SyntaxKind.TrueKeyword
              : raw.value === false
                ? ts.SyntaxKind.FalseKeyword
                : ts.SyntaxKind.NullKeyword,
      );
      set('text', String(raw.value));
    }
    if (raw.type === 'OmittedExpression') set('getText', () => '');
    if (raw.type === 'MemberExpression') {
      set(
        'kind',
        raw.computed
          ? ts.SyntaxKind.ElementAccessExpression
          : ts.SyntaxKind.PropertyAccessExpression,
      );
      rename('expression', raw.object);
      rename(raw.computed ? 'argumentExpression' : 'name', raw.property);
    }
    if (raw.type === 'VariableDeclarator') {
      rename('name', raw.id);
      rename('initializer', raw.init);
    }
    if (raw.type === 'CallExpression' || raw.type === 'NewExpression') {
      rename('expression', raw.callee);
      rename('arguments', raw.arguments);
    }
    if (
      [
        'ExpressionStatement',
        'ParenthesizedExpression',
        'TSAsExpression',
        'TSSatisfiesExpression',
        'TSNonNullExpression',
      ].includes(raw.type)
    )
      rename('expression', raw.expression);
    const parameters = (input: AstNode[]) =>
      input.map((parameter) => {
        const binding =
          parameter.type === 'TSParameterProperty' ? (parameter.parameter as AstNode) : parameter;
        const name =
          binding.type === 'AssignmentPattern'
            ? binding.left
            : binding.type === 'RestElement'
              ? binding.argument
              : binding;
        const result = make(parameter, node) as unknown as Record<string, unknown>;
        result.name = child(name);
        if (binding.type === 'AssignmentPattern') result.initializer = child(binding.right);
        return result;
      });
    const lazyParameters = (input: AstNode[]) =>
      Object.defineProperty(view, 'parameters', {
        configurable: true,
        get: () => {
          const result = parameters(input);
          Object.defineProperty(view, 'parameters', { value: result });
          return result;
        },
      });
    if (
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(raw.type)
    ) {
      rename('name', raw.id);
      rename('body', raw.body);
      lazyParameters((raw.params as AstNode[]) ?? []);
    }
    if (
      raw.type === 'MethodDefinition' ||
      (raw.type === 'Property' && (raw.method || raw.kind === 'get' || raw.kind === 'set'))
    ) {
      const value = raw.value as AstNode;
      set(
        'kind',
        raw.kind === 'constructor'
          ? ts.SyntaxKind.Constructor
          : raw.kind === 'get'
            ? ts.SyntaxKind.GetAccessor
            : raw.kind === 'set'
              ? ts.SyntaxKind.SetAccessor
              : ts.SyntaxKind.MethodDeclaration,
      );
      if (raw.kind !== 'constructor') rename('name', raw.key);
      rename('body', value.body);
      lazyParameters((value.params as AstNode[]) ?? []);
    }
    if (raw.type === 'ClassDeclaration' || raw.type === 'ClassExpression') rename('name', raw.id);
    if (raw.type === 'Property' && !raw.method && raw.kind !== 'get' && raw.kind !== 'set') {
      rename('name', raw.key);
      rename('initializer', raw.value);
    }
    if (raw.type === 'UnaryExpression') {
      set('operator', operators[String(raw.operator)]);
      rename('operand', raw.argument);
    }
    if (['BinaryExpression', 'LogicalExpression', 'AssignmentExpression'].includes(raw.type)) {
      rename('left', raw.left);
      rename('right', raw.right);
      set('operatorToken', { kind: operators[String(raw.operator)] ?? ts.SyntaxKind.Unknown });
    }
    if (raw.type === 'IfStatement') {
      rename('expression', raw.test);
      rename('thenStatement', raw.consequent);
      rename('elseStatement', raw.alternate);
    }
    if (raw.type === 'ConditionalExpression') {
      rename('condition', raw.test);
      rename('whenTrue', raw.consequent);
      rename('whenFalse', raw.alternate);
    }
    if (raw.type === 'ArrayExpression')
      rename(
        'elements',
        ((raw.elements ?? []) as (AstNode | null)[]).map(
          (element) => element ?? { type: 'OmittedExpression', start: raw.start, end: raw.start },
        ),
      );
    if (raw.type === 'Program') {
      set('pos', 0);
      rename('statements', raw.body);
      set('fileName', source.file);
      set('text', text);
      set('getLineAndCharacterOfPosition', (at: number) => {
        if (!positions) {
          positions = indexedLineStarts(text);
        }
        let low = 0,
          high = positions.length;
        while (low + 1 < high) {
          const mid = (low + high) >> 1;
          if (positions[mid] <= at) low = mid;
          else high = mid;
        }
        return { line: low, character: at - positions[low] };
      });
    }
    if (raw.type === 'ImportDeclaration') {
      rename('moduleSpecifier', raw.source);
      set('importClause', {
        namedBindings: {
          kind: ts.SyntaxKind.NamedImports,
          elements: (raw.specifiers as AstNode[])
            .filter((specifier) => specifier.type === 'ImportSpecifier')
            .map((specifier) => make(specifier, node)),
        },
      });
    }
    if (raw.type === 'ImportSpecifier') {
      rename('name', raw.local);
      rename('propertyName', raw.imported);
    }
    if (raw.type === 'TemplateLiteral') {
      const quasis = raw.quasis as AstNode[],
        expressions = raw.expressions as AstNode[];
      const literal = (quasi: AstNode) => {
        const result = make(quasi, node) as unknown as Record<string, unknown>;
        result.kind =
          quasis.length === 1
            ? ts.SyntaxKind.Unknown
            : quasi === quasis[0]
              ? ts.SyntaxKind.TemplateHead
              : quasi === quasis.at(-1)
                ? ts.SyntaxKind.TemplateTail
                : ts.SyntaxKind.TemplateMiddle;
        result.text =
          (quasi.value as { cooked: string | null; raw: string }).cooked ??
          (quasi.value as { raw: string }).raw;
        return result;
      };
      set(
        'kind',
        expressions.length
          ? ts.SyntaxKind.TemplateExpression
          : ts.SyntaxKind.NoSubstitutionTemplateLiteral,
      );
      if (!expressions.length) set('text', literal(quasis[0]).text);
      else {
        set('head', literal(quasis[0]));
        set(
          'templateSpans',
          expressions.map((expression, i) => ({
            expression: make(expression, node),
            literal: literal(quasis[i + 1]),
          })),
        );
      }
    }
    children.set(node, () => {
      const result: ts.Node[] = [];
      const visit = (value: unknown) => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
        } else if (value && typeof value === 'object' && 'type' in value && 'start' in value)
          result.push(make(value as AstNode, node));
      };
      if (raw.type === 'ClassDeclaration' || raw.type === 'ClassExpression') {
        visit(raw.id);
        visit(raw.superClass);
        visit((raw.body as AstNode).body);
      } else if (isIndexedMethod(raw)) {
        visit(raw.key);
        const value = raw.value as AstNode;
        visit(value.params);
        visit(value.body);
      } else for (const value of syntaxChildren(raw)) visit(value);
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
const offsetViews = new Map<string, (value: number) => number>();
export function indexedOffsets(text: string): (value: number) => number {
  const previous = offsetViews.get(text);
  if (previous) return previous;
  const boundaries: { end: number; delta: number }[] = [];
  let delta = 0;
  for (const match of text.matchAll(/[^\x00-\x7f]/gu)) {
    delta += Buffer.byteLength(match[0]) - match[0].length;
    boundaries.push({ end: match.index + match[0].length + delta, delta });
  }
  const offset = !boundaries.length
    ? (value: number) => value
    : (value: number) => {
        let low = 0,
          high = boundaries.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (boundaries[middle].end <= value) low = middle + 1;
          else high = middle;
        }
        return value - (low ? boundaries[low - 1].delta : 0);
      };
  // Source expressions share their file's mapper; arbitrary fixture and SQL
  // inputs cannot grow this process cache without bound.
  if (offsetViews.size === 2048) offsetViews.delete(offsetViews.keys().next().value!);
  offsetViews.set(text, offset);
  return offset;
}

/** SourceFile line breaks include CR and Unicode separators; SQL fragment
 * rules retain their separate historical LF-only line calculations. */
export function indexedLineStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\r\n|[\n\r\u2028\u2029]/g))
    starts.push(match.index + match[0].length);
  return starts;
}

const selectedSyntax = new WeakMap<ts.Node, Map<string, ts.Node[]>>();
const functionTypes = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'MethodDefinition',
]);
const isIndexedMethod = (raw: AstNode) =>
  raw.type === 'MethodDefinition' ||
  (raw.type === 'Property' && !!(raw.method || raw.kind === 'get' || raw.kind === 'set'));
const isIndexedFunction = (raw: AstNode) => functionTypes.has(raw.type) || isIndexedMethod(raw);
const sqlOperation =
  /\b(?:select|update|insert|delete|begin|commit|rollback|perform|create|alter|drop|for)\b|pg_advisory_/i;
const runtimeTypeSyntax = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'TSModuleDeclaration',
  'TSModuleBlock',
  'TSParameterProperty',
  'TSEnumDeclaration',
  'TSEnumBody',
  'TSEnumMember',
  'TSExportAssignment',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSDeclareFunction',
]);
const pureTypeSyntax = (raw: AstNode) =>
  raw.type.startsWith('TS') && !runtimeTypeSyntax.has(raw.type);

/** Traverse indexed facts directly; adapting unrelated type syntax costs more
 * than these guards' rules. Parent chains are adapted only for selected nodes. */
function selectIndexedNodes(
  scope: ts.Node,
  mode: 'source' | 'declarations' | 'relations' | 'sql' | 'trace' | 'templates',
  functions?: ReadonlySet<number | null>,
): ts.Node[] {
  const modes = selectedSyntax.get(scope) ?? new Map<string, ts.Node[]>();
  const cacheKey = functions
    ? `${mode}:${JSON.stringify([...functions].sort((a, b) => (a ?? -1) - (b ?? -1)))}`
    : mode;
  const previous = modes.get(cacheKey);
  if (previous) return previous;
  const indexed = scope as IndexedNode;
  const path: AstNode[] = [];
  const result: ts.Node[] = [];
  const nodeForPath = () => {
    let parent = scope.parent;
    for (let index = 0; index < path.length; index++) {
      const raw = path[index];
      const prior = path[index - 1];
      if (
        raw.type === 'ClassBody' ||
        (raw.type === 'FunctionExpression' &&
          prior &&
          isIndexedMethod(prior) &&
          prior.value === raw)
      )
        continue;
      parent = indexed.sourceContext.make!(raw, parent);
    }
    return parent!;
  };
  const walk = (value: unknown, ownerStart: number | null = null) => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, ownerStart);
      return;
    }
    if (!value || typeof value !== 'object' || !('type' in value) || !('start' in value)) return;
    const raw = value as AstNode;
    if (mode === 'declarations' && pureTypeSyntax(raw)) return;
    const parent = path.at(-1);
    const methodBody =
      raw.type === 'FunctionExpression' &&
      parent &&
      isIndexedMethod(parent) &&
      parent.value === raw;
    if (
      mode === 'declarations' &&
      raw !== indexed.rawSyntax &&
      isIndexedFunction(raw) &&
      !methodBody
    )
      return;
    path.push(raw);
    const callee = raw.callee as AstNode | undefined;
    const property = callee?.property as AstNode | undefined;
    const selected =
      mode === 'declarations'
        ? raw.type === 'VariableDeclarator'
        : mode === 'relations'
          ? raw.type === 'TemplateLiteral' ||
            (raw.type === 'Literal' && typeof raw.value === 'string' && raw.value.includes('.'))
          : mode === 'templates'
            ? raw.type === 'TemplateLiteral' && functions!.has(raw.start)
            : mode === 'sql'
              ? (raw.type === 'CallExpression' &&
                  callee?.type === 'MemberExpression' &&
                  !callee.computed &&
                  property?.type === 'Identifier' &&
                  /^(query|execute)$/.test(String(property.name))) ||
                raw.type === 'TemplateLiteral' ||
                (raw.type === 'Literal' &&
                  typeof raw.value === 'string' &&
                  sqlOperation.test(raw.value))
              : mode === 'trace'
                ? (isIndexedFunction(raw) && !methodBody && functions!.has(raw.start)) ||
                  (raw.type === 'CallExpression' && functions!.has(ownerStart))
                : raw.type === 'ImportDeclaration' ||
                  raw.type === 'VariableDeclarator' ||
                  raw.type === 'CallExpression' ||
                  (isIndexedFunction(raw) && !methodBody) ||
                  raw.type === 'TemplateLiteral' ||
                  (raw.type === 'Literal' &&
                    typeof raw.value === 'string' &&
                    sqlOperation.test(raw.value));
    if (selected) result.push(nodeForPath());
    if (
      (mode === 'relations' || mode === 'templates' || mode === 'sql') &&
      raw.type === 'TemplateLiteral'
    ) {
      path.pop();
      return;
    }
    const childOwner =
      mode === 'trace' && isIndexedFunction(raw) && !methodBody ? raw.start : ownerStart;
    for (const child of syntaxChildren(raw)) walk(child, childOwner);
    path.pop();
  };
  walk(indexed.rawSyntax);
  modes.set(cacheKey, result);
  selectedSyntax.set(scope, modes);
  return result;
}

export function indexedSourceNodes(source: { file: string; text: string }): ts.Node[] {
  return selectIndexedNodes(indexedSourceFile(source), 'source');
}

const scopedDeclarationPresence = new WeakMap<AstNode, boolean>();
function containsScopedDeclaration(raw: AstNode): boolean {
  if (pureTypeSyntax(raw)) return false;
  const previous = scopedDeclarationPresence.get(raw);
  if (previous !== undefined) return previous;
  let found = raw.type === 'VariableDeclarator';
  const inspect = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    if (!value || typeof value !== 'object' || !('type' in value) || !('start' in value)) return;
    const child = value as AstNode;
    const methodBody = isIndexedMethod(raw) && raw.value === child;
    if (isIndexedFunction(child) && !methodBody) return;
    found = containsScopedDeclaration(child);
  };
  for (const child of syntaxChildren(raw)) inspect(child);
  scopedDeclarationPresence.set(raw, found);
  return found;
}

const declarationNames = new WeakMap<IndexedFile, Set<string>>();
export function indexedHasDeclaration(node: ts.Node, name: string): boolean | undefined {
  const index = (node as IndexedNode).sourceContext?.declarationIndex;
  if (!index) return undefined;
  let names = declarationNames.get(index);
  if (!names && index.aliases) {
    names = new Set(index.aliases.map((alias) => alias.name));
    declarationNames.set(index, names);
  }
  return names?.has(name);
}
export function indexedScopedDeclarations(scope: ts.Node, name?: string): ts.VariableDeclaration[] {
  const context = (scope as IndexedNode).sourceContext;
  if (name !== undefined && indexedHasDeclaration(scope, name) === false) return [];
  if (context.variableFacts) {
    const raw = (scope as IndexedNode).rawSyntax;
    const facts = variableScopes(context.variableFacts).get(scopeKey(raw));
    return (
      facts
        ?.filter((fact) => name === undefined || fact.name === name)
        .map((fact) => variableDeclaration(context, fact)) ?? []
    );
  }
  return containsScopedDeclaration((scope as IndexedNode).rawSyntax)
    ? (selectIndexedNodes(scope, 'declarations').filter(
        (node) =>
          (node as IndexedNode).rawSyntax.init != null &&
          (name === undefined || (node as ts.VariableDeclaration).name.getText() === name),
      ) as ts.VariableDeclaration[])
    : [];
}

const variableScopeMaps = new WeakMap<VariableFact[], Map<string, VariableFact[]>>();
// Each fact array belongs to one source file with one module scope. ESTree
// computes Program bounds from retained statements, so trimming declarations
// or trailing trivia must not give that module scope a different identity.
const scopeKey = (span: SyntaxSpan) =>
  span.type === 'Program' ? 'Program' : `${span.type}:${span.start}:${span.end}`;
function variableScopes(facts: VariableFact[]): Map<string, VariableFact[]> {
  const previous = variableScopeMaps.get(facts);
  if (previous) return previous;
  const scopes = new Map<string, VariableFact[]>();
  for (const fact of facts)
    for (const key of new Set(fact.scopes.map(scopeKey))) {
      const declarations = scopes.get(key) ?? [];
      declarations.push(fact);
      scopes.set(key, declarations);
    }
  variableScopeMaps.set(facts, scopes);
  return scopes;
}

function ancestorView(context: SourceContext, span: SyntaxSpan, parent?: ts.Node): ts.Node {
  return Object.assign(Object.create(nodePrototype), {
    kind: ts.SyntaxKind[(kindNames[span.type] ?? 'Unknown') as keyof typeof ts.SyntaxKind],
    pos: context.offset(span.start),
    end: context.offset(span.end),
    parent,
    sourceContext: context,
    rawSyntax: span,
  }) as ts.Node;
}

function variableDeclaration(context: SourceContext, fact: VariableFact): ts.VariableDeclaration {
  context.declarations ??= new WeakMap();
  const previous = context.declarations.get(fact);
  if (previous) return previous;
  const declaration = ancestorView(context, {
    type: 'VariableDeclarator',
    start: fact.start,
    end: fact.end,
  }) as ts.VariableDeclaration;
  context.declarations.set(fact, declaration);
  Object.defineProperty(declaration, 'name', {
    value: { kind: ts.SyntaxKind.Unknown, getText: () => fact.name },
  });
  Object.defineProperty(declaration, 'initializer', {
    configurable: true,
    get: () => {
      if (!fact.initializerAst)
        throw new Error(`Missing indexed initializer: ${context.file}:${fact.start}`);
      const expression = factExpression(context, fact.initializerAst);
      // Independent expression payloads share the original source's ancestry,
      // including the declaration itself. Scope membership comes from parser
      // facts; the TypeScript rule still chooses the first preceding binding.
      let parent: ts.Node | undefined;
      for (const span of [...fact.initializerAncestors].reverse()) {
        if (span.type === 'Program') parent = context.ast;
        else if (
          span.type === 'VariableDeclarator' &&
          span.start === fact.start &&
          span.end === fact.end
        ) {
          (declaration as unknown as { parent?: ts.Node }).parent = parent;
          parent = declaration;
        } else parent = ancestorView(context, span, parent);
      }
      (expression as unknown as { parent?: ts.Node }).parent = parent ?? declaration;
      Object.defineProperty(declaration, 'initializer', { value: expression });
      return expression;
    },
  });
  return declaration;
}

function attachDeclarations(context: SourceContext, facts: IndexedFile): void {
  if (context.declarationIndex === facts) return;
  context.declarationIndex = facts;
  Object.defineProperty(context, 'variableFacts', {
    configurable: true,
    get: () => {
      const variables = facts.variableFacts;
      Object.defineProperty(context, 'variableFacts', {
        value: variables,
        writable: true,
        configurable: true,
      });
      return variables;
    },
  });
}

type SqlSourceView = {
  ast: ts.SourceFile;
  context: SourceContext;
  ancestors: Map<string, ts.Node>;
  selected?: ts.Node[];
};
const sqlSourceViews = new WeakMap<IndexedFile, SqlSourceView>();
function sqlSourceView(source: { file: string; text: string }, facts: IndexedFile): SqlSourceView {
  const previous = sqlSourceViews.get(facts);
  if (previous) return previous;
  const ast = indexedSourceFile(source, {
    type: 'Program',
    start: 0,
    end: Buffer.byteLength(source.text),
    body: [],
  });
  const context = (ast as unknown as IndexedNode).sourceContext;
  attachDeclarations(context, facts);
  const view = { ast, context, ancestors: new Map<string, ts.Node>([['Program', ast]]) };
  sqlSourceViews.set(facts, view);
  return view;
}

function factExpression(source: SourceContext, syntax: AstNode): ts.Expression {
  const statement = (syntax.body as AstNode[])[0];
  return source.make!(statement.expression as AstNode) as ts.Expression;
}

function sqlAncestor(view: SqlSourceView, span: SqlAncestor): ts.Node {
  const key = scopeKey(span);
  const previous = view.ancestors.get(key);
  if (previous) return previous;
  const node = ancestorView(view.context, span);
  if (span.type === 'CallExpression') (node as unknown as { arguments: ts.Node[] }).arguments = [];
  if (span.functionLike)
    (node as unknown as { kind: ts.SyntaxKind }).kind =
      span.methodKind === 'constructor'
        ? ts.SyntaxKind.Constructor
        : span.methodKind === 'get'
          ? ts.SyntaxKind.GetAccessor
          : span.methodKind === 'set'
            ? ts.SyntaxKind.SetAccessor
            : kindNames[span.type] === 'ArrowFunction'
              ? ts.SyntaxKind.ArrowFunction
              : kindNames[span.type] === 'FunctionDeclaration'
                ? ts.SyntaxKind.FunctionDeclaration
                : ts.SyntaxKind.MethodDeclaration;
  view.ancestors.set(key, node);
  return node;
}

function sqlFactNodes(source: { file: string; text: string }, facts: IndexedFile): ts.Node[] {
  const view = sqlSourceView(source, facts);
  if (view.selected) return view.selected;
  const selected: ts.Node[] = [];
  for (const fact of facts.sqlNodeFacts ?? []) {
    const immediate = fact.ancestors[0];
    const firstArgument = immediate?.type === 'CallExpression' && immediate.firstArgument;
    if (firstArgument) {
      const parent = view.ancestors.get(scopeKey(immediate)) as IndexedNode | undefined;
      const argument = (parent?.rawSyntax.arguments as AstNode[] | undefined)?.[0];
      // Query calls already carry their argument syntax. The fragment visitor
      // ignores direct string/template first arguments, so never hydrate them
      // again. Nested query calls remain independently selected.
      if (argument?.type === 'Literal' || argument?.type === 'TemplateLiteral') continue;
    }
    if (!fact.nodeAst) throw new Error(`Missing indexed SQL expression: ${source.file}`);
    const expression = (fact.nodeAst.body as AstNode[])[0].expression as AstNode;
    if (firstArgument && (expression.type === 'Literal' || expression.type === 'TemplateLiteral'))
      continue;
    const node = factExpression(view.context, fact.nodeAst);
    selected.push(node);
    // Real selected calls retain their complete value arguments. Ancestor
    // skeletons supply only parent identity and structural branch membership.
    view.ancestors.set(scopeKey((node as unknown as IndexedNode).rawSyntax), node);
    let child: ts.Node = node;
    for (const span of fact.ancestors) {
      const parent = sqlAncestor(view, span);
      (child as unknown as { parent?: ts.Node }).parent = parent;
      const mutable = parent as unknown as Record<string, unknown>;
      if (span.firstArgument && span.type === 'CallExpression') {
        const arguments_ = mutable.arguments as ts.Node[] | undefined;
        if (!arguments_?.length) mutable.arguments = [child];
        else if (child === node) arguments_[0] = child;
      }
      if (span.branch) {
        const conditional = span.type === 'ConditionalExpression';
        mutable[
          conditional
            ? span.branch === 'then'
              ? 'whenTrue'
              : 'whenFalse'
            : span.branch === 'then'
              ? 'thenStatement'
              : 'elseStatement'
        ] = child;
        const conditionField = conditional ? 'condition' : 'expression';
        if (!(conditionField in mutable))
          Object.defineProperty(mutable, conditionField, {
            configurable: true,
            get: () => {
              if (!span.conditionAst)
                throw new Error(`Missing indexed branch condition: ${source.file}:${span.start}`);
              const expression = factExpression(view.context, span.conditionAst);
              (expression as unknown as { parent?: ts.Node }).parent = parent;
              Object.defineProperty(mutable, conditionField, { value: expression });
              return expression;
            },
          });
      }
      child = parent;
    }
  }
  view.selected = selected;
  return selected;
}

/** Query/literal syntax and declaration membership are independent payloads.
 * Unused initializers stay compressed instead of widening the source walk. */
export function indexedFragmentSourceFile(source: { file: string; text: string }): ts.SourceFile {
  const facts = indexedSource(source);
  if ('sqlNodeFacts' in facts) return sqlSourceView(source, facts).ast;
  const ast = indexedSourceFile(source, facts.fragmentAst ?? facts.sqlAst);
  if (facts.fragmentAst && 'variableFacts' in facts)
    attachDeclarations((ast as unknown as IndexedNode).sourceContext, facts);
  return ast;
}

export function indexedFragmentNodes(source: { file: string; text: string }): ts.Node[] {
  const facts = indexedSource(source);
  if ('sqlNodeFacts' in facts) return sqlFactNodes(source, facts);
  return selectIndexedNodes(indexedFragmentSourceFile(source), 'sql');
}

export function indexedRelationNodes(source: { file: string; text: string }): ts.Node[] {
  return selectIndexedNodes(indexedSourceFile(source), 'relations');
}

export function indexedSqlNodes(
  source: { file: string; text: string },
  syntax?: AstNode,
): ts.Node[] {
  return selectIndexedNodes(indexedSourceFile(source, syntax), 'sql');
}

export function indexedTraceNodes(
  source: { file: string; text: string },
  functions: ReadonlySet<number | null>,
): ts.Node[] {
  return selectIndexedNodes(indexedTraceSourceFile(source), 'trace', functions);
}

export function indexedTraceSourceFile(source: { file: string; text: string }): ts.SourceFile {
  const facts = indexedSource(source);
  const ast = indexedSourceFile(source, facts.traceAst ?? facts.runtimeAst ?? facts.ast);
  if (facts.traceAst && 'variableFacts' in facts)
    attachDeclarations((ast as unknown as IndexedNode).sourceContext, facts);
  return ast;
}

export function indexedTemplateNodes(
  source: { file: string; text: string },
  starts: ReadonlySet<number>,
  syntax?: AstNode,
): ts.Node[] {
  return selectIndexedNodes(indexedSourceFile(source, syntax), 'templates', starts);
}
