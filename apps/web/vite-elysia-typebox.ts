import type { Plugin } from 'vite';

const typeLoader = /(?:^|\/)elysia\/dist\/type\/typebox-type\.(?:mjs|js)$/u;
const valueRequire = /(?:^|\/)elysia\/dist\/type\/typebox-value-require\.(?:mjs|js)$/u;

/** Replace the first top-level `{...}` block that starts at `marker`. */
export function replaceLeadingBlock(source: string, marker: string, replacement: string): string | null {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const brace = source.indexOf('{', start);
  if (brace === -1) return null;
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return `${source.slice(0, start)}${replacement}${source.slice(index + 1)}`;
    }
  }
  return null;
}

/** Elysia 2 lazy-loads TypeBox through `require`. Workerd has no Node module loader for `typebox/type`. */
export function transformElysiaTypeboxLoader(code: string, id: string): string | null {
  const file = id.split('?', 1)[0]!.replaceAll('\\', '/');
  if (typeLoader.test(file)) {
    const replaced = replaceLeadingBlock(
      code,
      'function resolveNamespaces()',
      `function resolveNamespaces() {
	return {
		type: typeboxType,
		system: typeboxSystemLite
	};
}`,
    );
    if (!replaced || replaced === code) return null;
    return `import * as typeboxType from "typebox/type";
import * as typeboxSystemLite from "./typebox-system-lite.mjs";
${replaced}`;
  }
  if (valueRequire.test(file)) {
    const replaced = replaceLeadingBlock(
      code,
      'const requireTypebox = () =>',
      'const requireTypebox = () => fromOps(typeboxValueOps);',
    );
    if (!replaced || replaced === code) return null;
    return `import * as typeboxValueOps from "./typebox-value-ops.mjs";
${replaced}`;
  }
  return null;
}

/** Statically bind TypeBox so the site Worker can load the installed client's Elysia schemas. */
export function elysiaWorkerdTypebox(): Plugin {
  return {
    name: 'elysia-workerd-typebox',
    enforce: 'pre',
    transform(code, id) {
      const transformed = transformElysiaTypeboxLoader(code, id);
      return transformed === null ? null : { code: transformed, map: null };
    },
  };
}
