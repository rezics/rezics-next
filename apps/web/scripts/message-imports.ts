import { readdirSync } from 'node:fs';
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

function visit(node: Syntax, callback: (node: Syntax, parent?: Syntax) => void, parent?: Syntax): void {
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') visit(child, callback, node);
    } else if (value && typeof value === 'object' && 'type' in value) visit(value as Syntax, callback, node);
  }
}

/** Dev module runners cannot tree-shake the generated namespace's thousands of re-exports. */
export function messageImports(appRoot: string): Plugin {
  const entry = resolve(appRoot, 'src/paraglide/messages.js').replaceAll('\\', '/');
  const directory = resolve(appRoot, 'src/paraglide/messages');
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
            // A template selects a finite subset of the generated IDs; retain every possible substitution.
            const quasis = property.quasis as Syntax[];
            const parts = quasis.map((quasi) => (quasi.value as { cooked: string }).cooked);
            const expression = new RegExp(
              '^' + parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
            );
            for (const file of readdirSync(directory)) {
              if (file.endsWith('.js') && expression.test(file.slice(0, -3))) keys.add(file.slice(0, -3));
            }
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
        // Passing, enumerating or assigning the namespace retains normal module semantics, including shadows.
        if (unrestricted) continue;
        const names = [...keys];
        const declarations = names.map((name, index) => {
          const local = `__paraglide_${binding.local}_${index}`;
          return {
            name,
            local,
            import: `import { ${name} as ${local} } from ${JSON.stringify(`${binding.source}/${name}.js`)};`,
          };
        });
        edits.push({
          start: binding.node.start,
          end: binding.node.end,
          code:
            declarations.map((item) => item.import).join('\n') +
            `\nconst ${binding.local} = Object.freeze({${declarations.map((item) => `${item.name}: ${item.local}`).join(',')}});`,
        });
      }
      if (!edits.length) return;
      for (const edit of edits.sort((left, right) => right.start - left.start))
        code = code.slice(0, edit.start) + edit.code + code.slice(edit.end);
      return { code, map: null };
    },
  };
}
