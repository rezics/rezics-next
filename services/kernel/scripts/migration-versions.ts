import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const MIGRATION_HEADER_LIMIT_BYTES = 512;
const DBMATE_UP_MARKER = /^-- migrate:up(?:[ \t]+transaction:(?:true|false))?[ \t]*\r?$/m;
const kernelDirectory = resolve(import.meta.dir, '..');

function migrationUpMarkerProblem(file: string, directory: string): string | undefined {
  const descriptor = openSync(isAbsolute(file) ? file : resolve(directory, file), 'r');
  try {
    const size = fstatSync(descriptor).size;
    const bytesToRead = Math.min(size, MIGRATION_HEADER_LIMIT_BYTES);
    const header = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(descriptor, header, 0, bytesToRead, 0);
    let text = header.toString('utf8', 0, bytesRead);
    const exceedsHeaderLimit = size > MIGRATION_HEADER_LIMIT_BYTES;
    if (exceedsHeaderLimit) {
      const lastLineBreak = text.lastIndexOf('\n');
      text = lastLineBreak < 0 ? '' : text.slice(0, lastLineBreak + 1);
    }
    if (DBMATE_UP_MARKER.test(text)) return undefined;
    if (exceedsHeaderLimit) {
      return (
        `${file}: no dbmate up marker found within the first ${MIGRATION_HEADER_LIMIT_BYTES} bytes; ` +
        `move \`-- migrate:up\` into that header window or increase the scan bound`
      );
    }
    return `${file}: missing dbmate up marker; add \`-- migrate:up\` before the up SQL`;
  } finally {
    closeSync(descriptor);
  }
}

/** Refuse future or duplicate versions and migrations without a readable dbmate up marker. */
export function validateMigrationVersions(migrationFiles: string[], now: Date, directory = kernelDirectory): void {
  const latestAllowed = new Date(now.getTime() + 5 * 60 * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const versions = new Map<string, string[]>();
  const futureFiles: string[] = [];
  const migrationHeaderProblems: string[] = [];

  for (const file of migrationFiles) {
    const headerProblem = migrationUpMarkerProblem(file, directory);
    if (headerProblem) migrationHeaderProblems.push(headerProblem);

    const name = file.split(/[\\/]/).at(-1) ?? file;
    const version = name.match(/^(\d+)_/)?.[1];
    if (!version) continue;

    const files = versions.get(version) ?? [];
    files.push(file);
    versions.set(version, files);

    if (/^\d{14}$/.test(version) && version > latestAllowed) futureFiles.push(file);
  }

  const problems = [
    ...futureFiles.map((file) => `${file}: migration version is later than the current UTC time plus five minutes`),
    ...migrationHeaderProblems,
    ...Array.from(versions)
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `version ${version} is used by ${files.join(', ')}`),
  ];
  if (problems.length) {
    throw new Error(
      `Migration version check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n` +
        'Name migrations with `date -u +%Y%m%d%H%M%S`.',
    );
  }
}

/** Run the shared check against only the selected checkout's Kernel migration tree. */
export function validateKernelMigrationVersions(kernelDirectory: string, now: Date): void {
  const migrationFiles = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: kernelDirectory }));
  validateMigrationVersions(migrationFiles, now, kernelDirectory);
}
