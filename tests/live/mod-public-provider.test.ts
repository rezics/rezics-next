import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { type ModCapture, solveModCaptures }
  from '../../services/main/src/modules/package/mod-profile.ts';
import recorded from '../qa/fixtures/mod-public-captures.json';

const captures = recorded.captures as Array<{ provider: string; identity: string; surface: string;
  url: string; capturedAt: string; status: number; bytesBase64: string; sha256: string }>;
const semanticCapture = (capture: typeof captures[number]): ModCapture => ({
  identity: capture.identity, surface: capture.surface,
  status: 'observed', bytesBase64: capture.bytesBase64, sha256: capture.sha256,
  sourceUrl: capture.url, httpStatus: capture.status,
});

test('PKG09: recorded and live Modrinth version surfaces retain project-level requirements', async () => {
  const versions = captures.filter(capture => capture.provider === 'modrinth');
  expect(versions).toHaveLength(2);
  for (const capture of versions) {
    const bytes = Buffer.from(capture.bytesBase64!, 'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(capture.sha256);
    const observed = JSON.parse(bytes.toString('utf8')) as { id: string; project_id: string;
      dependencies: Array<{ project_id: string | null; version_id: string | null;
        dependency_type: string }> };
    expect(observed.id).toBe(capture.identity);
    const response = await fetch(capture.url, {
      headers: { 'User-Agent': 'REZICS/0.1 (mod-profile-qa)' },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    const liveBytes = Buffer.from(await response.arrayBuffer());
    expect(liveBytes.length).toBeLessThanOrEqual(65_536);
    const live = JSON.parse(liveBytes.toString('utf8')) as typeof observed;
    expect(live.id).toBe(observed.id);
    expect(live.project_id).toBe(observed.project_id);
    expect(Array.isArray(live.dependencies)).toBe(true);
  }
  const outcome = solveModCaptures({ profile: 'mod-native-capture-v1',
    ecosystem: 'modrinth', side: 'CLIENT', root: 'YEWu6red',
    captures: versions.map(semanticCapture) });
  expect(outcome.selection).toBe('valid');
  expect(outcome.relations.some(edge => edge.kind === 'required' && edge.to === 'AANobbMI')).toBe(true);
  expect(outcome.independentDownloads).toEqual(['SMxNOGZ6', 'YEWu6red']);
});

test('PKG11: public Steam details do not prove a complete children surface', async () => {
  const capture = captures.find(item => item.provider === 'steam')!;
  const bytes = Buffer.from(capture.bytesBase64!, 'base64');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(capture.sha256);
  const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': capture.identity });
  const response = await fetch(capture.url, { method: 'POST', body,
    signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200);
  const liveBytes = Buffer.from(await response.arrayBuffer());
  expect(liveBytes.length).toBeLessThanOrEqual(65_536);
  const detail = (JSON.parse(liveBytes.toString('utf8')) as { response: {
    publishedfiledetails: Array<{ publishedfileid: string; result: number }> } })
    .response.publishedfiledetails[0]!;
  expect(detail.publishedfileid).toBe(capture.identity);
  expect(detail.result).toBe(1);
  const outcome = solveModCaptures({ profile: 'mod-native-capture-v1',
    ecosystem: 'steam', side: 'CLIENT', root: capture.identity,
    captures: [semanticCapture(capture), { identity: capture.identity,
      surface: 'ugc-children', status: 'inaccessible', bytesBase64: null, sha256: null,
      sourceUrl: capture.url, httpStatus: capture.status }] });
  expect(outcome.selection).toBe('incomplete-source-data');
  expect(outcome.coverage.map(surface => surface.status)).toEqual(['observed', 'inaccessible']);
  expect(outcome.relations).toEqual([]);
});

test('PKG09/PKG10: keyless CurseForge and Nexus metadata surfaces are inaccessible', async () => {
  const gaps = [
    { ecosystem: 'curseforge' as const, root: '238222/0', surface: 'file',
      url: 'https://api.curseforge.com/v1/mods/238222/files/0' },
    { ecosystem: 'nexus' as const, root: '1', surface: 'file-version-range',
      url: 'https://api.nexusmods.com/v3/mod-file-versions/1/dependencies/ranges' },
  ];
  for (const gap of gaps) {
    const response = await fetch(gap.url, { signal: AbortSignal.timeout(10_000) });
    expect([401, 403]).toContain(response.status);
    const outcome = solveModCaptures({ profile: 'mod-native-capture-v1',
      ecosystem: gap.ecosystem, side: 'CLIENT', root: gap.root,
      captures: [{ identity: gap.root, surface: gap.surface, status: 'inaccessible',
        bytesBase64: null, sha256: null, sourceUrl: gap.url, httpStatus: response.status }] });
    expect(outcome.selection).toBe('incomplete-source-data');
    expect(outcome.coverage[0]).toMatchObject({ sourceUrl: gap.url,
      httpStatus: response.status, status: 'inaccessible' });
    expect(outcome.relations).toEqual([]);
  }
});

const curseForgeKey = Bun.env.REZICS_CURSEFORGE_API_KEY;
(curseForgeKey ? test : test.skip)('PKG09: authenticated CurseForge file dependencies are captured from the provider', async () => {
  const url = 'https://api.curseforge.com/v1/mods/238222/files';
  const response = await fetch(url, { headers: { 'x-api-key': curseForgeKey!, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<{ id: number; modId: number;
    dependencies: Array<{ modId: number; relationType: number }> }> };
  expect(Array.isArray(body.data)).toBe(true);
  const file = body.data.find(item => Array.isArray(item.dependencies));
  expect(file).toBeDefined();
  const bytes = Buffer.from(JSON.stringify(file));
  const result = solveModCaptures({ profile: 'mod-native-capture-v1',
    ecosystem: 'curseforge', side: 'CLIENT', root: String(file!.id),
    captures: [{ identity: String(file!.id), surface: 'file', status: 'observed',
      bytesBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'), sourceUrl: url,
      httpStatus: response.status }] });
  expect(result.coverage[0]?.status).toBe('observed');
  expect(result.relations.length).toBe(file!.dependencies.length);
});

const nexusKey = Bun.env.REZICS_NEXUS_API_KEY;
(nexusKey ? test : test.skip)('PKG10: authenticated Nexus experimental range surface is observed', async () => {
  const base = 'https://api.nexusmods.com/v3';
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      headers: { apikey: nexusKey!, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    return response.json();
  };
  const mod = await get('/games/skyrimspecialedition/mods/12604') as { data: { id: string } };
  expect(typeof mod.data.id).toBe('string');
  const files = await get(`/mods/${encodeURIComponent(mod.data.id)}/files`) as { data: {
    mod_files: Array<{ id: string; versions_count: number }> } };
  const file = files.data.mod_files.find(item => item.versions_count > 0);
  expect(file).toBeDefined();
  const versions = await get(`/mod-files/${encodeURIComponent(file!.id)}/versions`) as { data: {
    versions: Array<{ id: string }> } };
  expect(versions.data.versions.length).toBeGreaterThan(0);
  const id = encodeURIComponent(versions.data.versions[0]!.id);
  const ranges = await get(`/mod-file-versions/${id}/dependencies/ranges`) as {
    dependency_definitions: unknown[] };
  expect(Array.isArray(ranges.dependency_definitions)).toBe(true);
});

const steamKey = Bun.env.REZICS_STEAM_WEB_API_KEY;
(steamKey ? test : test.skip)('PKG11: authenticated Steam QueryFiles returns a complete Collection children surface', async () => {
  const url = 'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/';
  const input = new URLSearchParams({ input_json: JSON.stringify({ query_type: 0,
    cursor: '*', numperpage: 5, appid: 255710, filetype: 1, return_children: true }) });
  const response = await fetch(url, { method: 'POST', body: input,
    headers: { 'x-webapi-key': steamKey! }, signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200);
  const data = await response.json() as { response: { publishedfiledetails: Array<{
    publishedfileid: string; file_type: number; num_children: number;
    children: Array<{ publishedfileid: string }> }> } };
  expect(Array.isArray(data.response.publishedfiledetails)).toBe(true);
  const collection = data.response.publishedfiledetails.find(item => item.file_type === 2);
  expect(collection).toBeDefined();
  expect(collection!.children).toHaveLength(collection!.num_children);
  const bytes = Buffer.from(JSON.stringify(collection));
  const outcome = solveModCaptures({ profile: 'mod-native-capture-v1',
    ecosystem: 'steam', side: 'CLIENT', root: collection!.publishedfileid,
    captures: [{ identity: collection!.publishedfileid, surface: 'ugc-children',
      status: 'observed', bytesBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'), sourceUrl: url,
      httpStatus: response.status }] });
  expect(outcome.selection).toBe('valid');
  expect(outcome.relations.every(edge => edge.kind === 'collection-member'
    && edge.strength === 'collection')).toBe(true);
});
