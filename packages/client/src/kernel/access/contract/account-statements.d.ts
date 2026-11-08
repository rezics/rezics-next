/** Access-owned account statement names for Library progress planning. No SQL. */
export type AccessAccountStatement = 'account-read' | 'account-share';
export type AccessAccountStatementDescriptor = Readonly<{
    sql: string;
    params?: readonly string[];
    nativeRows: number;
    nativePoints: number;
    identityMetadataRows: number;
    resultBytes: number;
}>;
export type AccessAccountStatementDeclaration = Readonly<Record<AccessAccountStatement, AccessAccountStatementDescriptor>>;
