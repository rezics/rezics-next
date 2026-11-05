/** Real local-stack acceptance. Run through scripts/worker-check.ts on a check host. */
import assert from 'node:assert/strict';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { CrossMediaSeedReport } from '../../services/importer/src/cross-media-seed.ts';
import type { DevelopmentShowcaseReport } from './cross-media-seed.ts';
import { createPublicBulkClient } from '../../services/importer/src/public-bulk-client.ts';

const root = resolve(import.meta.dir, '../..');
const evidence = resolve(root, '.temp/imports-native-evidence');
const privateLogs = resolve(root, '.temp/local-stack/journey');
function availablePort(): number {
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = listener.port!;
  listener.stop(true);
  return port;
}
const web = `http://127.0.0.1:${availablePort()}`;
const api = `http://127.0.0.1:${availablePort()}`;
const issuer = `http://127.0.0.1:${availablePort()}`;
const env = {
  ...process.env,
  KERNEL_DATABASE_CONTAINER: `rezics-imports-${process.pid}-db`,
  KERNEL_DATABASE_VOLUME: `rezics-imports-${process.pid}-db`,
  KERNEL_SEARCH_CONTAINER: `rezics-imports-${process.pid}-search`,
  KERNEL_SEARCH_VOLUME: `rezics-imports-${process.pid}-search`,
  KERNEL_DATABASE_PORT: String(availablePort()),
  KERNEL_SEARCH_PORT: String(availablePort()),
  REZICS_LOCAL_STACK_WEB_ORIGIN: web,
  REZICS_LOCAL_STACK_KERNEL_ORIGIN: api,
  REZICS_LOCAL_STACK_ISSUER_ORIGIN: issuer,
  REZICS_LOCAL_STACK_NATIVE_ORIGIN: `http://127.0.0.1:${availablePort()}`,
};

function redactLog(value: string): string {
  return value.replace(/^Password: .*$/gm, 'Password: [redacted]');
}

async function command(name: string, argv: string[]): Promise<number> {
  const logPath = resolve(privateLogs, `${name}.log`);
  const descriptor = openSync(logPath, 'a', 0o600);
  let code: number;
  try {
    const child = Bun.spawn(argv, { cwd: root, env, stdout: descriptor, stderr: descriptor });
    code = await child.exited;
  } finally {
    closeSync(descriptor);
  }
  console.log(`${name}: exit ${code}`);
  if (code) {
    // Persona provisioning prints a password. Its output always remains private.
    if (name !== 'persona') console.error(redactLog(await readFile(logPath, 'utf8')).slice(-16000));
  }
  return code;
}

async function ready(url: string, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 180_000;
  let lastResponse = 'No HTTP response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Stack exited ${child.exitCode} before ${url}`);
    // Cold app startup is an external availability boundary.
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    if (response?.ok) return;
    if (response) lastResponse = `HTTP ${response.status}: ${(await response.text()).slice(0, 4000)}`;
    await Bun.sleep(500);
  }
  throw new Error(`Stack readiness deadline: ${url}; ${lastResponse}`);
}

type SeedReport = CrossMediaSeedReport & { developmentShowcase: DevelopmentShowcaseReport };
async function report(): Promise<SeedReport> {
  return JSON.parse(await readFile(resolve(root, '.temp/cross-media-seed/result.json'), 'utf8'));
}

async function observe(result: SeedReport) {
  const publicClient = createPublicBulkClient({ origin: api });
  const { chromium } = createRequire(resolve(root, 'apps/web/package.json'))('playwright');
  const sharp = createRequire(resolve(root, 'services/kernel/package.json'))('sharp');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const visits: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const [provider, sourceKey] of [['vndb', 'v2002'], ['bangumi', '10380'], ['bangumi', '84148']] as const) {
      const reading = result.readings.find((row) => row.source === provider && row.externalId === sourceKey);
      assert(reading, `Missing selected ${provider}:${sourceKey}`);
      const current = await publicClient.readSubject(reading.subject.subject.id);
      await writeFile(resolve(evidence, `${provider}-${sourceKey}.json`), JSON.stringify(current, null, 2));
      const publication = result.showcase?.published.find((row) => row.subjectId === current.subject.id);
      assert(publication?.assertions.length, `No current published assertions for ${provider}:${sourceKey}`);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      const response = await page.goto(new URL(reading.route, web).href, { waitUntil: 'networkidle' });
      const text = await page.locator('body').innerText();
      const images = await page.locator('img').evaluateAll((elements: HTMLImageElement[]) =>
        elements.map((image) => ({ src: image.currentSrc, alt: image.alt, width: image.naturalWidth })),
      );
      await page.screenshot({ path: resolve(evidence, `${provider}-${sourceKey}.png`), fullPage: true });
      await writeFile(resolve(evidence, `${provider}-${sourceKey}.txt`), text);
      if (response?.status() !== 200 || text.length < 100 || errors.length)
        failures.push(`${provider}:${sourceKey} page: HTTP ${response?.status()}, ${errors.join('; ')}`);
      const cover = current.summary?.cover;
      const decoded: unknown[] = [];
      if (cover && 'variants' in cover) {
        assert.equal(cover.variants.some((variant) => variant.format === 'avif'), true);
        assert.equal(cover.variants.some((variant) => variant.format === 'webp'), true);
        assert(images.some((image: { src: string; width: number }) => image.src.includes(cover.media) && image.width > 0),
          `Mounted page did not decode selected cover ${cover.media}`);
        for (const format of ['avif', 'webp']) {
          const variant = cover.variants.find((item) => item.format === format)!;
          const authorization = await fetch(`${api}/v1/media/${cover.media}:authorizeDownload?variant=${format}-${variant.width}`);
          assert.equal(authorization.status, 200);
          const decision = await authorization.json();
          await writeFile(resolve(evidence, `${provider}-${sourceKey}-${format}-decision.json`), JSON.stringify(decision));
          // Decode the actual website response selected by its mounted cover component.
          const source = images.find((image: { src: string }) => image.src.includes(cover.media))!.src;
          const served = await context.request.get(source.replace(/(avif|webp)(?=[-./?&]|$)/, format));
          assert.equal(served.status(), 200);
          const bytes = await served.body();
          const metadata = await sharp(bytes).metadata();
          assert(metadata.width && metadata.height);
          assert.equal(metadata.format, format === 'avif' ? 'heif' : format);
          decoded.push({ format, width: metadata.width, height: metadata.height, bytes: bytes.length });
        }
      } else if (provider === 'bangumi') failures.push(`${provider}:${sourceKey}: selected cover missing`);
      visits.push({ provider, sourceKey, subjectId: current.subject.id, url: page.url(), title: await page.title(), images, decoded });
      await page.close();
    }
  } finally {
    await writeFile(resolve(evidence, 'visits.json'), JSON.stringify({ visits, failures }, null, 2));
    await browser.close();
  }
  assert.deepEqual(failures, []);
}

await mkdir(evidence, { recursive: true, mode: 0o700 });
await mkdir(privateLogs, { recursive: true, mode: 0o700 });
assert.equal(await command('database', ['bun', 'run', '--cwd', 'services/kernel', 'db', 'up']), 0);
assert.equal(await command('search', ['bun', 'run', '--cwd', 'services/kernel', 'search', 'up']), 0);
const kernelEnvironmentFile = resolve(root, 'services/kernel/.env');
await writeFile(kernelEnvironmentFile, (await readFile(kernelEnvironmentFile, 'utf8'))
  .replace(/^AUTH_ISSUER=.*$/m, `AUTH_ISSUER=${issuer}`)
  .replace(/^AUTH_JWKS_URL=.*$/m, `AUTH_JWKS_URL=${issuer}/.well-known/jwks.json`), { mode: 0o600 });
assert.equal(await command('setup', ['bun', 'services/auth/scripts/dev-stack.ts', 'setup']), 0);
assert.equal(await command('persona', ['bun', 'services/auth/scripts/dev-stack.ts', 'persona']), 0);
const stackLog = resolve(privateLogs, 'stack.log');
const stackDescriptor = openSync(stackLog, 'a', 0o600);
const stack = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'start'], {
  cwd: root, env, stdout: stackDescriptor, stderr: stackDescriptor,
});
try {
  await ready(`${issuer}/.well-known/openid-configuration`, stack);
  await ready(web, stack);
  const seedCommand = ['bun', '--env-file=.temp/local-stack/seed.env', 'scripts/datasets/cross-media-seed.ts', '--dev'];
  const firstCode = await command('seed', seedCommand);
  const first = await report();
  await writeFile(resolve(evidence, 'first.json'), JSON.stringify(first, null, 2));
  await observe(first);
  const reopenCode = await command('reopen', seedCommand);
  const reopened = await report();
  await writeFile(resolve(evidence, 'reopened.json'), JSON.stringify(reopened, null, 2));
  assert.deepEqual(reopened.readings.map(({ source, externalId, subject }) => [source, externalId, subject.subject.id]),
    first.readings.map(({ source, externalId, subject }) => [source, externalId, subject.subject.id]));
  assert.deepEqual(reopened.mediaOutcomes.map(({ externalId, mediaId }) => [externalId, mediaId]),
    first.mediaOutcomes.map(({ externalId, mediaId }) => [externalId, mediaId]));
  await observe(reopened);
  assert.equal(firstCode, 0, 'Fresh seed did not complete');
  assert.equal(reopenCode, 0, 'Reopened seed did not complete');
  assert.equal(reopened.developmentShowcase.state, 'complete');
} finally {
  stack.kill('SIGTERM');
  await stack.exited;
  closeSync(stackDescriptor);
  // Only this attempt's application children are stopped. Runner custody owns its infrastructure.
  await writeFile(resolve(evidence, 'stack.log'), redactLog(await readFile(stackLog, 'utf8')));
}
