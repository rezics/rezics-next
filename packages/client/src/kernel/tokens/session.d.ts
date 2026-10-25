import { type KeyRing } from './seal.ts';
export type SessionComponent = {
    partition: number;
    epoch: number;
    position: bigint;
};
export declare function mergeSession(components: readonly SessionComponent[], write: SessionComponent): SessionComponent[];
export declare function encodeSession(ring: KeyRing, scope: string, components: readonly SessionComponent[]): string;
export declare function decodeSession(ring: KeyRing, scope: string, token: string): SessionComponent[] | undefined;
