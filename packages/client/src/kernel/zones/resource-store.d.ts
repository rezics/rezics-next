import { type ZoneHead } from './resource-head.ts';
import { type ZoneQueryClient } from './resource-access-port.ts';
export { compareAndSetZone, insertZone, lockZoneHead, zoneHeadFromRow, type ZoneHead } from './resource-head.ts';
export declare function readZoneHead(client: ZoneQueryClient, route: number, id: string): Promise<ZoneHead | null>;
/** Public Zone payload remains eligible only while its native owner account is live. */
export declare function zoneOwnerIsActive(client: ZoneQueryClient, row: ZoneHead): Promise<boolean>;
export declare function ownerZoneKeys(client: ZoneQueryClient, input: {
    route: number;
    owner_id: string;
    state: string;
    after: string;
    limit: number;
}): Promise<{
    id: string;
}[]>;
/** Current ordinary role evidence only; native Access still decides every action and actor admission. */
export declare function hasZoneOwnerRole(client: ZoneQueryClient, route: number, id: string, accountId: string, at: string): Promise<boolean>;
