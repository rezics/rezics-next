import { type KeyRing } from './seal.ts';
export type CursorBinding = {
    operation: string;
    parameters: Readonly<Record<string, string | number | boolean | null>>;
};
export type CursorKey = string | number;
export type CursorResult = {
    ok: true;
    epoch: number;
    after: CursorKey[];
} | {
    ok: false;
    reason: 'expired' | 'invalid';
};
type CursorInput = {
    epoch: number;
    after: readonly CursorKey[];
};
export declare function canonicalParameters(parameters: CursorBinding['parameters']): string;
export declare function encodeCursor(ring: KeyRing, binding: CursorBinding, cursor: CursorInput, now?: number): string;
export declare function decodeCursor(ring: KeyRing, binding: CursorBinding, token: string, now?: number): CursorResult;
export {};
