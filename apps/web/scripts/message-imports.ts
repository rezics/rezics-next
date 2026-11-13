import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

type Syntax = {
  type: string;
  start: number;
  end: number;
  name?: string;
  value?: unknown;
  [key: string]: unknown;
};

const MESSAGE_INDEX_EXPORT = /export\s+\*\s+from\s+['"]\.\/([^'"]+)['"]/g;
const MESSAGE_EXPORT_ALIAS = /^\s*export\s*\{\s*[\w$]+\s+as\s+("(?:\\.|[^"\\])*")\s*\}/gm;
const MESSAGE_EXPORT_BINDING = /^\s*export\s+(?:const|function|class)\s+([\w$]+)/gm;

function visit(node: Syntax, callback: (node: Syntax, parent?: Syntax) => void, parent?: Syntax): void {
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') visit(child, callback, node);
    } else if (value && typeof value === 'object' && 'type' in value) visit(value as Syntax, callback, node);
  }
}

/** Public Paraglide IDs are declared by leaf exports; generated filenames may be normalized or disambiguated. */
function generatedMessageExports(directory: string): Map<string, string> {
  const index = readFileSync(resolve(directory, '_index.js'), 'utf8');
  const exports = new Map<string, string>();
  MESSAGE_INDEX_EXPORT.lastIndex = 0;
  for (const match of index.matchAll(MESSAGE_INDEX_EXPORT)) {
    const module = match[1]!.endsWith('.js') ? match[1]! : `${match[1]}.js`;
    const source = readFileSync(resolve(directory, module), 'utf8');
    MESSAGE_EXPORT_ALIAS.lastIndex = 0;
    for (const alias of source.matchAll(MESSAGE_EXPORT_ALIAS)) {
      const name: unknown = JSON.parse(alias[1]!);
      if (typeof name !== 'string') throw new Error('Paraglide message export alias is not a string');
      exports.set(name, module);
    }
    MESSAGE_EXPORT_BINDING.lastIndex = 0;
    for (const binding of source.matchAll(MESSAGE_EXPORT_BINDING)) exports.set(binding[1]!, module);
  }
  return exports;
}

/** Dev module runners cannot tree-shake the generated namespace's thousands of re-exports. */
export function messageImports(appRoot: string): Plugin {
  const entry = resolve(appRoot, 'src/paraglide/messages.js').replaceAll('\\', '/');
  const directory = resolve(appRoot, 'src/paraglide/messages');
  let messageExports: Map<string, string> | undefined;
  const getMessageExports = () => (messageExports ??= generatedMessageExports(directory));

  return {
    name: 'paraglide-message-imports',
    apply: 'serve',
    enforce: 'post',
    transform(code, id) {
      if (!code.includes('paraglide/messages')) return;
      const imports: { node: Syntax; local: string; source: string }[] = [];
      const ast = this.parse(code) as unknown as Syntax;
      visit(ast, (node) => {
        if (node.type !== 'ImportDeclaration') return;
        const source = (node.source as Syntax).value;
        if (typeof source !== 'string' || !source.startsWith('.')) return;
        const target = resolve(dirname(id.split('?', 1)[0]!), source).replaceAll('\\', '/');
        if (target !== entry && target !== entry.slice(0, -3)) return;
        const specifiers = node.specifiers as Syntax[];
        if (specifiers.length !== 1) return;
        const specifier = specifiers[0]!;
        if (
          specifier.type !== 'ImportNamespaceSpecifier' &&
          !(specifier.type === 'ImportSpecifier' && (specifier.imported as Syntax).name === 'm')
        )
          return;
        imports.push({ node, local: (specifier.local as Syntax).name!, source: source.replace(/\.js$/, '') });
      });
      if (!imports.length) return;

      const edits: { start: number; end: number; code: string }[] = [];
      for (const binding of imports) {
        const covered = new Set<number>();
        const keys = new Set<string>();
        let unrestricted = false;
        visit(ast, (node) => {
          if (node.type !== 'MemberExpression') return;
          const object = node.object as Syntax;
          if (object.type !== 'Identifier' || object.name !== binding.local) return;
          const property = node.property as Syntax;
          if (!node.computed && property.type === 'Identifier') keys.add(property.name!);
          else if (property.type === 'Literal' && typeof property.value === 'string') keys.add(property.value);
          else if (property.type === 'TemplateLiteral') {
            // A template selects the finite public IDs matched by its literal portions.
            const quasis = property.quasis as Syntax[];
            const parts = quasis.map((quasi) => (quasi.value as { cooked: string }).cooked);
            const expression = new RegExp(
              '^' + parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
            );
            for (const name of getMessageExports().keys()) if (expression.test(name)) keys.add(name);
          } else unrestricted = true;
          covered.add(object.start);
        });
        visit(ast, (node, parent) => {
          if (node.type !== 'Identifier' || node.name !== binding.local) return;
          if (node.start >= binding.node.start && node.end <= binding.node.end) return;
          // `{ s: 'small', m: 'medium' }` and `density.m` name properties, not the imported binding.
          // A shorthand `{ m }` still passes the namespace and must retain every export.
          if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return;
          if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
          if (!covered.has(node.start)) unrestricted = true;
        });

        const publicExports = unrestricted ? undefined : getMessageExports();
        if (publicExports && [...keys].some((name) => !publicExports.has(name))) unrestricted = true;
        // Passing, enumerating, dynamically indexing or otherwise using the namespace keeps normal module semantics.
        if (unrestricted) continue;

        const byModule = new Map<string, { name: string; local: string }[]>();
        let index = 0;
        for (const name of keys) {
          const module = publicExports!.get(name)!;
          const local = `__paraglide_${binding.local}_${index++}`;
          const entries = byModule.get(module) ?? [];
          entries.push({ name, local });
          byModule.set(module, entries);
        }
        const importsByModule = [...byModule].map(
          ([module, entries]) =>
            `import { ${entries.map(({ name, local }) => `${JSON.stringify(name)} as ${local}`).join(', ')} } from ${JSON.stringify(`${binding.source}/${module.replace(/^\.\//, '')}`)};`,
        );
        const properties = [...byModule.values()].flat().map(({ name, local }) => `${JSON.stringify(name)}: ${local}`);
        edits.push({
          start: binding.node.start,
          end: binding.node.end,
          code: importsByModule.join('\n') + `\nconst ${binding.local} = Object.freeze({${properties.join(',')}});`,
        });
      }
      if (!edits.length) return;
      for (const edit of edits.sort((left, right) => right.start - left.start))
        code = code.slice(0, edit.start) + edit.code + code.slice(edit.end);
      return { code, map: null };
    },
  };
}
