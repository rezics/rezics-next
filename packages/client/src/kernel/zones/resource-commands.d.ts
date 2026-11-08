import { type CommandOutcome } from '../command/command.ts';
import type { ZoneConfigureInput, ZoneCreateInput, ZoneHoldInput, ZonePublishInput, ZonePurgeInput, ZoneTakedownInput } from './contract.ts';
import { type ZoneAccessHandle, type ZoneAccountActor, type ZoneActor, type ZoneResourceAccessPort, type ZoneResourceRuntimeDependencies } from './resource-access-port.ts';
export type ZoneMutation = 'configure' | 'publish' | 'delete' | 'restore' | 'takedown' | 'release_takedown';
export type ZonePlatformMutation = 'hold' | 'release_hold' | 'purge';
export declare function zoneIfMatch(value: string | undefined): string;
export type ZoneCommandDependencies = ZoneResourceRuntimeDependencies & {
    ports?: ZoneResourceAccessPort;
};
/** Native create, configure, publish, delete, restore, takedown and platform lifecycle. Access is the bound port. */
export declare function createZoneCommands(dependencies: ZoneCommandDependencies): {
    create: (actor: ZoneActor, input: ZoneCreateInput, key: string, deadline: number) => Promise<CommandOutcome<{
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
    }>>;
    mutate: (actor: ZoneActor, id: string, operation: ZoneMutation, input: ZoneConfigureInput | ZonePublishInput | ZoneTakedownInput | null, expected: string, key: string, deadline: number) => Promise<CommandOutcome<{
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
    }>>;
    platform: {
        (actor: ZoneActor, id: string, operation: 'hold' | 'release_hold', input: ZoneHoldInput | Record<string, never>, key: string, deadline: number): Promise<CommandOutcome<{
            id: string;
            held: boolean;
        }>>;
        (actor: ZoneActor, id: string, operation: 'purge', input: ZonePurgeInput, key: string, deadline: number): Promise<CommandOutcome<{
            id: string;
            state: 'purge_pending';
        }>>;
    };
};
export type { ZoneAccessHandle, ZoneAccountActor, ZoneActor };
