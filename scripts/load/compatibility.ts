import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixed = [
  'generated/model/manifest.json',
  'infra/dev/compose.yaml',
  'infra/jena/fuseki-text.ttl',
  'infra/jena/fuseki-text-qa.ttl',
  'services/account/package.json',
  'services/account/src/auth.ts',
  'services/account/src/migrate.ts',
  'services/content/src/migrate.ts',
];
const migrationDirectories = [
  'services/account/migrations', 'services/content/migrations',
  'services/main/migrations/access', 'services/main/migrations/relay',
];

/** Physical load clones require the same owner schema, graph model and text engine configuration. */
export function loadCompatibility(root: string): { digest: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const paths = [...fixed, ...migrationDirectories.flatMap(directory =>
    readdirSync(join(root, directory)).filter(file => file.endsWith('.sql'))
      .map(file => `${directory}/${file}`))].sort();
  const overall = createHash('sha256');
  for (const path of paths) {
    const digest = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    files[path] = digest;
    overall.update(path).update('\0').update(digest).update('\n');
  }
  return { digest: overall.digest('hex'), files };
}

interface SourceIdentity { fingerprint: string; clean: boolean }
interface PreparedLoadRun {
  mode?: string; failure?: string; sourceStable?: boolean; works?: number;
  baselineDigest?: string; source?: Partial<SourceIdentity>;
  compatibility?: { digest?: string };
}

/** A code-only revision can consume physical owners only by explicit opt-in;
 * the caller must still verify the pinned engine and cloned cold/fresh cases. */
export function preparedLoadSourceMode(run: PreparedLoadRun, current: SourceIdentity,
  works: number, baselineDigest: string, compatibilityDigest: string,
  allowCompatibleSource: boolean): 'exact-source' | 'compatible-source' {
  if (run.mode !== 'prepare' || run.failure || run.sourceStable !== true
    || run.works !== works || run.baselineDigest !== baselineDigest
    || run.compatibility?.digest !== compatibilityDigest
    || !/^[0-9a-f]{64}$/.test(run.source?.fingerprint ?? '')) {
    throw new Error('stopped baseline provenance, compatibility or manifest digest differs');
  }
  if (run.source!.fingerprint === current.fingerprint) return 'exact-source';
  if (!allowCompatibleSource || run.source?.clean !== true || !current.clean) {
    throw new Error('stopped baseline application source differs; a clean compatible source requires opt-in');
  }
  return 'compatible-source';
}
