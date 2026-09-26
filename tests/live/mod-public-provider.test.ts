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
