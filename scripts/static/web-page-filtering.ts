import { dirname, join, normalize } from 'node:path';
import { parseSync, type Node } from 'oxc-parser';
import { isWebDataModule, webChildren as children, webProgram } from './web-source-scan.ts';
import { pageOutputFlow, pageOutputFlows, type WebSource } from './web-continuations.ts';

export interface PageSelection { path: string; consumer: string; operation: string; predicate: string }
interface Unit { file: WebSource; name: string; nodes: Node[]; variables: Map<string, Node> }
const name = (node?: Node | null): string => node?.type === 'Identifier' ? node.name
  : node?.type === 'Literal' ? String(node.value) : node?.type === 'MemberExpression' ? name(node.property) : '';
// Preserve literals and operators, ignore trivia and parser position metadata.
export const structure = (node: Node): string => JSON.stringify(node, (key, value) =>
  ['start', 'end', 'raw', 'loc', 'range', 'comments', 'typeAnnotation', 'decorators'].includes(key)
    ? undefined : value);
const descendants = (node: Node): Node[] => [node, ...children(node).flatMap(descendants)];
const production = (path: string) => !/(?:^|\/)(?:__tests__|fixtures|tests)(?:\/|\.)|\.(?:test|spec|stories)\.|fixtures\./.test(path);

/** Conservative inventory of selection syntax along page-producing reads. Exceptions
 * describe one predicate, never a source file; a second predicate needs its own evidence.
 * This is a regression guard, not an interprocedural proof of catalogue completeness. */
export function pageSelections(sources: readonly WebSource[], paged = new Set<string>()): PageSelection[] {
  const units: Unit[] = [];
  const parents = new WeakMap<Node, Node>();
  const owners = new WeakMap<Node, Unit>();
  const imports = new Map<string, string>();
  const opaqueImports = new Set<string>();
  let unknownImport = false;
  const paths = new Set(sources.map(file => file.path));
  const outputFlows = new Map<WebSource, ReturnType<typeof pageOutputFlow>>();
  const fileFlows = pageOutputFlows(sources);
  const resolve = (path: string, specifier: string) => {
    const target = normalize(join(dirname(path), specifier));
    return [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`].find(path => paths.has(path)) ?? target;
  };
  const key = (unit: Unit) => `${unit.file.path}:${unit.name}`;
  for (const file of sources.filter(file => production(file.path))) {
    const program = webProgram(file);
    const localExport = descendants(program).some(node => node.type === 'ExportDefaultDeclaration'
      || node.type === 'ExportNamedDeclaration' && !node.source && node.specifiers.length > 0);
    // Re-export-only modules are data modules for the consumer inventory, but
    // their references still prevent an exhaustive named-caller proof.
    for (const node of descendants(program)) {
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type'
        && String(node.source.value).startsWith('.')
        && (localExport || node.specifiers.some(specifier => specifier.type === 'ImportNamespaceSpecifier'))) {
        opaqueImports.add(resolve(file.path, String(node.source.value)));
      }
      if (node.type === 'ImportExpression') {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          opaqueImports.add(resolve(file.path, node.source.value));
        } else unknownImport = true;
      }
      if ((node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration')
        && node.source && String(node.source.value).startsWith('.')) {
        opaqueImports.add(resolve(file.path, String(node.source.value)));
      }
    }
    if (isWebDataModule(program)) continue;
    outputFlows.set(file, fileFlows.get(file.path)!);
    const root: Unit = { file, name: '<module>', nodes: [], variables: new Map() };
    units.push(root);
    const visit = (node: Node, unit: Unit, parent?: Node) => {
      if (parent) parents.set(node, parent);
      if (node.type === 'ImportDeclaration' && String(node.source.value).startsWith('.')) {
        for (const specifier of node.specifiers) if (specifier.type === 'ImportSpecifier') {
          imports.set(`${file.path}:${name(specifier.local)}`, `${resolve(file.path, String(node.source.value))}:${name(specifier.imported)}`);
        }
      }
      const consumer = node.type === 'FunctionDeclaration' ? name(node.id)
        : /^(ArrowFunctionExpression|FunctionExpression)$/.test(node.type)
          ? parent?.type === 'VariableDeclarator' ? name(parent.id) : parent?.type === 'Property' ? name(parent.key)
            : parent?.type === 'CallExpression' && parents.get(parent)?.type === 'VariableDeclarator'
              ? name((parents.get(parent) as Extract<Node, { type: 'VariableDeclarator' }>).id) : '' : '';
      if (consumer) { unit = { file, name: consumer, nodes: [], variables: new Map() }; units.push(unit); }
      owners.set(node, unit);
      unit.nodes.push(node);
      if (node.type === 'VariableDeclarator' && node.init) unit.variables.set(name(node.id), node.init);
      for (const child of children(node)) visit(child, unit, node);
    };
    visit(program, root);
  }
  const operations = new Map<string, Set<string>>();
  const callKey = (unit: Unit, node: Node) => {
    if (node.type === 'MemberExpression' && node.object.type === 'AwaitExpression'
      && node.object.argument.type === 'ImportExpression') {
      return `${resolve(unit.file.path, name(node.object.argument.source))}:${name(node.property)}`;
    }
    const local = `${unit.file.path}:${name(node)}`;
    return imports.get(local) ?? local;
  };
  const route = (node: Node): string => {
    if (node.type === 'MemberExpression') return `${route(node.object)}/${name(node.property)}`;
    if (node.type === 'CallExpression') {
      const path = route(node.callee);
      const argument = node.arguments[0];
      const parameter = argument?.type === 'ObjectExpression' ? argument.properties[0] : null;
      return path.includes('/v1/') && parameter?.type === 'Property' ? `${path}/{${name(parameter.key)}}` : path;
    }
    return name(node);
  };
  const pageOperations = new WeakMap<Node, string>();
  const pageOperation = (node: Node): string => {
    if (node.type !== 'CallExpression') return '';
    const cached = pageOperations.get(node);
    if (cached !== undefined) return cached;
    const parts = route(node.callee).split('/');
    const start = parts.indexOf('v1');
    if (start < 0 || !['get', 'post'].includes(parts.at(-1)!)) { pageOperations.set(node, ''); return ''; }
    const operation = `${parts.at(-1)!.toUpperCase()} /${parts.slice(start, -1).join('/')}`;
    const result = paged.has(operation) || node.arguments.some(argument => descendants(argument).some(child =>
      child.type === 'Property' && name(child.key) === 'limit')) ? operation : '';
    pageOperations.set(node, result);
    return result;
  };
  for (const unit of units) {
    const reads = new Set<string>();
    for (const node of unit.nodes) { const operation = pageOperation(node); if (operation) reads.add(operation); }
    if (reads.size || unit.nodes.some(node => node.type === 'MemberExpression' && name(node.property) === 'nextCursor')) {
      operations.set(key(unit), reads.size ? reads : new Set([unit.name]));
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of units) {
      const reads = operations.get(key(unit)) ?? new Set<string>();
      for (const node of unit.nodes) if (node.type === 'CallExpression') {
        for (const operation of operations.get(callKey(unit, node.callee)) ?? []) {
          if (!reads.has(operation)) { reads.add(operation); changed = true; }
        }
      }
      if (reads.size) operations.set(key(unit), reads);
    }
  }
  const result: PageSelection[] = [];
  const parameters = new Set<string>();
  const definitions = new Map(units.map(unit => [key(unit), unit]));
  const pageArgument = (unit: Unit, node: Node, seen = new Set<Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'Identifier') return parameters.has(`${key(unit)}:${node.name}`)
      || !!unit.variables.get(node.name) && pageArgument(unit, unit.variables.get(node.name)!, seen);
    if (node.type === 'MemberExpression') return name(node.property) === 'items'
      || ['data', 'result'].includes(name(node.property)) && pageArgument(unit, node.object, seen);
    if (node.type === 'CallExpression') return !!pageOperation(node) || operations.has(callKey(unit, node.callee))
      || node.callee.type === 'MemberExpression' && ['map', 'filter', 'slice'].includes(name(node.callee.property))
        && pageArgument(unit, node.callee.object, seen);
    return children(node).some(child => pageArgument(unit, child, seen));
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of units) for (const node of unit.nodes) if (node.type === 'CallExpression') {
      const target = definitions.get(callKey(unit, node.callee));
      const fn = target?.nodes[0];
      if (target && fn && 'params' in fn) node.arguments.forEach((argument, index) => {
        const parameter = `${key(target)}:${name(fn.params[index])}`;
        if (!parameters.has(parameter) && pageArgument(unit, argument)) { parameters.add(parameter); changed = true; }
      });
    }
  }
  const selectors = new Map<string, number>();
  for (const unit of units) {
    const fn = unit.nodes[0];
    if (fn && 'params' in fn) for (const node of unit.nodes) {
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && name(node.callee.property) === 'filter' && node.arguments[0]?.type === 'Identifier') {
        const index = fn.params.findIndex(parameter => name(parameter) === name(node.arguments[0]));
        if (index >= 0) selectors.set(key(unit), index);
      }
    }
  }
  // A helper may select a presentation channel only when every page-bearing
  // caller also returns the unchanged source envelope. This is checked against
  // the current call sites, so adding a caller which returns only the subset
  // removes the proof. Unknown references and indirect calls stay unproved.
  const callerRetains = (unit: Unit, input: Node): boolean => {
    const fn = unit.nodes[0];
    if (unknownImport || opaqueImports.has(unit.file.path)
      || input.type !== 'Identifier' || !fn || !('params' in fn)) return false;
    const index = fn.params.findIndex(parameter => name(parameter) === input.name);
    const flow = outputFlows.get(unit.file)!;
    if (index < 0 || !flow.readOnlyExport(unit.name, index)) return false;
    let found = false;
    for (const caller of units) for (const node of caller.nodes) {
      if (node.type !== 'Identifier' || callKey(caller, node) !== key(unit)) continue;
      const parent = parents.get(node);
      if (parent === fn || parent?.type === 'ImportSpecifier') continue;
      if (parent?.type !== 'CallExpression' || parent.callee !== node) return false;
      const argument = parent.arguments[index];
      if (!argument || !pageArgument(caller, argument)) return false;
      found = true;
      const callerFlow = outputFlows.get(caller.file)!;
      const envelope = callerFlow.envelope(argument);
      if (!envelope || !callerFlow.retains(envelope, argument)
        || !callerFlow.separate(argument, argument)) return false;
    }
    return found;
  };
  for (const unit of units) {
    const origin = (node: Node, seen = new Set<Node>()): Set<string> => {
      if (seen.has(node)) return new Set();
      seen.add(node);
      if (node.type === 'Identifier') {
        if (parameters.has(`${key(unit)}:${node.name}`)) return new Set([unit.name]);
        const value = unit.variables.get(node.name);
        if (value) return origin(value, seen);
        if (operations.has(callKey(unit, node))) return new Set([name(node)]);
      }
      if (node.type === 'MemberExpression') {
        const reads = origin(node.object, seen);
        // Page parameters remain guarded even when the adapter is elsewhere.
        if (!reads.size && name(node.property) === 'items' && operations.has(key(unit))) return new Set([unit.name]);
        return reads;
      }
      if (node.type === 'CallExpression') {
        const operation = pageOperation(node);
        if (operation) return new Set([operation]);
        const reads = operations.get(callKey(unit, node.callee));
        if (reads) return reads.size === 1 ? reads : new Set([name(node.callee)]);
        // Array adapters carry their receiver, not API reads inside map callbacks.
        if (node.callee.type === 'MemberExpression') return origin(node.callee.object, seen);
      }
      return new Set(children(node).flatMap(child => [...origin(child, seen)]));
    };
    const report = (input: Node, predicate: Node, selection: string) => {
      const flow = outputFlows.get(unit.file)!;
      const envelope = flow.envelope(input);
      if (selection === 'flatMap' && envelope && flow.projected(predicate) && flow.retains(envelope, input)
        && flow.separate(input, predicate)) return;
      if (callerRetains(unit, input)) return;
      // A small result is complete only when a preceding failure branch rejects
      // this same envelope's continuation. Removing that branch removes the proof.
      const items = descendants(input).find(node => node.type === 'MemberExpression' && name(node.property) === 'items');
      if (items?.type === 'MemberExpression') {
        const target = structure(items.object);
        const includesContinuation = (node: Node): boolean => node.type === 'LogicalExpression' && node.operator === '||'
          ? includesContinuation(node.left) || includesContinuation(node.right)
          : node.type === 'MemberExpression' && name(node.property) === 'nextCursor' && structure(node.object) === target;
        let block: Node | undefined = predicate;
        while (block && block.type !== 'BlockStatement') block = parents.get(block);
        if (block?.type === 'BlockStatement' && block.body.some(branch => branch.type === 'IfStatement'
          && branch.end < input.start && includesContinuation(branch.test)
          && !unit.nodes.some(node => node.start > branch.end && node.end < input.start
            && ['AssignmentExpression', 'UpdateExpression'].includes(node.type))
          && (branch.consequent.type === 'ReturnStatement' || branch.consequent.type === 'ThrowStatement'
            || branch.consequent.type === 'BlockStatement' && branch.consequent.body.length === 1
              && branch.consequent.body[0]?.type === 'ReturnStatement')
          && descendants(branch.consequent).some(node => node.type === 'ThrowStatement' || node.type === 'Property'
            && (name(node.key) === 'ok' && node.value.type === 'Literal' && node.value.value === false
              || name(node.key) === 'unavailable' && node.value.type === 'Literal' && node.value.value === true)))) return;
      }
      let text = unit.file.source.slice(predicate.start, predicate.end);
      const alias = predicate.type === 'Identifier' ? predicate
        : predicate.type === 'UnaryExpression' && predicate.argument.type === 'Identifier' ? predicate.argument : null;
      const value = alias && unit.variables.get(name(alias));
      if (value) text = `${predicate.type === 'UnaryExpression' ? predicate.operator : ''}(${unit.file.source.slice(value.start, value.end)})`;
      text = `(${unit.file.source.slice(input.start, input.end)})[${JSON.stringify(selection)}](${text})`;
      for (const operation of origin(input)) result.push({ path: unit.file.path, consumer: unit.name, operation, predicate: text });
    };
    for (const node of unit.nodes) {
      if (node.type === 'CallExpression') {
        const selector = selectors.get(callKey(unit, node.callee));
        if (selector !== undefined && node.arguments[0] && node.arguments[selector]) report(node.arguments[0], node.arguments[selector], 'selector');
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && ['filter', 'find', 'flatMap'].includes(name(node.callee.property)) && node.arguments[0]) {
        const predicate = node.arguments[0];
        // Flattening every row is projection, without a selection predicate.
        if (name(node.callee.property) === 'flatMap' && predicate.type === 'ArrowFunctionExpression'
          && !descendants(predicate.body).some(child => ['ConditionalExpression', 'IfStatement', 'LogicalExpression'].includes(child.type))) continue;
        report(node.callee.object, node.arguments[0], name(node.callee.property));
      }
      if (node.type === 'ForOfStatement') {
        const partition = nativePagePartition(node, parents);
        if (partition && !partition.preserved) report(node.right, partition.predicate, 'partition');
        if (node.right.type === 'CallExpression' && node.right.callee.type === 'MemberExpression'
          && name(node.right.callee.property) === 'slice' && node.right.callee.object.type === 'MemberExpression'
          && name(node.right.callee.object.property) === 'items') report(node.right.callee.object, node.right, 'slice');
        // Include imperative eligibility predicates, including join lookups assigned to aliases.
        const continuesThisLoop = (statement: Node): boolean => {
          if (statement.type !== 'ContinueStatement') return false;
          let target = parents.get(statement);
          while (target) {
            if (statement.label) {
              if (target.type === 'LabeledStatement' && name(target.label) === name(statement.label)) return target.body === node;
            } else if (['ForOfStatement', 'ForInStatement', 'ForStatement', 'WhileStatement', 'DoWhileStatement'].includes(target.type)) {
              return target === node;
            }
            target = parents.get(target);
          }
          return false;
        };
        for (const branch of descendants(node.body)) if (branch.type === 'IfStatement'
          && descendants(branch.consequent).some(continuesThisLoop)
          && owners.get(branch) === unit) report(node.right, branch.test, 'continue');
      }
    }
  }
  return result.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function newPageSelections(current: readonly PageSelection[], accepted: readonly PageSelection[]): PageSelection[] {
  const key = (item: PageSelection) => {
    const parsed = parseSync('predicate.ts', `const predicate = (${item.predicate});`);
    if (parsed.errors.length) throw new Error(`Invalid selection predicate: ${item.predicate}`);
    return JSON.stringify({ path: item.path, consumer: item.consumer, operation: item.operation, predicate: structure(parsed.program) });
  };
  const known = new Map<string, number>();
  for (const item of accepted) known.set(key(item), (known.get(key(item)) ?? 0) + 1);
  return current.filter(item => { const id = key(item); const count = known.get(id) ?? 0; known.set(id, count - 1); return count < 1; });
}
