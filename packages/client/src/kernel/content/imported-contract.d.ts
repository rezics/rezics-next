import type { BatchReference } from '@rezics/definitions/bulk';
/** Cited evidence attached to an imported source record. */
export type SourceReference = BatchReference;
/** Rights on an imported field. Cover rights are recorded separately on media. */
export type Rights = Readonly<{
    /** An SPDX identifier or an explicit LicenseRef identifier, including LicenseRef-unknown. */
    license: string;
    obligations: readonly string[];
    attribution: string;
}>;
export type ImportedFieldGroup = 'facts' | 'summary' | 'cover';
/** Immutable provenance shared by source fields and their fence tuple. */
export type ImportedSource = Readonly<{
    source: string;
    external_id: string;
    record_revision: string;
    digest: string;
    converter_revision: string;
    field_group: ImportedFieldGroup;
    references: readonly SourceReference[];
}>;
/** Input for persisting a summary document in the semantic command transaction. */
export type ImportedFieldInput = Readonly<{
    subject: string;
    /** Allocated semantic candidate UUID, scoped to the subject partition. */
    candidate: string;
    /** Actual positive semantic revision allocated before the field is appended. */
    revision: number;
    source: ImportedSource;
    rights: Rights;
    language: string;
    document: unknown;
}>;
/** Validate the metadata byte and character caps before an import hook writes anything. */
export declare function validateImportedFieldMetadata(value: unknown): string[];
/** Stable route for a source record identity, shared by field fences and external claims. */
export declare function tupleRoute(routeKey: Uint8Array, source: string, external_id: string): number;
