import type { IdentityJobRef, IdentityMapping } from './values.ts';
type Integer = string | number | bigint;
export type IdentityOwnerEvidence = Readonly<{
    partition_no: number;
    epoch: number;
    position?: Integer;
    write_state: string;
}>;
export type IdentitySourceEvidence = Readonly<{
    subject_id: string;
    original: string | null;
    control_partition: number | null;
    control_group: string | null;
    epoch: Integer;
    owner_epoch: number;
    dirty_revision: Integer;
    captured_revision: Integer;
    terminal: string;
    closure_state: string;
    closure_immediate: string | null;
    current_target: string | null;
    source_revision: Integer;
    closure_enrollment: string | null;
    closure_generation: string | null;
    closure_incarnation: string | null;
    closure_install_transaction: string | null;
    closure_registration_transaction: string | null;
    closure_export_transaction: string | null;
}>;
export type IdentityPendingEvidence = Readonly<{
    partition_no: number;
    terminal: string;
    pending_job: string | null;
    pending_epoch: Integer;
}>;
export type IdentityControlEvidence = Readonly<{
    partition_no: number;
    terminal: string;
    requested_original: string;
    redirected: boolean;
    owner_epoch: number;
    closure_state: string;
    directory_state: string | null;
    directory_enrollment: string | null;
    generation: string;
    closure_incarnation: string | null;
    directory_incarnation: string | null;
    directory_install: string | null;
    registration_transaction: string | null;
    directory_export: string | null;
    directory_owner: number | null;
    directory_revision: Integer | null;
    published_epoch: Integer;
}>;
export type IdentityMappingEvidence = Readonly<{
    sourceOwners: readonly IdentityOwnerEvidence[];
    sourceRows: readonly IdentitySourceEvidence[];
    controlOwners: readonly IdentityOwnerEvidence[];
    pendingRows: readonly IdentityPendingEvidence[];
    currentRows: readonly IdentityControlEvidence[];
}>;
export type IdentityMappingRequest = Readonly<{
    original: string;
    sourceHome: number;
}>;
export declare const comparableIdentityEvidence: (value: IdentityMappingEvidence) => string;
/** Classifies only acquired bounded evidence; never acquires facts or native authority. */
export declare function classifyIdentityMappings(requests: readonly IdentityMappingRequest[], evidence: IdentityMappingEvidence, installedJob?: IdentityJobRef | null): IdentityMapping[];
export {};
