import type { AvatarSummary } from './contract/index.ts';
import { type Access, type AccessContext, type AccountActor } from './check.ts';
import { type AccountLink, type AccountPublicViews } from './account-data.ts';
import { type AccessWork } from './work.ts';
export declare const PROFILE_TEXT_MAX_LENGTH = 4096;
export declare const PROFILE_LINK_MAX_ITEMS = 5;
export declare const PROFILE_LINK_LABEL_MAX_LENGTH = 64;
export declare const PROFILE_LINK_URL_MAX_LENGTH = 2048;
export declare const PROFILE_PUBLIC_VIEW_FLAGS: readonly ['posts', 'reviews', 'collections', 'realms'];
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
type TextAdvice = {
    applicable: true;
    maxLength: typeof PROFILE_TEXT_MAX_LENGTH;
};
type AvatarAdvice = {
    applicable: true;
};
type LinksAdvice = {
    applicable: true;
    maxItems: typeof PROFILE_LINK_MAX_ITEMS;
    labelMaxLength: typeof PROFILE_LINK_LABEL_MAX_LENGTH;
    urlMaxLength: typeof PROFILE_LINK_URL_MAX_LENGTH;
};
type PublicViewsAdvice = {
    applicable: true;
    flags: typeof PROFILE_PUBLIC_VIEW_FLAGS;
};
type SpeakersAdvice = {
    applicable: true;
};
type ActorEditing = {
    viewer: {
        accountId: string;
    };
    target: {
        accountId: string;
        kind: 'actor';
    };
    fields: {
        displayName: TextAdvice;
        biography: TextAdvice;
        avatar: AvatarAdvice;
        links: LinksAdvice;
        publicViews: PublicViewsAdvice;
    };
};
type OrganizationEditing = {
    viewer: {
        accountId: string;
    };
    target: {
        accountId: string;
        kind: 'organization';
    };
    fields: {
        displayName: TextAdvice;
        biography: TextAdvice;
        avatar: AvatarAdvice;
        links: LinksAdvice;
        publicViews: PublicViewsAdvice;
        speakersListed: SpeakersAdvice;
    };
};
export type AccountProfileEditing = ActorEditing | OrganizationEditing;
export type EditableAccountProfileRead = {
    profile: EditableAccountProfile;
    editing: AccountProfileEditing;
};
/** Closed field advice from this read's prepared update authority, account kind and command limits.
 * The handle is immutable here. Advice is an observation, never a durable grant.
 */
export declare function accountProfileEditing(viewerAccountId: string, target: {
    id: string;
    kind: 'actor' | 'organization';
}): AccountProfileEditing;
/** Closed owner envelope for this private GET: checkout, controls, statement, avatar, serialization. */
export declare function accountEditProfileReadWork(): AccessWork;
/** Private source fields, addressed by immutable account ID, under updateAccount's authority.
 * Preparation and a foreign operator check release their connections before the subject snapshot.
 * This is a read: it neither creates a command attempt nor spends a write operation.
 */
export declare function readEditableAccountProfile(access: Access, context: AccessContext & {
    actor: AccountActor;
}, accountId: string): Promise<EditableAccountProfileRead>;
export {};
