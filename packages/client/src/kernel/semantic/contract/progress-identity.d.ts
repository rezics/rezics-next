/** Semantic-owned definition and identity statement names for Library progress planning. No SQL. */
export type SemanticProgressIdentityStatement = 'release-exists' | 'release-read' | 'release-active' | 'mapping-owners' | 'mapping-sources' | 'mapping-pending' | 'mapping-current' | 'subject-reference' | 'item-types';
export type SemanticProgressIdentityDescriptor = Readonly<{
    sql: string;
    params?: readonly string[];
    nativeRows: number;
    nativePoints: number;
    identityMetadataRows: number;
    resultBytes: number;
}>;
export type SemanticProgressIdentityDeclaration = Readonly<Record<SemanticProgressIdentityStatement, SemanticProgressIdentityDescriptor>>;
