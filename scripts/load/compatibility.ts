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
