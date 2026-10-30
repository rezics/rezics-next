import type { Pool } from 'pg';
import { type CommandOutcome } from '../command/command.ts';
import type { Access, Resource } from '../request/access.ts';
import { type PublicGrantSubject } from './grant-subject.ts';
import { type GrantCommandContext } from './grant-command.ts';
export { GrantDeniedError } from './resource-access-errors.ts';
export type GrantRecipient = {
    subject: PublicGrantSubject;
    subjectId?: never;
    subjectRole?: never;
} | {
    subject?: never;
    subjectId: string;
    subjectRole: '' | 'owner' | 'member';
};
export type GrantInput = GrantRecipient & {
    resource: Resource;
    actions: readonly string[];
    valid: string;
    key: string;
};
type GrantValue<Input extends GrantInput> = {
    resource: Resource;
    actions: string[];
    valid: string;
} & (Input extends {
    subject: infer Subject extends PublicGrantSubject;
} ? {
    subject: Subject;
} : {
    subjectId: string;
    subjectRole: '' | 'owner' | 'member';
});
export type GrantChangeInput = GrantInput & {
    previous: {
        actions: readonly string[];
        valid: string;
    };
};
export type RoleGrantInput = {
    resource: Resource;
    subject: PublicGrantSubject;
    role: string;
    valid: string;
    key: string;
};
export type RoleGrantChangeInput = RoleGrantInput & {
    previous: {
        role: string;
        valid: string;
    };
};
export type RealmOwnerTransferInput = {
    resource: Resource;
    fromAccountId: string;
    toAccountId: string;
    previousValid: string;
    key: string;
};
export declare function hasNativeRealmGrantCommands(value: unknown, pool: Pool, access: Access): boolean;
/** The composition root supplies the mounted catalogue's colon-form management
 * action. There is no privileged management or caller-supplied grantor path.
 */
export declare function createGrantCommands(config: {
    pool: Pool;
    access: Access;
    managementAction: string;
    clock?: (() => Date) | undefined;
}): {
    transferRealmOwner: (context: GrantCommandContext, body: RealmOwnerTransferInput) => Promise<CommandOutcome<{
        resource: Resource;
        subject: {
            kind: 'account';
            id: string;
        };
        role: string;
        valid: string;
    }>>;
    createRole: (context: GrantCommandContext, input: RoleGrantInput) => Promise<CommandOutcome<{
        resource: Resource;
        subject: PublicGrantSubject;
        role: string;
        valid: string;
    }>>;
    changeRole: (context: GrantCommandContext, input: RoleGrantChangeInput) => Promise<CommandOutcome<{
        resource: Resource;
        subject: PublicGrantSubject;
        role: string;
        valid: string;
    }>>;
    revokeRole: (context: GrantCommandContext, input: RoleGrantInput) => Promise<CommandOutcome<{
        resource: Resource;
        subject: PublicGrantSubject;
        role: string;
        valid: string;
    }>>;
    create: <Input extends GrantInput>(context: GrantCommandContext, input: Input) => Promise<CommandOutcome<GrantValue<Input>>>;
    change: <Input extends GrantChangeInput>(context: GrantCommandContext, input: Input) => Promise<CommandOutcome<GrantValue<Input>>>;
    revoke: <Input extends GrantInput>(context: GrantCommandContext, input: Input) => Promise<CommandOutcome<GrantValue<Input>>>;
};
