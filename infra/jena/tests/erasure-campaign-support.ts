import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dir, '../../..');
export const revision = (number: number) =>
  `urn:rezics:content:revision:00000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}`;
export const rows = `${revision(1)}\t12\n${revision(2)}\t99\n`;
export function campaignFixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const base = mkdtempSync(join(root, '.temp/erasure-campaign-'));
  const state = join(base, 'databases/rezics');
  const bin = join(base, 'bin');
  const candidateBase = join(base, 'databases/candidate');
  const candidate = join(candidateBase, 'databases/rezics');
  const record = join(base, 'databases/erasure-retirement-maintenance');
  const retired = join(base, 'databases/rezics-retired-maintenance');
  const marker = join(base, 'databases/purge.incomplete');
  const campaign = join(base, 'campaign.tsv');
  for (const dir of ['tdb2/Data-0001', 'lucene']) mkdirSync(join(state, dir), { recursive: true });
  for (const dir of ['bin', 'extra', 'profiles']) mkdirSync(join(base, dir));
  writeFileSync(
    join(state, 'tdb2/Data-0001/quads'),
    'private erased payload and unrelated model/command/object custody',
  );
  writeFileSync(join(state, 'lucene/segments_1'), 'old text');
  writeFileSync(join(state, 'clean-stop'), '');
  writeFileSync(join(base, 'extra/fuseki-command.jar'), 'qualified module');
  writeFileSync(join(base, 'profiles/model.ttl'), 'exact model custody');
  writeFileSync(join(base, 'assembler.ttl'), 'assembler');
  writeFileSync(campaign, rows);
  const executable = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  executable('sync', ':');
  executable(
    'java',
    `printf '%s\\n' "$*" >> "$TEST_BASE/java-calls"
case "$*" in
  *com.rezics.jena.ErasurePurge*)
    while [ "$1" != com.rezics.jena.ErasurePurge ]; do shift; done
    shift
    [ "$3" = --campaign ]
    printf 'retained unrelated bytes' > "$2/quads"
    # A real read-only Jena open can create a lock file.
    printf 'new lock' > "$1/tdb.lock" ;;
  *com.rezics.jena.ErasureTextIndexer*)
    printf 'new text' > "$FUSEKI_BASE/databases/rezics/lucene/segments_1" ;;
  *) exit 1 ;;
esac`,
  );
  executable('compact', 'printf "compact\\n" >> "$TEST_BASE/compact-calls"');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TEST_BASE: base,
    FUSEKI_BASE: base,
    FUSEKI_COMMAND_JAR: join(base, 'extra/fuseki-command.jar'),
    ERASURE_ASSEMBLER: join(base, 'assembler.ttl'),
    ERASURE_COMPACTOR: join(bin, 'compact'),
  };
  const run = (name: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('sh', [join(root, `infra/jena/${name}.sh`), ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 10_000,
    });
  const build = () => run('purge-tdb2', [candidateBase, '--campaign', campaign]);
  const verify = () =>
    writeFileSync(
      join(candidate, 'erasure-purge.verified'),
      readFileSync(join(candidate, 'erasure-purge.ready')),
    );
  const act = (mode: 'activate' | 'destroy' | 'rollback') =>
    run('purge-activate', [
      mode,
      mode === 'activate' ? candidateBase : 'maintenance',
      '--campaign',
      campaign,
      'maintenance',
    ]);
  return {
    base,
    bin,
    state,
    candidateBase,
    candidate,
    record,
    retired,
    marker,
    campaign,
    env,
    executable,
    run,
    build,
    verify,
    act,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    exists: (path: string) => existsSync(path),
  };
}
