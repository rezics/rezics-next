/** Host-side byte storage shared by image, collection and erasure jobs. */
export interface MediaStorage {
    get(key: string): Promise<Uint8Array | null>;
    put(key: string, bytes: Uint8Array, options: {
        mediaType: string;
    }): Promise<void>;
    deletePrefix(prefix: string): Promise<void>;
}
