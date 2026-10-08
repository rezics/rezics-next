// Union merges of composition roots can keep an older single-line import beside its updated form.
// Drop an import only when another supplies every name with the same type/value kind; report changes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { COMPOSITION_ROOTS } from './composition-roots.ts';

const pattern = /^import (type )?\{ ([^}]+) \} from '([^']+)';$/;
for (const file of COMPOSITION_ROOTS) {
  // A branch rebased onto main has every root. A fixture that predates one does not.
  if (!existsSync(file)) continue;
  // Union merges can place a branch's new import lines inside later code; hoist them to the header.
  const raw = readFileSync(file, 'utf8').split('\n');
  const firstCode = raw.findIndex(line => line.trim() && !line.startsWith('import ') && !line.startsWith('//')
    && !line.startsWith(' ') && !line.startsWith('}') && !/^(export )?type .* from /.test(line));
  const stray = firstCode < 0 ? [] : raw.slice(firstCode).filter(line => pattern.test(line));
  let lines = raw;
  if (stray.length) {
    const header = raw.slice(0, firstCode);
    const rest = raw.slice(firstCode).filter(line => !pattern.test(line));
    const lastImport = header.map(line => line.startsWith('import ')).lastIndexOf(true);
    lines = [...header.slice(0, lastImport + 1), ...stray, ...header.slice(lastImport + 1), ...rest];
    writeFileSync(file, lines.join('\n'));
    console.log(`${file}: hoisted ${stray.length} import(s)`);
  }
  const imports = lines.map((line, index) => ({ index, match: pattern.exec(line) })).filter(item => item.match);
  const names = (match: RegExpExecArray) => new Set(match[2]!.split(',').map(specifier => {
    const name = specifier.trim();
    // `type as Alias` imports a value named "type"; only the modifier consumes the first word.
    const inlineType = !match[1] && /^type\s+(?!as(?:\s|$))/.test(name);
    return `${match[1] || inlineType ? 'type' : 'value'}:${inlineType ? name.slice(5) : name}`;
  }));
  const drop = new Set<number>();
  for (const a of imports) {
    for (const b of imports) {
      if (a.index === b.index || drop.has(b.index) || a.match![3] !== b.match![3]) continue;
      const own = names(a.match!); const other = names(b.match!);
      if ([...own].every(name => other.has(name)) && (own.size < other.size || a.index > b.index)) drop.add(a.index);
    }
  }
  if (drop.size) {
    writeFileSync(file, lines.filter((_, index) => !drop.has(index)).join('\n'));
    console.log(`${file}: removed ${drop.size} duplicate import(s)`);
  }
}
