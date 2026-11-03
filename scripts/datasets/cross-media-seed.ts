import { runCrossMediaSeedCli } from '../../services/importer/src/cross-media-seed.ts';

if (import.meta.main) {
  try {
    await runCrossMediaSeedCli(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cross-media seed failed'}\n`);
    process.exitCode = 1;
  }
}
