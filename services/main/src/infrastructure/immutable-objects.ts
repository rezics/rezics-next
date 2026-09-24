import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';

const DIGEST = /^[0-9a-f]{64}$/;

export class ObjectUnavailable extends Error {}
export class ObjectIntegrityError extends Error {}

export interface ImmutableObjects {
  /** Return the digest only after a conditional create and verified read-back. */
  put(bytes: Uint8Array): Promise<string>;
  /** A missing object is unavailable; bytes with the wrong digest are corrupt. */
  get(digest: string): Promise<Uint8Array>;
}

export interface S3ObjectOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** One privacy/retention domain. A digest in another domain has a distinct key. */
  prefix: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkedDigest(digest: string): string {
  if (!DIGEST.test(digest)) throw new ObjectIntegrityError('invalid immutable object digest');
  return digest;
}

/**
 * Bun S3Client 1.4.2 cannot express If-None-Match on PUT and ignores NO_PROXY
 * for local reads on proxied hosts. Signed fetch covers both operations.
 */
export class S3ImmutableObjects implements ImmutableObjects {
  private readonly signer: AwsClient;
  private readonly bucketUrl: string;
  private readonly prefix: string;

  constructor(options: S3ObjectOptions) {
    const endpoint = new URL(options.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('S3 endpoint must be an HTTP origin');
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)
      || !/^(?:[a-z0-9][a-z0-9-]*\/)+$/.test(options.prefix)) {
      throw new Error('invalid S3 bucket or immutable namespace');
    }
    const region = options.region ?? 'us-east-1';
    this.bucketUrl = `${endpoint.origin}/${options.bucket}`;
    this.prefix = options.prefix;
    this.signer = new AwsClient({ accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey, service: 's3', region, retries: 0 });
  }

  private key(digest: string): string { return `${this.prefix}sha256/${checkedDigest(digest)}`; }

  /** Called before Main announces readiness; it creates only its configured bucket. */
  async initialize(): Promise<void> {
    let response: Response;
    try { response = await this.signer.fetch(this.bucketUrl, { method: 'PUT' }); }
    catch { throw new ObjectUnavailable('cannot reach immutable object bucket'); }
    if (!response.ok && response.status !== 409) {
      throw new ObjectUnavailable(`cannot initialize immutable object bucket (${response.status})`);
    }
    let readable: Response;
    try { readable = await this.signer.fetch(this.bucketUrl, { method: 'HEAD' }); }
    catch { throw new ObjectUnavailable('cannot verify immutable object bucket'); }
    if (!readable.ok) throw new ObjectUnavailable(`cannot access immutable object bucket (${readable.status})`);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const digest = sha256(bytes);
    const key = this.key(digest);
    const body = new Uint8Array(bytes);
    let response: Response;
    try {
      response = await this.signer.fetch(`${this.bucketUrl}/${key}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'if-none-match': '*',
          'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64'),
        },
        body,
        aws: { allHeaders: true },
      });
    } catch {
      throw new ObjectUnavailable('immutable object create response is unavailable');
    }
    if (!response.ok && response.status !== 412 && response.status !== 409) {
      throw new ObjectUnavailable(`immutable object create failed (${response.status})`);
    }
    // A competing creator may have won. In either case, do not publish a manifest
    // until the exact bytes can be read through the selected backend.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await this.get(digest);
        return digest;
      } catch (error) {
        if (!(error instanceof ObjectUnavailable) || attempt === 7) throw error;
        await Bun.sleep(25 * (attempt + 1));
      }
    }
    throw new ObjectUnavailable('immutable object was not visible after conditional create');
  }

  async get(digest: string): Promise<Uint8Array> {
    const key = this.key(digest);
    let response: Response;
    try { response = await this.signer.fetch(`${this.bucketUrl}/${key}`, { method: 'GET' }); }
    catch { throw new ObjectUnavailable('committed immutable object is unavailable'); }
    if (!response.ok) throw new ObjectUnavailable(`committed immutable object is unavailable (${response.status})`);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await response.arrayBuffer()); }
    catch { throw new ObjectUnavailable('committed immutable object could not be read'); }
    if (sha256(bytes) !== digest) throw new ObjectIntegrityError('immutable object digest differs');
    return bytes;
  }
}
