/** Refuse future or duplicate migration versions before they can be applied. */
export function validateMigrationVersions(migrationFiles: string[], now: Date): void {
  const latestAllowed = new Date(now.getTime() + 5 * 60 * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const versions = new Map<string, string[]>();
  const futureFiles: string[] = [];

  for (const file of migrationFiles) {
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
  const migrationFiles = Array.from(
    new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: kernelDirectory }),
  );
  validateMigrationVersions(migrationFiles, now);
}
