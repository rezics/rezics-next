export type KeyRing = {
    current: number;
    keys: ReadonlyMap<number, Uint8Array>;
};
export declare function seal(ring: KeyRing, scope: string, payload: unknown): string;
export declare function unseal(ring: KeyRing, scope: string, token: string): unknown | undefined;
