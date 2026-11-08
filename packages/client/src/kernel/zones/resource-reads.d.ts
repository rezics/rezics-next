import type { Pool } from 'pg';
import type { CompositionDocument } from '@rezics/composition';
import type { ZoneOwned, ZonePublic } from './contract.ts';
import { type ZoneHead } from './resource-store.ts';
import { type ZoneAccessHandle, type ZoneAccountActor, type ZoneActor, type ZoneQueryClient, type ZoneResourceAccessPort, type ZoneResourceRuntimeDependencies } from './resource-access-port.ts';
export declare function requireZoneAccount(actor: ZoneActor): asserts actor is ZoneAccountActor;
export declare function zoneIdentity(id: string): {
    route: number;
    id: string;
};
/** Only the explicitly closed shell crosses the metadata boundary. */
export declare function zonePublic(row: ZoneHead): ZonePublic;
export declare function zoneOwned(row: ZoneHead): ZoneOwned;
export type ZoneCollectionBasis = {
    mounts: string[];
    revision: string;
    lifecycleRevision: string;
    visibility: ZoneHead['visibility'];
    ownerId: string | null;
};
export declare function zoneReadTransaction<T>(pool: Pool, work: (client: ZoneQueryClient) => Promise<T>, deadline?: number, ports?: ZoneResourceAccessPort): Promise<T>;
export type ZoneReadDependencies = ZoneResourceRuntimeDependencies & {
    ports?: ZoneResourceAccessPort;
};
/** Current metadata, configuration, owner listing and authorized page descriptors. Access is the bound port. */
export declare function createZoneReads(dependencies: ZoneReadDependencies): {
    metadata: (actor: ZoneActor, id: string, deadline: number) => Promise<{
        zone: {
            id: string;
            revision: string;
            labels: {
                de?: string;
                en?: string;
                es?: string;
                fr?: string;
                ja?: string;
                ko?: string;
                "zh-Hans"?: string;
                "zh-Hant"?: string;
            };
            primaryLanguage?: "de" | "en" | "es" | "fr" | "ja" | "ko" | "zh-Hans" | "zh-Hant";
            visibility: "private" | "public" | "unlisted";
            appearance: {
                density?: "comfortable" | "compact";
                radius?: "lg" | "md" | "sm";
                surface?: "cards" | "flat";
                cover?: "landscape" | "portrait" | "square";
                headingScale?: "lg" | "md";
            };
            navigation: {
                route: string;
            }[];
        };
    }>;
    configuration: (actor: ZoneActor, id: string, deadline: number) => Promise<{
        zone: {
            id: string;
            revision: string;
            labels: {
                de?: string;
                en?: string;
                es?: string;
                fr?: string;
                ja?: string;
                ko?: string;
                "zh-Hans"?: string;
                "zh-Hant"?: string;
            };
            primaryLanguage?: "de" | "en" | "es" | "fr" | "ja" | "ko" | "zh-Hans" | "zh-Hant";
            visibility: "private" | "public" | "unlisted";
            appearance: {
                density?: "comfortable" | "compact";
                radius?: "lg" | "md" | "sm";
                surface?: "cards" | "flat";
                cover?: "landscape" | "portrait" | "square";
                headingScale?: "lg" | "md";
            };
            navigation: {
                route: string;
            }[];
            ownerId: string;
            deletedAt: string | null;
            restoreUntil: string | null;
        };
        configuration: import("@rezics/composition").ZoneConfiguration;
        mounts: string[];
    }>;
    collectionBasis(actor: ZoneActor, id: string, deadline: number): Promise<ZoneCollectionBasis>;
    list: (actor: ZoneActor, query: {
        limit?: number;
        cursor?: string;
        deleted?: boolean;
    }, deadline: number) => Promise<{
        zones: {
            id: string;
            revision: string;
            labels: {
                de?: string;
                en?: string;
                es?: string;
                fr?: string;
                ja?: string;
                ko?: string;
                "zh-Hans"?: string;
                "zh-Hant"?: string;
            };
            primaryLanguage?: "de" | "en" | "es" | "fr" | "ja" | "ko" | "zh-Hans" | "zh-Hant";
            visibility: "private" | "public" | "unlisted";
            appearance: {
                density?: "comfortable" | "compact";
                radius?: "lg" | "md" | "sm";
                surface?: "cards" | "flat";
                cover?: "landscape" | "portrait" | "square";
                headingScale?: "lg" | "md";
            };
            navigation: {
                route: string;
            }[];
            ownerId: string;
            deletedAt: string | null;
            restoreUntil: string | null;
        }[];
        next: string | null;
    }>;
    page: (actor: ZoneActor, id: string, route: string | null, deadline: number) => Promise<{
        zone: {
            id: string;
            revision: string;
            labels: {
                de?: string;
                en?: string;
                es?: string;
                fr?: string;
                ja?: string;
                ko?: string;
                "zh-Hans"?: string;
                "zh-Hant"?: string;
            };
            primaryLanguage?: "de" | "en" | "es" | "fr" | "ja" | "ko" | "zh-Hans" | "zh-Hant";
            visibility: "private" | "public" | "unlisted";
            appearance: {
                density?: "comfortable" | "compact";
                radius?: "lg" | "md" | "sm";
                surface?: "cards" | "flat";
                cover?: "landscape" | "portrait" | "square";
                headingScale?: "lg" | "md";
            };
            navigation: {
                route: string;
            }[];
        };
        document: CompositionDocument | null;
        sources: {
            scopes: string[];
            mounts: string[];
            releaseDigest: string;
            revision: string;
        };
        time: import("../command/command.ts").AuthoritativeTime;
        component: {
            partition: number;
            epoch: number;
            position: bigint;
        };
    }>;
};
export type { ZoneAccessHandle, ZoneAccountActor, ZoneActor, ZoneQueryClient };
