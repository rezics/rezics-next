import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pinFiles = new Set(['infra/dev/compose.yaml', 'scripts/dev/release-manifest.ts', 'docs/development/toolchain.md']);

/** Only the generated fields take the train base. Authored edits still undergo a three-way merge. */
function withBasePins(file: string, text: string, canonical: string): string | undefined {
  if (file === 'infra/dev/compose.yaml') {
    const imageLine = (source: string) => {
      const lines = source.split('\n');
      const service = lines.indexOf('  fuseki:');
      if (service < 0) return;
      for (let index = service + 1; index < lines.length; index++) {
        if (/^  [a-z][a-z0-9_-]*:$/.test(lines[index]!)) return;
        if (/^    image:\s*\S+\s*$/.test(lines[index]!)) return { lines, index };
      }
    };
    const current = imageLine(text), base = imageLine(canonical);
    if (!current || !base) return;
    current.lines[current.index] = base.lines[base.index]!;
    return current.lines.join('\n');
  }
  const fields = file === 'scripts/dev/release-manifest.ts'
    ? [/^    fuseki: '[^']*',$/m, /^  fusekiModule: '[^']*',$/m]
    : [/^\| Compose \| `?rezics\/fuseki:[^|\r\n]+ \|$/m];
  for (const field of fields) {
    const base = field.exec(canonical)?.[0];
    if (!base || !field.test(text)) return;
    text = text.replace(field, () => base);
  }
  return text;
}

/** Resume a stopped landing only when all remaining conflicts can be resolved as generated pins. */
export function continueFusekiPinConflicts(worktree: string, trainBase: string, merging: boolean) {
  const run = (...args: string[]) => spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
  const conflicts = () => run('diff', '--name-only', '--diff-filter=U').stdout.trim().split('\n').filter(Boolean);
  const files = conflicts();
  if (!files.length) return;
  const parent = join(worktree, '.temp/goal');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, 'fuseki-merge-'));
  try {
    for (const file of files) {
      if (!pinFiles.has(file)) continue;
      const canonical = run('show', `${trainBase}:${file}`);
      if (canonical.status !== 0) continue;
      const stages = [1, 2, 3].map(stage => run('show', `:${stage}:${file}`));
      if (stages.some(stage => stage.status !== 0)) continue;
      const normalized = stages.map(stage => withBasePins(file, stage.stdout, canonical.stdout));
      if (normalized.some(source => source === undefined)) continue;
      const paths = normalized.map((source, index) => {
        const path = join(temporary, String(index));
        writeFileSync(path, source!);
        return path;
      });
      const merged = run('merge-file', '-p', paths[1]!, paths[0]!, paths[2]!);
      if (merged.status !== 0) continue;
      writeFileSync(join(worktree, file), merged.stdout);
      const added = run('add', '--', file);
      if (added.status !== 0) return;
    }
    if (conflicts().length) return;
    return run('-c', 'core.editor=true', merging ? 'merge' : 'rebase', '--continue');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
