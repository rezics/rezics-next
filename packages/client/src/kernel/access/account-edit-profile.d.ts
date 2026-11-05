import { type AvatarSummary } from '../content/avatar.ts';
import { type Access, type AccessContext, type AccountActor } from '../request/access.ts';
import { type AccountLink, type AccountPublicViews } from './account-data.ts';
export type EditableAccountProfile = {
    id: string;
    kind: 'actor' | 'organization';
    handle: string | null;
    displayName: string | null;
    bio: string | null;
    links: AccountLink[];
    avatar: AvatarSummary | null;
    publicViews: AccountPublicViews;
    speakersListed?: boolean;
};
/** Private source fields, addressed by immutable account ID, under updateAccount's authority.
 * Preparation and a foreign operator check release their connections before the subject snapshot.
 * This is a read: it neither creates a command attempt nor spends a write operation.
 */
export declare function readEditableAccountProfile(access: Access, context: AccessContext & {
    actor: AccountActor;
}, accountId: string): Promise<{
    profile: EditableAccountProfile;
}>;
