/** A recipient predicate, never an account, credential owner or organization. */
export declare const ACTIVE_ACCOUNTS: Readonly<{
    readonly kind: 'active_accounts';
}>;
export type GrantSubject = typeof ACTIVE_ACCOUNTS | Readonly<{
    kind: 'account';
    id: string;
}> | Readonly<{
    kind: 'organization';
    id: string;
    role: 'owner' | 'member';
}> | Readonly<{
    kind: 'realm';
    id: string;
    role: 'owner' | 'member';
}>;
export type StoredGrantSubject = {
    kind: 'identity' | 'active_accounts';
    id: string;
    role: '' | 'owner' | 'member';
};
export declare function grantSubject(subject: GrantSubject): StoredGrantSubject | null;
