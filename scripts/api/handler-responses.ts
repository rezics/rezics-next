import ts from 'typescript-6';

interface Evidence { status: number; code?: string; line: number }
export interface HandlerFacts {
  responses: Evidence[];
  rawConstructors: number;
  sharedRawHelpers: string[];
  dynamicStatuses: string[];
  calls: string[];
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function property(node: ts.Node | undefined, key: string): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return;
  for (const item of node.properties) {
    if (ts.isPropertyAssignment(item) && item.name.getText().replace(/['"]/g, '') === key) return item.initializer;
  }
}

function numbers(node: ts.Expression | undefined): number[] {
  if (!node) return [];
  if (ts.isNumericLiteral(node)) return [Number(node.text)];
  if (ts.isParenthesizedExpression(node)) return numbers(node.expression);
  if (ts.isConditionalExpression(node)) return [...numbers(node.whenTrue), ...numbers(node.whenFalse)];
  return [];
}

/** A syntactic lower bound, not a claim to solve domain reachability. Follows
 * same-file helper calls; imported domain calls and dynamic statuses stay explicit. */
export function inspectHandler(source: string, line: number, followLocal = true): HandlerFacts | undefined {
  const file = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
  const helpers = new Map<string, ts.Node>();
  const constants = new Map<string, ts.Expression>();
  let handler: ts.Node | undefined;
  walk(file, node => {
    if (ts.isFunctionDeclaration(node) && node.name) helpers.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      helpers.set(node.name.text, node.initializer);
    }
    if (!ts.isCallExpression(node)) return;
    const member = node.expression;
    const method = ts.isPropertyAccessExpression(member) ? member.name
      : ts.isElementAccessExpression(member) && ts.isPropertyAccessExpression(member.argumentExpression)
        && member.argumentExpression.name.text === 'method' ? member.argumentExpression : undefined;
    if (!method) return;
    if (ts.isIdentifier(method) && !/^(get|post|put|patch|delete|head|options|all|ws|route)$/.test(method.text)) return;
    if (file.getLineAndCharacterOfPosition(method.getStart(file)).line + 1 !== line) return;
    handler = [...node.arguments].reverse().find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
    if (!handler) {
      const candidate = node.arguments.at(-1);
      if (candidate && ts.isIdentifier(candidate)) handler = helpers.get(candidate.text);
      if (candidate && ts.isCallExpression(candidate)) handler = candidate;
    }
  });
  if (!handler) return;
  const result: HandlerFacts = { responses: [], rawConstructors: 0, sharedRawHelpers: [], dynamicStatuses: [], calls: [] };
  const seen = new Set<ts.Node>();
  const scan = (root: ts.Node) => {
    if (seen.has(root)) return;
    seen.add(root);
    walk(root, node => {
      const record = (expression: ts.Expression | undefined, code?: ts.Expression, fallback?: number) => {
        const values = expression ? numbers(expression) : fallback ? [fallback] : [];
        if (!values.length) result.dynamicStatuses.push(expression?.getText(file) ?? '(unknown)');
        for (const status of values) result.responses.push({ status,
          ...(code && ts.isStringLiteral(code) ? { code: code.text } : {}),
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
      };
      const responseStatus = (init: ts.Expression | undefined) => {
        let value = init;
        const visited = new Set<string>();
        while (value && ts.isIdentifier(value) && constants.has(value.text) && !visited.has(value.text)) {
          visited.add(value.text);
          value = constants.get(value.text);
        }
        if (!value || ts.isObjectLiteralExpression(value)) record(property(value, 'status'), undefined, 200);
        else result.dynamicStatuses.push(`ResponseInit: ${value.getText(file)}`);
      };
      if (ts.isNewExpression(node) && node.expression.getText(file) === 'Response') {
        result.rawConstructors++;
        responseStatus(node.arguments?.[1]);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText(file) === 'set.status') record(node.right);
      if (!ts.isCallExpression(node)) return;
      const name = node.expression.getText(file);
      result.calls.push(name);
      if (name === 'problem') {
        result.sharedRawHelpers.push(name);
        record(node.arguments[0], node.arguments[1]);
      } else if (name === 'status') record(node.arguments[0]);
      else if (name === 'Response.json' || name === 'Response.redirect') {
        result.rawConstructors++;
        if (name === 'Response.redirect') record(node.arguments[1], undefined, 302);
        else responseStatus(node.arguments[1]);
      } else if (['commandError', 'typedRefusal', 'workReadError'].includes(name)) result.sharedRawHelpers.push(name);
      if (followLocal && helpers.has(name)) scan(helpers.get(name)!);
    });
  };
  scan(handler);
  result.sharedRawHelpers = [...new Set(result.sharedRawHelpers)].sort();
  result.dynamicStatuses = [...new Set(result.dynamicStatuses)].sort();
  result.calls = [...new Set(result.calls)].sort();
  result.responses = [...new Map(result.responses.map(value => [JSON.stringify(value), value])).values()];
  return result;
}
