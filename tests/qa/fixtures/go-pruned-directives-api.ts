import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import type { Pool } from 'pg';
import type { GoMvsResolution }
  from '../../../services/main/src/modules/package/go-mvs.ts';
import { goPrunedMain, goPrunedSources, goSha }
  from './go-pruned-directives.ts';

export async function assertGoPrunedDirectivesApi(
  call: (method: string, path: string, token: string, body?: object, key?: string) => Promise<Response>,
  tokens: { capture: string; resolve: string; read: string; otherResolve: string; otherRead: string },
  pool: Pool,
) {
  const captures: string[] = [];
  for (const source of goPrunedSources) {
    const captured = await call('POST', '/v1/package-sources/go', tokens.capture, {
      profile: 'go-module-proxy-capture-v1', path: source.path, version: source.version });
    expect(captured.status).toBe(201);
    const result = await captured.json() as { capture: { capture: string;
      manifest: { parsed: { status: string } } } };
    captures.push(result.capture.capture.split('/').at(-1)!);
    if (source.path.startsWith('example.com/fork/')) {
      expect(result.capture.manifest.parsed.status).toBe('unsupported-syntax');
    }
  }
  const path = '/v1/package-resolutions/from-captures';
  const key = `go-pruned-directives-${randomUUID()}`;
  const body = { profile: 'go-mvs-from-main-pruned-directives-captures-v5',
    mainManifestBase64: Buffer.from(goPrunedMain).toString('base64'), captures };
  expect((await call('POST', path, tokens.read, body, key)).status).toBe(401);
  expect((await call('POST', path, tokens.otherResolve, body, key)).status).toBe(404);
  const created = await call('POST', path, tokens.resolve, body, key);
  expect(created.status).toBe(201);
  const saved = await created.json() as { resolution: GoMvsResolution; replayed: boolean };
  expect(saved.replayed).toBe(false);
  expect(saved.resolution.profile).toBe('go-mvs-captured-pruned-main-directives-resolution-v6');
  expect(saved.resolution.request.profile).toBe('go-mvs-captured-pruned-main-directives-v6');
  expect(saved.resolution.request.mainManifest).toEqual({ text: goPrunedMain, rawSha256: goSha(goPrunedMain) });
  expect(saved.resolution.outcome.status).toBe('solved');
  expect(saved.resolution.outcome.loadedManifestCount).toBe(5);
  const evidence = saved.resolution.outcome.selectedSourceEvidence!;
  expect(evidence).toHaveLength(6);
  const exact = evidence.find(item => item.original.path === 'example.com/a'
    && item.original.version === 'v1.0.0' && item.source.path === 'example.com/fork/exact'
    && item.source.version === 'v1.0.0');
  expect(exact?.expanded).toBe(true);
  expect(exact?.capture?.captureId).toBe(captures[1]!);
  expect(exact?.capture?.modSha256).toBe(goSha(goPrunedSources[1]!.text));
  expect(evidence.find(item => item.original.path === 'example.com/lazy/v2')).toEqual({
    original: { path: 'example.com/lazy/v2', version: 'v2.0.0' },
    source: { path: 'example.com/fork/lazy/v2', version: 'v2.1.0' }, expanded: false, capture: null,
  });
  expect(saved.resolution.request.releases.find(item => item.path === 'example.com/fork/exact'
    && item.version === 'v1.0.0')?.manifestText).toBe(goPrunedSources[1]!.text);
  expect((await call('POST', '/v1/package-resolutions', tokens.resolve,
    saved.resolution.request)).status).toBe(400);
  const id = saved.resolution.resolution.split('/').at(-1)!;
  expect((await pool.query('SELECT outcome FROM pkg.go_resolution WHERE id = $1', [id]))
    .rows[0].outcome).toEqual(saved.resolution.outcome);
  const readPath = `/v1/package-resolutions/${id}`;
  expect((await call('GET', readPath, tokens.resolve)).status).toBe(401);
  expect((await call('GET', readPath, tokens.otherRead)).status).toBe(404);
  expect(await (await call('GET', readPath, tokens.read)).json()).toEqual(saved.resolution);
  expect(await (await call('POST', path, tokens.resolve, body, key)).json())
    .toEqual({ ...saved, replayed: true });
  for (const changed of [{ ...body, captures: captures.slice(1) },
    { ...body, mainManifestBase64: Buffer.from(`${goPrunedMain}\n`).toString('base64') }]) {
    expect((await call('POST', path, tokens.resolve, changed, key)).status).toBe(409);
  }
  const missing = await call('POST', path, tokens.resolve,
    { ...body, captures: captures.filter((_, index) => index !== 1) });
  expect(missing.status).toBe(201);
  expect(await missing.json()).toMatchObject({ resolution: { outcome: {
    status: 'incomplete-source-data', buildList: [],
    missing: [{ path: 'example.com/fork/exact', version: 'v1.0.0' }] } } });
  const unsupported = await call('POST', path, tokens.resolve, { ...body,
    mainManifestBase64: Buffer.from(`${goPrunedMain}\ntoolchain go1.27.1\n`).toString('base64') });
  expect(unsupported.status).toBe(201);
  expect(await unsupported.json()).toMatchObject({ resolution: { outcome: {
    status: 'unsupported-semantics', buildList: [] } } });
  for (const [clause, code] of [
    ['replace example.com/a =>', 'go_resolution_malformed'],
    ['exclude example.com/excluded v1.0.0', 'go_resolution_duplicate'],
  ]) {
    const rejected = await call('POST', path, tokens.resolve, { ...body,
      mainManifestBase64: Buffer.from(`${goPrunedMain}\n${clause}\n`).toString('base64') });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code });
  }
  const wrongIdentity = await call('POST', path, tokens.resolve, { ...body,
    mainManifestBase64: Buffer.from(goPrunedMain.replace('example.com/fork/exact',
      'example.com/b')).toString('base64') });
  expect(wrongIdentity.status).toBe(422);
  await expect(pool.query('UPDATE pkg.go_resolution SET outcome = $2 WHERE id = $1',
    [id, '{}'])).rejects.toThrow();
  return { body, key, readPath };
}
