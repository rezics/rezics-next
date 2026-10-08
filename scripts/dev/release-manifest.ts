import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

/** The checked-in release pins are independent of the mutable local image tag. */
export const releaseManifest = {
  schema: 'rezics-local-release-v1',
  formatVersion: 1,
  runtimes: { bun: '1.4.2', node: 'v26.8.2', yarn: '4.18.0' },
  applicationBase: 'oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895',
  images: {
    postgres: 'postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722',
    fuseki: 'rezics/fuseki:6.2.0-cmd0.5.39-21e361b84736',
    rustfs: 'rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff',
    toxiproxy: 'ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e',
    mailpit: 'axllent/mailpit:v1.31.2@sha256:74d609a42ec279aa63c6b4622a6fa9b5408d1ad5b1d76a1c4be40a265ce0863d',
  },
  fusekiModule: '0.5.39',
} as const;

export type ReleaseManifest = typeof releaseManifest;

export function releaseDigest(manifest: ReleaseManifest = releaseManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function assertReleasePins(manifest: ReleaseManifest = releaseManifest): void {
  const dockerfile = readFileSync(join(root, 'infra/release/Dockerfile'), 'utf8');
  if (!/^oven\/bun:[^@]+@sha256:[a-f0-9]{64}$/.test(manifest.applicationBase)
    || !dockerfile.includes(`ARG BUN_IMAGE=${manifest.applicationBase}\n`)) {
    throw new Error('Release application base differs from Dockerfile');
  }
  const compose = readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager?: string };
  if (packageJson.packageManager !== `yarn@${manifest.runtimes.yarn}`) {
    throw new Error('Release manifest Yarn pin differs from package.json');
  }
  const node = spawnSync('node', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const yarn = spawnSync('corepack', ['yarn', '--version'], { encoding: 'utf8', timeout: 5_000 });
  if (process.versions.bun !== manifest.runtimes.bun || node.error || node.status !== 0
    || node.stdout.trim() !== manifest.runtimes.node || yarn.error || yarn.status !== 0
    || yarn.stdout.trim() !== manifest.runtimes.yarn) {
    throw new Error('Release manifest runtime pin differs from the running toolchain');
  }
  for (const [service, image] of Object.entries(manifest.images)) {
    const actual = compose.match(new RegExp(`^  ${service}:\\n    image: (\\S+)$`, 'm'))?.[1];
    if (actual !== image) throw new Error(`Release manifest ${service} image differs from Compose`);
  }
  if (!manifest.images.fuseki.includes(`-cmd${manifest.fusekiModule}-`)) {
    throw new Error('Release manifest Fuseki module pin differs from image tag');
  }
}
