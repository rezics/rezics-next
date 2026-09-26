import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// The Fuseki image tag is derived from everything its build copies, so a changed
// command module, assembler or shape always gets a new tag. Rebuilding under an
// existing tag previously left stale images in use on this host.

export const fusekiDockerfile = 'infra/jena/Dockerfile';
export const composeFile = 'infra/dev/compose.yaml';

export function dockerfileCopySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^COPY\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const words = match[1]!.trim().split(/\s+/);
    if (words.some(word => word.startsWith('--from='))) continue;
    if (words.some(word => word.startsWith('['))) throw new Error('JSON-form COPY is not supported in the Fuseki Dockerfile');
    const paths = words.filter(word => !word.startsWith('--'));
    if (paths.length < 2) throw new Error(`Malformed COPY: ${line}`);
    sources.push(...paths.slice(0, -1).map(path => posix.normalize(path).replace(/\/$/, '')));
  }
  if (!sources.length) throw new Error('Fuseki Dockerfile copies no build inputs');
  return sources;
}

function files(root: string, path: string): string[] {
  const absolute = join(root, path);
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute).flatMap(name => files(root, posix.join(path, name)));
}

/** Build-context files the image depends on, relative to the repository root. */
export function fusekiBuildInputs(root: string): string[] {
  const sources = dockerfileCopySources(readFileSync(join(root, fusekiDockerfile), 'utf8'));
  return [...new Set([fusekiDockerfile, ...sources.flatMap(source => files(root, source))])].sort();
}

export function fusekiImageTag(root: string): string {
  const dockerfile = readFileSync(join(root, fusekiDockerfile), 'utf8');
  const jena = /^ARG FUSEKI_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1];
  const module = /<artifactId>fuseki-command<\/artifactId><version>(\d+\.\d+\.\d+)<\/version>/
    .exec(readFileSync(join(root, 'infra/jena/command-module/pom.xml'), 'utf8'))?.[1];
  if (!jena || !module) throw new Error('Cannot read the Fuseki or command-module version');
  const digest = createHash('sha256');
  for (const path of fusekiBuildInputs(root)) {
    digest.update(`${path}\0${createHash('sha256').update(readFileSync(join(root, path))).digest('hex')}\n`);
  }
  return `rezics/fuseki:${jena}-cmd${module}-${digest.digest('hex').slice(0, 12)}`;
}

/** Write the derived tag into the Compose topology, or report drift in check mode. */
export function stampFusekiImage(root: string, check: boolean): void {
  const path = join(root, composeFile);
  const lines = readFileSync(path, 'utf8').split('\n');
  // Locate the image line inside the fuseki service without validating its old
  // form, so a hand-written tag can still be replaced.
  const service = lines.indexOf('  fuseki:');
  const end = lines.findIndex((line, index) => index > service && /^  [a-z][a-z0-9_-]*:$/.test(line));
  const index = service < 0 ? -1 : lines.findIndex((line, index) => index > service
    && (end < 0 || index < end) && /^    image:\s*\S+\s*$/.test(line));
  if (index < 0) throw new Error('Cannot locate the Fuseki image line in Compose');
  const current = lines[index]!.replace(/^    image:\s*/, '').trim();
  const expected = fusekiImageTag(root);
  if (current === expected) return;
  if (check) throw new Error(`Generated artifact differs: ${composeFile} Fuseki image ${current}, expected ${expected}; run yarn gen`);
  lines[index] = `    image: ${expected}`;
  writeFileSync(path, lines.join('\n'));
}
