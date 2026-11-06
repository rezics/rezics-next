import type { MediaStorage } from './media-storage.ts';
export interface R2StorageOptions {
    /** Account S3 origin, for example https://account.r2.cloudflarestorage.com. */
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Trusted host transport; must honor Request.signal. Redirects are disabled. */
    fetch: (request: Request) => Promise<Response>;
    maxObjectBytes: number;
    requestTimeoutMs?: number;
}
/** Jobs must retain their durable pending fence when any provider operation fails. */
export declare class MediaStorageError extends Error {
    readonly retryable = true;
    constructor();
}
/** Thin host adapter: aws4fetch owns SigV4; no Worker binding or upload staging flow. */
export declare class R2Storage implements MediaStorage {
    #private;
    constructor(options: R2StorageOptions);
    get(key: string): Promise<Uint8Array | null>;
    put(key: string, bytes: Uint8Array, options: {
        mediaType: string;
    }): Promise<void>;
    deletePrefix(prefix: string): Promise<void>;
}
