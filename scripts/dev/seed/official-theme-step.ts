import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { packageDigest } from '@rezics/zone-sdk';
import { SeedApiError } from './api.ts';
import { grantOfficialThemeSeed } from './operator.ts';
import { officialTheme, packagedZone, type OfficialRealmId } from './official-plan.ts';
import { seedKey } from './plan.ts';
import { refreshSeedTokens, stableId, type SeedState } from './state.ts';

const root = resolve(import.meta.dir, '../../..');
const packageRoot = join(root, 'apps/web/zones/official');
const id = (value: string) => value.slice(-36);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const packages = {
  fiction: ['header', 'hero', 'footer', 'module:ranking'],
  books: ['header', 'hero', 'footer', 'module:shelf', 'module:editorial-list', 'module:people'],
  mods: ['header', 'hero', 'footer', 'workCard', 'module:chip-nav', 'module:ranking',
    'module:shelf', 'module:editorial-list'],
  'ai-workshop': ['header', 'hero', 'footer', 'workCard', 'module:shelf', 'module:editorial-list'],
  games: ['hero', 'workCard', 'module:shelf', 'module:editorial-list'],
  software: ['hero', 'workCard', 'module:shelf', 'module:editorial-list'],
  'franchise-wiki': ['home', 'memberIndex', 'entity'],
} as const;
type Slug = keyof typeof packages;
export const officialPackageSlugs = Object.keys(packages) as Slug[];

/** The same source-byte digest that `task zones:digest` and the web package loader compute. */
export async function officialSourceDigest(slug: Slug, sourceRoot = packageRoot): Promise<string> {
  const directory = join(sourceRoot, slug);
  const paths = await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: directory, onlyFiles: true }));
  if (!paths.length) throw new Error(`No official package source for ${slug}`);
  const files = Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, await readFile(join(directory, path), 'utf8')] as const)));
  return packageDigest(files);
}

interface ManifestEntry { src?: string; file: string }
type Manifest = Record<string, ManifestEntry>;
type ThemeView = { revision: string | null; bundle: { packageDigest?: string } | null;
  activation: string | null; activationRevision: string | null; approvalExpiresAt: string | null;
  decision: 'approved' | 'rejected' | null; revoked: boolean; globallyDisabled: boolean };

export const themeNeedsRevision = (view: ThemeView, digest: string) =>
  view.bundle?.packageDigest !== digest;

/** The Access receipt key binds built bytes and the basis within the API's 128-byte limit. */
export const themeRevisionSeedKey = (slug: Slug, digest: string, revision: string | null, bundle: unknown) =>
  seedKey('theme-revision', sha(`${slug}:${digest}:${revision ?? 'first'}:${sha(JSON.stringify(bundle))}`));

export const themeNeedsActivation = (view: ThemeView, now: number) =>
  !view.activation || view.activationRevision !== view.revision || view.revoked
  || view.globallyDisabled || !view.approvalExpiresAt
  || Date.parse(view.approvalExpiresAt) <= now + 7 * 86_400_000;

/** A dev build's exact package entry and source chunks, with schema-local `assets/` aliases. */
export async function officialBuildBundle(slug: Slug, digest: string, zone: string, manifest: Manifest,
  chunk: (path: string) => Promise<Uint8Array> = path => readFile(join(root, 'apps/web/dist/server', path))) {
  const source = `zones/official/${slug}/`;
  const entries = Object.values(manifest).filter(entry => entry.src?.startsWith(source));
  const entry = entries.find(item => item.src === `${source}index.tsx`);
  if (!entry || !entries.length) throw new Error(`Web build has no official ${slug} package`);
  const files = await Promise.all(entries.map(async item => {
    const bytes = await chunk(item.file);
    return { path: `assets/${slug}/${basename(item.file)}`, digest: sha(bytes),
      gzipBytes: gzipSync(bytes).byteLength };
  }));
  if (new Set(files.map(file => file.path)).size !== files.length) {
    throw new Error(`Web build has duplicate ${slug} package chunk names`);
  }
  return { profile: 'first-party-bundle-v1' as const, hostZone: zone, packageDigest: digest,
    entry: `assets/${slug}/${basename(entry.file)}`, files, slots: [...packages[slug]],
    connectOrigins: [], imageOrigins: [], fontOrigins: [] };
}

async function firstPartyView(state: SeedState, theme: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await state.operatorSession!.api.get<ThemeView>(
        `/v1/themes/${id(theme)}/first-party`, state.operatorSession!.token);
    } catch (error) {
      if (error instanceof SeedApiError && error.status === 404) return null;
      if (!(error instanceof SeedApiError) || error.status !== 503 || attempt === 7) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw new Error(`Official theme ${theme} read retries exhausted`);
}

/** Dev fixture review uses a second account; each state transition still passes through Main. */
export async function seedOfficialThemes(state: SeedState,
  selected: readonly (OfficialRealmId | 'franchise-wiki')[] = state.createdRealms.map(realm => realm.id as OfficialRealmId)) {
  const operator = state.operatorSession, input = state.operatorInput;
  const reviewer = state.sessions.find(session => session.id === 'daniel');
  if (!operator || !input || !reviewer) {
    state.findings.add('Official theme approval: fixture operator or independent reviewer is unavailable');
    return;
  }
  let manifest: Manifest | null = null;
  for (const realmId of selected) {
    if (!packagedZone(realmId)) continue;
    await state.optional(`Official ${realmId} theme`, async () => {
      // Theme review performs several graph commands; start each Zone with a fresh operator assertion.
      operator.token = await operator.api.token(operator.cookie);
      operator.issuedAt = Date.now();
      const slug = realmId as Slug;
      const zone = `https://rezics.com/id/${stableId(`zone:${slug}`)}`;
      const theme = officialTheme(slug);
      await grantOfficialThemeSeed(input, theme, reviewer);
      const digest = await officialSourceDigest(slug);
      let view = await firstPartyView(state, theme);
      if (!view) {
        await operator.api.post('/v1/themes', { theme: id(theme), owner: input.actingSubject,
          hostZone: zone, actingSubject: input.actingSubject,
          idempotencyKey: seedKey('theme-create', slug) }, operator.token, seedKey('theme-create', slug));
        view = await firstPartyView(state, theme);
      }
      if (!view) throw new Error(`Official ${slug} theme was not created`);
      if (themeNeedsRevision(view, digest)) {
        if (!manifest) {
          execFileSync('task', ['web:build'], { cwd: root, stdio: 'inherit' });
          manifest = JSON.parse(await readFile(join(root, 'apps/web/dist/server/.vite/manifest.json'), 'utf8')) as Manifest;
        }
        if (await officialSourceDigest(slug) !== digest) throw new Error(`${slug} source changed during web build`);
        const bundle = await officialBuildBundle(slug, digest, zone, manifest);
        // A new client build can emit different chunks for unchanged package source.
        const key = themeRevisionSeedKey(slug, digest, view.revision, bundle);
        await operator.api.post(`/v1/themes/${id(theme)}/revisions`, {
          expectedRevision: view.revision, bundle, actingSubject: input.actingSubject,
          idempotencyKey: key }, operator.token, key);
        view = await firstPartyView(state, theme);
        if (!view?.revision) throw new Error(`Official ${slug} revision was not created`);
      }
      if (!view?.revision || !view.bundle) throw new Error(`Official ${slug} revision is unavailable`);
      if (view.decision === 'rejected') throw new Error(`Official ${slug} revision was rejected`);
      if (view.decision !== 'approved') {
        // This digest identifies local fixture evidence, never a production human review.
        const evidence = sha(JSON.stringify(view.bundle));
        const reviewKey = seedKey('theme-review', `${slug}:${view.revision.slice(-12)}`);
        const reviewerToken = await operator.api.token(reviewer.cookie);
        await operator.api.post(`/v1/themes/${id(theme)}/revisions/${id(view.revision)}/reviews`, {
          decision: 'approved', reviewEvidenceDigest: evidence,
          actingSubject: reviewer.actingSubject, idempotencyKey: reviewKey }, reviewerToken, reviewKey);
        view = await firstPartyView(state, theme);
      }
      if (!view?.revision || view.decision !== 'approved') {
        throw new Error(`Official ${slug} revision has no approval`);
      }
      if (themeNeedsActivation(view, Date.now())) {
        await refreshSeedTokens(state);
        const expiry = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
        expiry.setUTCDate(expiry.getUTCDate() + 89);
        const key = seedKey('theme-activation', `${slug}:${view.revision.slice(-12)}:${
          view.activation?.slice(-12) ?? 'initial'}:${expiry.toISOString().slice(0, 10)}`);
        await operator.api.post(`/v1/themes/${id(theme)}/first-party-activations`, {
          revision: view.revision, expectedActivation: view.activation,
          approvalExpiresAt: expiry.toISOString(),
          actingSubject: input.actingSubject, idempotencyKey: key }, operator.token, key);
      }
      const presentation = await state.api.getPublic<{ execution: { state: string; packageDigest?: string } }>(
        `/v1/zones/${id(zone)}/presentation`);
      if (presentation.execution.state !== 'package' || presentation.execution.packageDigest !== digest) {
        throw new Error(`Official ${slug} presentation is ${presentation.execution.state} at ${
          presentation.execution.packageDigest ?? 'no digest'}, expected ${digest}`);
      }
      console.log(`Official ${slug}: package ${digest} approved on the dev stack.`);
    });
  }
}
