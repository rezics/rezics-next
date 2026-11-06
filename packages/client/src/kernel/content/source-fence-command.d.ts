import type { Pool } from 'pg';
import { type CommandOutcome } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import { type ImportedFieldGroup } from './imported-contract.ts';
import type { RequestContext } from './model.ts';
export type SourceFenceDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    clock: () => Date;
}>;
export type SourceFenceTakedownInput = Readonly<{
    source: string;
    external_id: string;
    field_group: ImportedFieldGroup;
    reason: string;
}>;
/** Global governance authorizes a stable source tuple, independently of subjects.
 * Each native attempt releases its root authorization before tuple checkout and
 * authorizes before reading receipts. An upsert never grants creation rights.
 */
export declare function takedownSourceFence(deps: SourceFenceDependencies, actor: Actor, input: SourceFenceTakedownInput, context: RequestContext): Promise<CommandOutcome<{
    securityRevision: string;
}>>;
