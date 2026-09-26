// Union merges of composition roots can keep an older single-line import beside its updated form.
// Drop an import whose names are all provided by another import of the same module; report changes.
import { readFileSync, writeFileSync } from 'node:fs';

const roots = ['services/main/src/app.ts', 'services/main/src/index.ts', 'services/main/src/routes/dependencies.ts'];
const pattern = /^import (type )?\{ ([^}]+) \} from '([^']+)';$/;
for (const file of roots) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const imports = lines.map((line, index) => ({ index, match: pattern.exec(line) })).filter(item => item.match);
  const names = (match: RegExpExecArray) => new Set(match[2]!.split(',').map(name => name.trim().replace(/^type /, '')));
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
