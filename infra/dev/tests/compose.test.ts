import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const compose = fileURLToPath(new URL('../compose.yaml', import.meta.url));
const qaCompose = fileURLToPath(new URL('../compose.qa.yaml', import.meta.url));
const assembler = fileURLToPath(new URL('../../jena/fuseki-text.ttl', import.meta.url));

function resolvedStack(qa = false) {
  const files = qa ? ['-f', compose, '-f', qaCompose] : ['-f', compose];
  const result = Bun.spawnSync(['docker', 'compose', ...files, 'config', '--format', 'json'], {
    env: {
      ...process.env,
      POSTGRES_PASSWORD: 'test-postgres',
      REZICS_ACCOUNT_PASSWORD: 'test-account',
      REZICS_ACCESS_PASSWORD: 'test-access',
      REZICS_CONTENT_PASSWORD: 'test-content',
      REZICS_RELAY_PASSWORD: 'test-relay',
      RUSTFS_ACCESS_KEY: 'test-rustfs',
      RUSTFS_SECRET_KEY: 'test-rustfs-secret',
    },
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

describe('P0.1 local stack contract', () => {
  test('OPS01 resolves pinned services and binds published ports to loopback', () => {
    const services = resolvedStack().services;
    expect(Object.keys(services).sort()).toEqual(['fuseki', 'mailpit', 'postgres', 'rustfs', 'toxiproxy']);
    for (const [name, service] of Object.entries<any>(services)) {
      expect(service.image, name).toMatch(/:[^@]+@sha256:[a-f0-9]{64}$|^rezics\/fuseki:6\.2\.0-base1$/);
      for (const port of service.ports ?? []) {
        expect(port.host_ip, `${name}:${port.published}`).toBe('127.0.0.1');
      }
    }
    expect(services.postgres.healthcheck).toBeDefined();
    expect(services.fuseki.healthcheck).toBeDefined();
    expect(services.rustfs.healthcheck).toBeDefined();
  });

  test('OPS14 OPS16 use one persistent text-wrapped TDB2 assembler', () => {
    const ttl = readFileSync(assembler, 'utf8');
    expect(ttl).toContain('fuseki:dataset <#text_dataset>');
    expect(ttl).toContain('text:dataset <#tdb_dataset>');
    expect(ttl).toContain('text:index <#text_index>');
    expect(ttl).toContain('tdb2:location "databases/rezics/tdb2"');
    expect(ttl).toContain('text:directory "databases/rezics/lucene"');
    expect(ttl.match(/org\.apache\.lucene\.analysis\.cjk\.CJKAnalyzer/g)).toHaveLength(2);
  });

  test('OPS01 QA services use disposable state without losing database initialization', () => {
    const services = resolvedStack(true).services;
    for (const [name, path] of [
      ['postgres', '/var/lib/postgresql'],
      ['fuseki', '/fuseki/databases'],
      ['rustfs', '/data'],
    ] as const) {
      expect(services[name].tmpfs.some((mount: string) => mount.startsWith(`${path}:`))).toBe(true);
      expect(services[name].volumes?.some((volume: { target: string }) => volume.target === path) ?? false).toBe(false);
    }
    expect(services.postgres.volumes.some((volume: { target: string }) =>
      volume.target === '/docker-entrypoint-initdb.d/00-owners.sh')).toBe(true);
  });
});
