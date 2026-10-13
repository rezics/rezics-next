import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript-6';

const unknown = Symbol('unknown');
type Value = unknown;
type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
interface FunctionValue { callable: Callable; bindings: Map<string, Value> }
interface State { bindings: Map<string, Value>; admitted: boolean; returned?: { value: Value } }
interface Alternatives { alternatives: Value[] }
const alternatives = (values: Value[]): Value => {
  const flattened = [...new Set(values.flatMap(choices))];
  return flattened.length === 1 ? flattened[0] : { alternatives: flattened };
};
const choices = (value: Value): Value[] => value && typeof value === 'object' && 'alternatives' in value
  ? (value as Alternatives).alternatives : [value];
const truths = (value: Value): boolean[] => [...new Set(choices(value).flatMap(item => item === unknown ? [true, false] : [!!item]))];
const property = (value: Value, key: string): Value => alternatives(choices(value).map(item => item === unknown ? unknown
  : item && typeof item === 'object' ? (item as Record<string, Value>)[key] : undefined));
const callable = (node: ts.Node): node is Callable => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
  || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
const sources = new Map<string, ts.SourceFile>();
export function resetCommandSources(): void { sources.clear(); }
export function commandSource(file: string): ts.SourceFile {
  // A guard invocation may rewrite fixtures between scans; never retain stale source.
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  sources.set(file, source);
  return source;
}

/** Execute the response-dependent control flow as abstract values, without running app code or effects. */
export function completesAdmission(call: ts.CallExpression, answer: object): boolean {
  // Awaiting a raw command as a statement drops its admission outcome entirely.
  let use: ts.Node = call;
  while (ts.isAwaitExpression(use.parent) || ts.isParenthesizedExpression(use.parent)
    || ts.isAsExpression(use.parent) || ts.isNonNullExpression(use.parent)) use = use.parent;
  if (ts.isExpressionStatement(use.parent)) return true;
  let steps = 0;
  const active = new Set<ts.Node>();
  function lookup(name: string, node: ts.Node, state: State): Value {
    if (state.bindings.has(name)) return state.bindings.get(name);
    let scope: ts.Node | undefined = node.parent;
    while (scope) {
      let found: ts.Node | undefined;
      const visit = (child: ts.Node) => {
        if ((ts.isVariableDeclaration(child) || ts.isFunctionDeclaration(child)) && child.name?.getText() === name) found = child;
        if (child !== scope && callable(child)) return;
        ts.forEachChild(child, visit);
      };
      ts.forEachChild(scope, visit);
      if (found && !active.has(found)) {
        active.add(found);
        const declaration = found as ts.VariableDeclaration | ts.FunctionDeclaration;
        const value = ts.isFunctionDeclaration(declaration) ? { callable: declaration, bindings: new Map(state.bindings) }
          : declaration.initializer ? evaluate(declaration.initializer, state) : unknown;
        active.delete(found);
        return value;
      }
      scope = scope.parent;
    }
    const source = node.getSourceFile();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !statement.moduleSpecifier.text.startsWith('.')) continue;
      const imports = statement.importClause?.namedBindings;
      if (!imports || !ts.isNamedImports(imports)) continue;
      const imported = imports.elements.find(item => item.name.text === name);
      if (!imported) continue;
      const file = resolve(dirname(source.fileName), statement.moduleSpecifier.text);
      if (!existsSync(file)) return unknown;
      const module = sources.get(file) ?? commandSource(file);
      return lookup((imported.propertyName ?? imported.name).text, module.endOfFileToken, { bindings: new Map(), admitted: false });
    }
    return unknown;
  }
  function bind(name: ts.BindingName, value: Value, state: State) {
    if (ts.isIdentifier(name)) state.bindings.set(name.text, value);
    else for (const [index, element] of name.elements.entries()) {
      if (ts.isOmittedExpression(element)) continue;
      bind(element.name, property(value, ts.isArrayBindingPattern(name) ? String(index) : element.propertyName?.getText() ?? element.name.getText()), state);
    }
  }
  function invoke(fn: FunctionValue, args: Value[], state: State, consumer = false): Value {
    if (++steps > 1500 || active.has(fn.callable) || !fn.callable.body) return unknown;
    active.add(fn.callable);
    const inner: State = { bindings: new Map(fn.bindings), admitted: state.admitted };
    fn.callable.parameters.forEach((parameter, index) => bind(parameter.name,
      args[index] ?? (parameter.initializer ? evaluate(parameter.initializer, inner) : unknown), inner));
    const results = ts.isBlock(fn.callable.body) ? execute([...fn.callable.body.statements], [inner])
      : (() => { const value = evaluate(fn.callable.body, inner); return [{ ...inner, returned: { value } }]; })();
    state.admitted ||= results.some(result => result.admitted);
    active.delete(fn.callable);
    const reached = results.some(result => result.admitted) ? results.filter(result => result.admitted) : results;
    const values = reached.map(result => result.returned?.value);
    // An independently reconciled read-back has an unknown boolean result; it is not admission evidence.
    if (!consumer && !(fn.callable.pos <= call.pos && call.end <= fn.callable.end && fn.callable.getSourceFile() === call.getSourceFile()) && values.includes(true) && values.includes(false)) return unknown;
    return alternatives(values);
  }
  function evaluate(node: ts.Expression, state: State): Value {
    if (++steps > 1500) return unknown;
    if (node === call) { state.admitted = true; return answer; }
    if (ts.isIdentifier(node)) return node.text === 'undefined' ? undefined : lookup(node.text, node, state);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return evaluate(node.expression, state);
    if (ts.isPropertyAccessExpression(node)) return property(evaluate(node.expression, state), node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const key = evaluate(node.argumentExpression, state);
      return typeof key === 'string' ? property(evaluate(node.expression, state), key) : unknown;
    }
    if (ts.isTypeOfExpression(node)) { const value = evaluate(node.expression, state); return value === unknown ? unknown : typeof value; }
    if (ts.isPrefixUnaryExpression(node)) {
      const value = evaluate(node.operand, state);
      return value === unknown ? unknown : node.operator === ts.SyntaxKind.ExclamationToken ? !value : unknown;
    }
    if (callable(node)) return { callable: node, bindings: new Map(state.bindings) };
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => evaluate(element, state));
    if (ts.isObjectLiteralExpression(node)) {
      const value: Record<string, Value> = {};
      for (const member of node.properties) {
        if (ts.isPropertyAssignment(member)) value[member.name.getText().replace(/^['"]|['"]$/g, '')] = evaluate(member.initializer, state);
        if (ts.isShorthandPropertyAssignment(member)) value[member.name.text] = lookup(member.name.text, member, state);
        if (ts.isSpreadAssignment(member)) { const spread = evaluate(member.expression, state); if (spread && typeof spread === 'object') Object.assign(value, spread); }
      }
      return value;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = evaluate(node.condition, state);
      return alternatives(truths(condition).map(truth => evaluate(truth ? node.whenTrue : node.whenFalse, state)));
    }
    if (ts.isBinaryExpression(node)) {
      const left = evaluate(node.left, state);
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && left !== unknown && !left) return left;
      if (op === ts.SyntaxKind.BarBarToken && left !== unknown && left) return left;
      if (op === ts.SyntaxKind.QuestionQuestionToken && left !== unknown && left !== null && left !== undefined) return left;
      const right = evaluate(node.right, state);
      if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) { state.bindings.set(node.left.text, right); return right; }
      if (left === unknown || right === unknown) return unknown;
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) return left === right;
      if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) return left !== right;
      if (op === ts.SyntaxKind.InKeyword) return typeof left === 'string' && !!right && typeof right === 'object' && left in right;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return left && right;
      if (op === ts.SyntaxKind.BarBarToken) return left || right;
      if (op === ts.SyntaxKind.QuestionQuestionToken) return left ?? right;
      return unknown;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && ['then', 'catch'].includes(node.expression.name.text)) {
        const value = evaluate(node.expression.expression, state);
        if (node.expression.name.text === 'catch') return value;
        const callback = node.arguments[0] ? evaluate(node.arguments[0], state) : unknown;
        if (callback && typeof callback === 'object' && 'callable' in callback) return invoke(callback as FunctionValue, [value], state);
        return unknown;
      }
      if (node.expression.getText() === 'Promise.all' && node.arguments[0]) return evaluate(node.arguments[0], state);
      const fn = evaluate(node.expression, state);
      const args = node.arguments.map(argument => evaluate(argument, state));
      if (fn && typeof fn === 'object' && 'callable' in fn) return invoke(fn as FunctionValue, args, state);
      return unknown;
    }
    return unknown;
  }
  function execute(statements: ts.Statement[], states: State[]): State[] {
    for (const statement of statements) {
      states = states.flatMap(state => {
        if (state.returned || ++steps > 1500) return [state];
        if (ts.isReturnStatement(statement)) {
          const value = statement.expression ? evaluate(statement.expression, state) : undefined;
          return [{ ...state, returned: { value } }];
        }
        if (ts.isBlock(statement)) return execute([...statement.statements], [state]);
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          bind(declaration.name, declaration.initializer ? evaluate(declaration.initializer, state) : unknown, state);
        }
        if (ts.isExpressionStatement(statement)) evaluate(statement.expression, state);
        if (ts.isIfStatement(statement)) {
          const condition = evaluate(statement.expression, state);
          const branches = truths(condition);
          return branches.flatMap(truth => {
            const branch = truth ? statement.thenStatement : statement.elseStatement;
            return branch ? execute([branch], [{ ...state, bindings: new Map(state.bindings) }]) : [state];
          });
        }
        if (ts.isSwitchStatement(statement)) {
          const value = evaluate(statement.expression, state);
          const clauses = statement.caseBlock.clauses;
          const matched = clauses.findIndex(clause => ts.isCaseClause(clause) && evaluate(clause.expression, state) === value);
          const fallback = clauses.findIndex(clause => ts.isDefaultClause(clause));
          const starts = value === unknown ? clauses.map((_, index) => index) : [matched >= 0 ? matched : fallback];
          return starts.flatMap(index => {
            if (index < 0) return [state];
            const body: ts.Statement[] = [];
            outer: for (const clause of clauses.slice(index)) for (const item of clause.statements) {
              if (ts.isBreakStatement(item)) break outer;
              body.push(item);
            }
            return execute(body, [{ ...state, bindings: new Map(state.bindings) }]);
          });
        }
        if (ts.isTryStatement(statement)) return execute([...statement.tryBlock.statements], [state]);
        if (ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isWhileStatement(statement)
          || ts.isDoStatement(statement)) return execute([statement.statement], [state]);
        return [state];
      });
      if (states.length > 64) return states.slice(0, 64);
    }
    return states;
  }
  function completed(value: Value): boolean {
    return choices(value).some(item => {
      if (item === answer || item === property(answer, 'data')) return false; // preserve the response/receipt discriminants
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, Value>;
      if (row.completed === true || row.success === true || row.removed === true || typeof row.receipt === 'string'
        || [row.status, row.kind, row.outcome].some(marker => ['done', 'saved', 'published', 'created', 'completed', 'success'].includes(String(marker)))) return true;
      if (row.ok === true && (row.pending === true || property(row.data, 'pending') === true
        || property(property(row.data, 'operation'), 'status') === 'accepted'
        || property(property(row.data, 'operation'), 'status') === 'partial')) return false;
      return row.ok === true;
    });
  }
  let owner: ts.Node | undefined = call.parent;
  while (owner && !callable(owner)) owner = owner.parent;
  if (!owner || !callable(owner) || !owner.body) return false;
  // A forwarding closure may be passed to a settling helper; inspect that helper's result too.
  const state: State = { bindings: new Map(), admitted: false };
  let value = invoke({ callable: owner, bindings: new Map() }, [], state, true);
  if (ts.isCallExpression(owner.parent)) {
    let consumer: ts.Node | undefined = owner.parent.parent;
    while (consumer && !callable(consumer)) consumer = consumer.parent;
    if (consumer && callable(consumer)) {
      steps = 0;
      state.admitted = false;
      value = invoke({ callable: consumer, bindings: new Map() }, [], state, true);
    }
  }
  if (state.admitted && completed(value)) return true;
  const declaration = owner.parent;
  const name = ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) ? declaration.name.text
    : ts.isFunctionDeclaration(owner) ? owner.name?.text : undefined;
  let completion = false;
  if (name) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        let consumer: ts.Node | undefined = node.parent;
        while (consumer && !callable(consumer)) consumer = consumer.parent;
        if (consumer && callable(consumer) && consumer !== owner) {
          const context: State = { bindings: new Map(), admitted: false };
          const target = lookup(name, node, context);
          if (target && typeof target === 'object' && 'callable' in target && (target as FunctionValue).callable === owner) {
            steps = 0;
            const result = invoke({ callable: consumer, bindings: new Map() }, [], context, true);
            completion ||= context.admitted && completed(result);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(call.getSourceFile());
  }
  return completion;
}
