import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchGoProxyCapture } from
  '../../services/main/src/modules/package/go-proxy-capture.ts';

const path = 'golang.org/x/sync';
const version = 'v0.1.0';
const captured = await fetchGoProxyCapture({
  profile: 'go-module-proxy-capture-v1', path, version });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const list = captured.list.toString('utf8').split('\n').filter(Boolean);
const stableVersions = list.filter(item => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(item));
const report = {
  provider: 'proxy.golang.org', path, version,
  fetchedAt: captured.fetchedAt.toISOString(),
  versionList: { url: `https://proxy.golang.org/${path}/@v/list`,
    rawSha256: digest(captured.list), byteLength: captured.list.length,
    stableVersions, omittedTagCount: list.length - stableVersions.length },
  info: { url: `https://proxy.golang.org/${path}/@v/${version}.info`,
    rawSha256: digest(captured.info), byteLength: captured.info.length,
    text: captured.info.toString('utf8') },
  manifest: { url: `https://proxy.golang.org/${path}/@v/${version}.mod`,
    rawSha256: digest(captured.mod), byteLength: captured.mod.length,
    text: captured.mod.toString('utf8') },
};
const directory = resolve('.temp/package-go-provider');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'probe.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report,
  versionList: { ...report.versionList,
    stableVersionCount: report.versionList.stableVersions.length,
    stableVersions: report.versionList.stableVersions.slice(-5) } }, null, 2)}\n`);
