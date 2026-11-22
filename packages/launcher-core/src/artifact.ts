import { minecraftLoaderNames, type MinecraftLoader, type OverlayPanel } from '@rezics/launcher-contract';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse as parseToml } from 'smol-toml';
import * as v from 'valibot';
import { readZipEntry, withZipFile } from './zip-read.ts';

export type ArtifactFingerprint = { size: number; digest: string; algorithm: 'sha256' | 'sha512' };
export type Artifact = ArtifactFingerprint & { url: string; sha1?: string };
export const maxArtifactSize = 2_147_483_648;

export async function hashArtifactFile(
  path: string,
  expected: number,
  algorithm: ArtifactFingerprint['algorithm'] | 'sha1',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes = 0;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expected) return undefined;
    const hash = createHash(algorithm);
    for await (const chunk of handle.createReadStream()) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > expected) return undefined;
      hash.update(chunk);
    }
    return bytes === expected ? hash.digest('hex') : undefined;
  } finally {
    await handle.close();
  }
}

function checkedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('The package has an unsupported download URL.');
  }
  return url;
}

export async function downloadArtifact(
  fetcher: typeof fetch,
  artifact: Artifact,
  target: string,
  cancellation?: AbortSignal,
  onTransfer?: (phase: 'downloading' | 'verifying', bytes: number) => void,
) {
  if (
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > maxArtifactSize ||
    !new RegExp(artifact.algorithm === 'sha256' ? '^[a-f0-9]{64}$' : '^[a-f0-9]{128}$', 'i').test(artifact.digest) ||
    (artifact.sha1 !== undefined && !/^[a-f0-9]{40}$/iu.test(artifact.sha1))
  ) {
    throw new Error('The package has invalid artifact metadata.');
  }

  let url = checkedUrl(artifact.url);
  const expectedSha1 = artifact.sha1?.toLowerCase();
  const timeout = AbortSignal.timeout(300_000);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  for (let hop = 0; hop < 6; hop++) {
    signal.throwIfAborted();
    const response = await fetcher(url, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error('The download source returned an invalid redirect.');
      url = checkedUrl(new URL(next, url).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Artifact download failed (${response.status}).`);
    }
    const digest = createHash(artifact.algorithm);
    const sha1 = expectedSha1 ? createHash('sha1') : undefined;
    let size = 0;
    let lastReport = -Infinity;
    const check = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > artifact.size) return callback(new Error('The artifact is larger than the published size.'));
        digest.update(chunk);
        sha1?.update(chunk);
        if (onTransfer) {
          const now = performance.now();
          if (now - lastReport >= 125) {
            lastReport = now;
            onTransfer('downloading', size);
          }
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(response.body),
      check,
      createWriteStream(target, { flags: 'wx', mode: 0o600, flush: true }),
      { signal },
    );
    onTransfer?.('verifying', size);
    if (size !== artifact.size || digest.digest('hex') !== artifact.digest.toLowerCase()) {
      throw new Error('The artifact does not match the published size and digest.');
    }
    if (sha1 && sha1.digest('hex') !== expectedSha1) {
      throw new Error('The artifact does not match the published SHA-1 digest.');
    }
    return;
  }
  throw new Error('The artifact download redirected too many times.');
}

const panelContent = {
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(400)),
  destination: v.optional(v.picklist(['info', 'guide', 'community'])),
};
const panel = v.strictObject({ schemaVersion: v.literal(1), ...panelContent });
const installedPanel = v.object(panelContent);

export function overlayPanelDigest(panel: OverlayPanel) {
  return createHash('sha256').update(JSON.stringify(panel)).digest('hex');
}

export function installedOverlayPanel(id: string, value: unknown, digest?: string): OverlayPanel | undefined {
  const parsed = v.safeParse(installedPanel, value);
  if (!parsed.success) return;
  const { title, text, destination } = parsed.output;
  const panel = { id, title, text, ...(destination && { destination }) };
  if (digest !== undefined && overlayPanelDigest(panel) !== digest) return;
  return panel;
}

export async function readOverlayPanel(id: string, file: string): Promise<OverlayPanel> {
  const data = v.parse(panel, JSON.parse(await readFile(file, 'utf8')));
  return { id, title: data.title, text: data.text, ...(data.destination && { destination: data.destination }) };
}

const modManifestPaths = {
  fabric: 'fabric.mod.json',
  forge: 'META-INF/mods.toml',
  neoforge: 'META-INF/neoforge.mods.toml',
} as const;
const javaManifestPath = 'META-INF/MANIFEST.MF';
const manifestLimit = 262_144;
const displayText = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const fabricMod = v.object({
  id: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{1,63}$/)),
  version: displayText,
  name: v.optional(displayText),
});
const forgeModEntry = v.object({
  modId: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{1,63}$/)),
  version: v.optional(displayText),
  displayName: v.optional(displayText),
});
const forgeMods = v.pipe(v.tupleWithRest([forgeModEntry], forgeModEntry), v.maxLength(128));

type ModMetadata = { id: string; ids: string[]; title: string; version: string };

function javaImplementationVersion(manifest: string | undefined): string {
  if (!manifest) return '0.0NONE';
  const main = manifest.replace(/\r\n?/g, '\n').split('\n\n', 1)[0]?.replace(/\n /g, '');
  return /^Implementation-Version: (.{1,128})$/im.exec(main ?? '')?.[1] ?? '0.0NONE';
}

export async function readMinecraftMod(
  file: string,
  loader: Exclude<MinecraftLoader, 'vanilla'>,
): Promise<ModMetadata> {
  const manifestPath = modManifestPaths[loader];
  const loaderName = minecraftLoaderNames[loader];
  return withZipFile(file, async (zip) => {
    if (zip.entryCount > 100_000) throw new Error('The mod JAR contains too many archive entries.');
    const manifests = new Map<string, string>();
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== manifestPath && (loader === 'fabric' || entry.fileName !== javaManifestPath)) continue;
      if (manifests.has(entry.fileName)) throw new Error('The mod JAR contains duplicate manifests.');
      if (entry.uncompressedSize > manifestLimit || entry.compressedSize > manifestLimit * 2) {
        throw new Error('The mod manifest is too large.');
      }
      manifests.set(entry.fileName, (await readZipEntry(zip, entry, manifestLimit)).toString('utf8'));
    }

    const manifest = manifests.get(manifestPath);
    if (manifest === undefined) throw new Error(`The JAR does not contain a ${loaderName} mod manifest.`);
    try {
      if (loader === 'fabric') {
        const data = v.parse(fabricMod, JSON.parse(manifest));
        return { id: data.id, ids: [data.id], title: data.name ?? data.id, version: data.version };
      }
      const data = parseToml(manifest, { maxDepth: 24 });
      if (loader === 'forge') v.parse(v.object({ modLoader: displayText, loaderVersion: displayText }), data);
      const entries = v.parse(forgeMods, data.mods);
      const ids = entries.map(({ modId }) => modId);
      if (new Set(ids).size !== ids.length) throw new Error('The manifest lists a mod twice.');
      const [first] = entries;
      const version = (first.version ?? '1').replaceAll(
        '${file.jarVersion}',
        javaImplementationVersion(manifests.get(javaManifestPath)),
      );
      return { id: first.modId, ids, title: first.displayName ?? first.modId, version: v.parse(displayText, version) };
    } catch {
      throw new Error(`The JAR contains an invalid ${loaderName} mod manifest.`);
    }
  });
}
