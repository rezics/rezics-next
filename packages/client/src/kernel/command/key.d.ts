/** Principal kind marker only; never an account ID. */
export declare const ANONYMOUS_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000000";
export type CommandPrincipal = {
    kind: 'account';
    id: string;
} | {
    kind: 'anonymous';
    id: typeof ANONYMOUS_PRINCIPAL_ID;
};
/** Pure receipt-key validation; the anonymous marker never identifies an account. */
export declare function normalizeCommandKey(principal: CommandPrincipal, key: string): string;
