import { expect, test } from 'bun:test';
import { Glob } from 'bun';

const kernel = new URL('../', import.meta.url).pathname;
const reads = [
  /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g,
  /\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /\(\s*env\s*,\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
];

/** The environment variables kernel source reads, by name. */
async function variablesRead(): Promise<string[]> {
  const names = new Set<string>();
  for await (const file of new Glob('src/**/*.ts').scan(kernel)) {
    const text = await Bun.file(`${kernel}${file}`).text();
    for (const pattern of reads) for (const match of text.matchAll(pattern)) names.add(match[1]!);
  }
  return [...names].sort();
}

test('the README documents every environment variable the kernel reads', async () => {
  const names = await variablesRead();
  expect(names).toEqual(
    expect.arrayContaining([
      'AUTH_AUDIENCE',
      'AUTH_ISSUER',
      'AUTH_JWKS_URL',
      'DATABASE_URL',
      'KERNEL_HOSTNAME',
      'KERNEL_PORT',
      'KERNEL_ROUTE_KEY',
      'KERNEL_SESSION_KEYS',
    ]),
  );
  const readme = await Bun.file(`${kernel}README.md`).text();
  expect(names.filter((name) => !readme.includes(`\`${name}\``))).toEqual([]);
});
