import { WEB_SNAPSHOT_COST, SnapshotRightsDenied, SnapshotRobotsDenied, WebSnapshotUnavailable }
  from './schema.ts';

export const SNAPSHOT_USER_AGENT = 'REZICS-source-capture/1 (web snapshot)';
const AGENT_TOKEN = 'REZICS-source-capture';

interface RobotRule { allow: boolean; path: string }

/** RFC 9309 subset: the longest matching Allow or Disallow wins; Allow wins a tie.
 * `*` is a wildcard. A group for this capture agent beats `*`. No matching group allows. */
export function robotsAllows(body: string, path: string, agent = AGENT_TOKEN): boolean {
  const groups = robotGroups(body);
  const specific = groups.filter(group => group.agents.some(name => name !== '*' && agent.toLowerCase().startsWith(name)));
  const chosen = specific.length ? specific : groups.filter(group => group.agents.includes('*'));
  const rules = chosen.flatMap(group => group.rules);
  let winner: RobotRule | null = null;
  for (const rule of rules) {
    if (!robotMatch(rule.path, path)) continue;
    if (!winner || rule.path.length > winner.path.length
      || rule.path.length === winner.path.length && rule.allow && !winner.allow) winner = rule;
  }
  return !winner || winner.allow;
}

function robotGroups(body: string): { agents: string[]; rules: RobotRule[] }[] {
  const groups: { agents: string[]; rules: RobotRule[] }[] = [];
  let agents: string[] = [];
  let rules: RobotRule[] = [];
  const flush = () => {
    if (agents.length || rules.length) groups.push({ agents, rules });
    agents = []; rules = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const split = line.indexOf(':');
    if (split < 0) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === 'user-agent') {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      rules.push({ allow: field === 'allow', path: value });
    }
  }
  flush();
  return groups;
}

function robotMatch(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const end = pattern.endsWith('$');
  const body = end ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${end ? '$' : ''}`).test(path);
}

export interface SnapshotFetchResult {
  bytes: Buffer; mediaType: string; fetchedAt: string;
}

/** Bounded capture of one content location. Rights are checked before any request.
 * Redirects are refused, the same way source capture refuses them. */
export async function fetchWebSnapshot(url: string, options: {
  fetcher?: typeof fetch;
  rightsPermitted: (origin: string) => Promise<boolean>;
  now?: () => Date;
}): Promise<SnapshotFetchResult> {
  const target = checkedSnapshotUrl(url);
  if (!await options.rightsPermitted(target.origin)) {
    throw new SnapshotRightsDenied('Rights do not allow retaining this location');
  }
  const fetcher = options.fetcher ?? fetch;
  const robotsUrl = new URL('/robots.txt', target.origin);
  const robots = await boundedGet(fetcher, robotsUrl, 'text/plain');
  if (robots.status === 200 && !robotsAllows(robots.bytes.toString('utf8'), target.pathname + target.search)) {
    throw new SnapshotRobotsDenied('robots.txt disallows this snapshot');
  }
  if (robots.status !== 200 && robots.status !== 404) {
    throw new WebSnapshotUnavailable('robots.txt could not be read');
  }
  const page = await boundedGet(fetcher, target, null);
  if (page.status !== 200) throw new WebSnapshotUnavailable('Snapshot location did not return its bytes');
  return { bytes: page.bytes, mediaType: page.mediaType || 'application/octet-stream',
    fetchedAt: (options.now ?? (() => new Date()))().toISOString().replace(/\.\d{3}Z$/, '.000Z') };
}

export function checkedSnapshotUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new WebSnapshotUnavailable('Snapshot URL is invalid'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.username || url.password || url.protocol === 'http:' && !loopback || url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebSnapshotUnavailable('Snapshot URL is not an allowed http(s) origin');
  }
  return url;
}

async function boundedGet(fetcher: typeof fetch, url: URL, accept: string | null):
  Promise<{ status: number; bytes: Buffer; mediaType: string }> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(WEB_SNAPSHOT_COST.timeoutMs),
      headers: { 'user-agent': SNAPSHOT_USER_AGENT, ...(accept ? { accept } : {}) } });
  } catch {
    throw new WebSnapshotUnavailable('Snapshot fetch failed');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new WebSnapshotUnavailable('Snapshot redirect was refused');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > WEB_SNAPSHOT_COST.maxBytes)) {
    await response.body?.cancel();
    throw new WebSnapshotUnavailable('Snapshot exceeds the capture limit');
  }
  if (!response.body || response.status === 204) {
    await response.body?.cancel();
    return { status: response.status, bytes: Buffer.alloc(0), mediaType: '' };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > WEB_SNAPSHOT_COST.maxBytes) {
        await reader.cancel();
        throw new WebSnapshotUnavailable('Snapshot exceeds the capture limit');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return { status: response.status, bytes: Buffer.concat(chunks, size), mediaType };
}
