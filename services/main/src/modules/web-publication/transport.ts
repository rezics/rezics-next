import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { WEB_SNAPSHOT_COST, WebSnapshotUnavailable } from './schema.ts';

export const SNAPSHOT_USER_AGENT = 'REZICS-source-capture/1 (web snapshot)';

export interface SnapshotResponse {
  status: number;
  bytes: Buffer;
  mediaType: string;
}
export interface SnapshotTransport {
  get(url: URL, accept: string | null): Promise<SnapshotResponse>;
}
export interface SnapshotAddress {
  address: string;
  family: number;
}
export type SnapshotResolver = (host: string) => Promise<SnapshotAddress[]>;

const nonPublic = new BlockList();
// https://www.iana.org/assignments/iana-ipv4-special-registry (2025-10-09)
// Refuse special-purpose blocks even where they contain public exceptions.
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  nonPublic.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
// Conservative public-unicast policy: exclude protocol/transition assignments
// and documentation, including expanded spellings and embedded IPv4 addresses.
// https://www.iana.org/assignments/iana-ipv6-special-registry (2025-10-09)
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  nonPublic.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return !nonPublic.check(value, 'ipv4');
  return (
    family === 6 &&
    !value.includes('%') &&
    globalV6.check(value, 'ipv6') &&
    !nonPublic.check(value, 'ipv6')
  );
}

/** Like the bounded MCP transport, check all DNS answers and pin one socket
 * lookup. Preserve the hostname for Host and TLS verification; never reuse a
 * socket or follow redirects. The request deadline includes DNS and the body. */
export class SafeSnapshotTransport implements SnapshotTransport {
  private readonly resolve: SnapshotResolver;
  private readonly request: typeof httpsRequest;

  constructor(network: { resolve?: SnapshotResolver; request?: typeof httpsRequest } = {}) {
    this.resolve = network.resolve ?? ((host) => lookup(host, { all: true, verbatim: true }));
    this.request = network.request ?? httpsRequest;
  }

  async get(url: URL, accept: string | null): Promise<SnapshotResponse> {
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new WebSnapshotUnavailable('Snapshot URL is not an allowed HTTPS origin');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_SNAPSHOT_COST.timeoutMs);
    const signal = controller.signal;
    try {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const family = isIP(host);
      const addresses = family
        ? [{ address: host, family }]
        : await resolveBeforeDeadline(this.resolve, host, signal);
      if (
        !addresses.length ||
        addresses.some(
          (address) =>
            !isPublicAddress(address.address) || address.family !== isIP(address.address),
        )
      ) {
        throw new WebSnapshotUnavailable('Snapshot location resolves to a non-public address');
      }
      signal.throwIfAborted();
      const address = addresses[0]!;
      const pinnedLookup: LookupFunction = (_host, options, callback) => {
        if (options && typeof options === 'object' && 'all' in options && options.all) {
          callback(null, [address]);
        } else callback(null, address.address, address.family);
      };
      return await this.receive(url, accept, signal, pinnedLookup, address.family);
    } catch (error) {
      if (error instanceof WebSnapshotUnavailable) throw error;
      throw new WebSnapshotUnavailable('Snapshot fetch failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private receive(
    url: URL,
    accept: string | null,
    signal: AbortSignal,
    pinnedLookup: LookupFunction,
    family: number,
  ): Promise<SnapshotResponse> {
    return new Promise((resolve, reject) => {
      const outgoing = this.request(
        url,
        {
          method: 'GET',
          signal,
          lookup: pinnedLookup,
          agent: false,
          family,
          maxHeaderSize: 16_384,
          headers: {
            'user-agent': SNAPSHOT_USER_AGENT,
            'accept-encoding': 'identity',
            ...(accept ? { accept } : {}),
          },
        },
        (incoming) => {
          incoming.on('error', reject);
          incoming.on('aborted', () =>
            reject(new WebSnapshotUnavailable('Snapshot response was interrupted')),
          );
          let refused = false;
          const refuse = (message: string) => {
            refused = true;
            incoming.destroy();
            outgoing.destroy();
            reject(new WebSnapshotUnavailable(message));
          };
          const status = incoming.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            refuse('Snapshot redirect was refused');
            return;
          }
          const declared = incoming.headers['content-length'];
          if (
            declared !== undefined &&
            (!/^[0-9]+$/.test(declared) || Number(declared) > WEB_SNAPSHOT_COST.maxBytes)
          ) {
            refuse('Snapshot exceeds the capture limit');
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer | string) => {
            if (refused) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > WEB_SNAPSHOT_COST.maxBytes) {
              refuse('Snapshot exceeds the capture limit');
              return;
            }
            chunks.push(bytes);
          });
          incoming.on('end', () => {
            if (refused) return;
            resolve({
              status,
              bytes: Buffer.concat(chunks, size),
              mediaType:
                (incoming.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
            });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  }
}

function resolveBeforeDeadline(
  resolveHost: SnapshotResolver,
  host: string,
  signal: AbortSignal,
): Promise<SnapshotAddress[]> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new WebSnapshotUnavailable('Snapshot DNS lookup timed out'));
    };
    signal.addEventListener('abort', abort, { once: true });
    resolveHost(host)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
