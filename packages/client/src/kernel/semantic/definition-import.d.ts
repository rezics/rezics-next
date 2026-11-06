import { type Extension } from '@rezics/definitions/extension';
import { type ActivationReconciliation, type EditorialHead, type ExtensionComparison, type PublicationDiagnostic, type PublicationIdentity, type PublicationOperations, type ReleaseComparison } from '@rezics/definitions';
import { type Release } from '@rezics/definitions';
import type { Pool } from 'pg';
export type ImportedPreview = {
    kind: 'release' | 'sources' | 'extension' | 'invalid';
    identity: PublicationIdentity | null;
    diagnostics: PublicationDiagnostic[];
    comparison: ReleaseComparison | ExtensionComparison | null;
    types: {
        id: string;
    }[];
    current: EditorialHead | null;
    reconciliation: ActivationReconciliation | null;
    operations: PublicationOperations;
    document: Release | Extension | null;
};
export type DefinitionImportRequest = {
    document: unknown;
    context?: string;
    expected_head?: number | null;
};
/** Finite route type for POST /v1/definitions/imports so client emission keeps the mounted method. */
export type DefinitionImportRoutes = {
    v1: {
        definitions: {
            imports: {
                post: {
                    body: DefinitionImportRequest;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: ImportedPreview;
                        400: unknown;
                        401: unknown;
                        403: unknown;
                        404: unknown;
                        503: unknown;
                    };
                    error: never;
                };
            };
        };
    };
};
export declare function previewImportedDocument(pool: Pool, document: unknown, options?: {
    context?: string;
    expectedHead?: number | null;
    admitted: boolean;
}): Promise<ImportedPreview>;
export declare function readPublishedRelease(pool: Pool, digest: string): Promise<{
    digest: string;
    release: Release;
} | null>;
export declare function readPublishedExtensionBody(pool: Pool, context: string, digest: string): Promise<{
    digest: string;
    extension: Extension;
} | null>;
