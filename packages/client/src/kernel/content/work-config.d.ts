import type { R2StorageOptions } from './r2-storage.ts';
export type ContentStorageConfig = Readonly<{
    kind: 'r2';
} & Omit<R2StorageOptions, 'fetch'>> | Readonly<{
    kind: 'local';
    root: string;
    maxObjectBytes: number;
}>;
export type ContentWorkGroupName = 'storage' | 'sources';
export type ContentWorkGroup = Readonly<{
    name: ContentWorkGroupName;
    variables: readonly string[];
}>;
export type ContentWorkConfig = Readonly<{
    storage: ContentStorageConfig | null;
    sourceHosts: readonly string[];
    absentGroups: readonly ContentWorkGroup[];
}>;
type Environment = Readonly<Record<string, string | undefined>>;
/** Host configuration only. Each group is absent or complete. Errors name a variable, never its value. */
export declare function readContentWorkConfig(env: Environment): ContentWorkConfig;
export {};
