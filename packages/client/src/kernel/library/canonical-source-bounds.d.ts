/** Closed Library-owned plan for canonical Collection generation repair, publication and completed-pointer readback.
 * Declarations constrain dispatch; they never fund a ledger or mint native authority.
 */
import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import type { LibrarySemanticObservationCapability } from './contract/semantic-observation.ts';
export { CANONICAL_SOURCE_RAW_KEY_LIMIT } from './canonical-source-limits.ts';
export declare function CANONICAL_SOURCE_AXES(): readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
export declare const CANONICAL_SOURCE_ZONE_AGGREGATE = 256;
export declare const CANONICAL_SOURCE_GENERATION_CAPACITY = 2;
export declare const CANONICAL_SOURCE_SCOPE_CAPACITY = 2;
export declare function CANONICAL_SOURCE_ATTEMPTS(): number;
export declare const CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES = 4096;
export declare const CANONICAL_SOURCE_IDENTITY_SWEEPS = 2;
export type CanonicalSourceSqlBound = Bound & Readonly<{
    engineRequests: 0;
}>;
export type CanonicalSourceStatement = Readonly<{
    name: string;
    sql: string;
    requestBytes: number;
    resultBytes: number;
    rows: number;
    raw: boolean;
    bound: CanonicalSourceSqlBound;
}>;
export type CanonicalSourceRawSplit = Readonly<{
    candidateKeys: number;
    aliasKeys: number;
    duplicateKeys: number;
    lookaheadKeys: number;
    internalDriverKeys: number;
}>;
export type CanonicalSourceRawKey = Readonly<{
    driver: string;
    storedSubjectId: string;
    factId: string;
}>;
export declare const CANONICAL_SOURCE_SQL: Readonly<{
    scope: "SELECT identity,frontier,capture_id::text AS capture,committed_revision::text AS revision\n  FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3";
    head: "SELECT generation::text FROM library.canonical_source_head WHERE route=$1 AND collection_id=$2";
    generation: "SELECT generation::text,basis,driver,after_subject::text,after_fact::text,source_exhausted,state,version::text\n  FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 AND generation=$3";
    workingGeneration: "SELECT generation::text,basis,driver,after_subject::text,after_fact::text,source_exhausted,state,version::text\n  FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 AND state='working' FOR UPDATE";
    generationLock: "SELECT generation::text,basis,driver,after_subject::text,after_fact::text,source_exhausted,state,version::text\n  FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 AND generation=$3 FOR UPDATE";
    sourceLock: "SELECT source_generation::text AS generation FROM library.collection WHERE route=$1 AND collection_id=$2 AND state='active' AND curator_account_id=$3 AND collection_id::text || ':' || extract(epoch FROM created_at)::text=$4 FOR UPDATE";
    factLock: "SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2 FOR SHARE";
    abandon: "UPDATE library.canonical_source_generation SET state='abandoned' WHERE route=$1 AND collection_id=$2 AND generation=$3";
    retainedGenerations: "SELECT generation FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2";
    insertGeneration: "INSERT INTO library.canonical_source_generation(route,collection_id,generation,basis,driver) VALUES($1,$2,$3,$4::jsonb,$5)";
    seek: "SELECT canonical_subject_id::text AS subject FROM library.canonical_source_reference\n     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id>COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000')\n     ORDER BY canonical_subject_id,stored_subject_id,driver,fact_id LIMIT 1";
    group: "SELECT stored_subject_id::text AS original,driver,fact_id::text AS fact FROM library.canonical_source_reference\n     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id=$4\n       AND (stored_subject_id,driver,fact_id)>(COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'),COALESCE($6::smallint,-1),COALESCE($7::uuid,'00000000-0000-0000-0000-000000000000'))\n     ORDER BY stored_subject_id,driver,fact_id LIMIT $8";
    insertReference: "INSERT INTO library.canonical_source_reference(route,collection_id,generation,canonical_subject_id,stored_subject_id,driver,fact_id)\n        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING";
    updateFrontier: "UPDATE library.canonical_source_generation SET driver=$4,after_subject=$5,after_fact=$6,source_exhausted=$7,version=version+1\n      WHERE route=$1 AND collection_id=$2 AND generation=$3";
    completeGeneration: "UPDATE library.canonical_source_generation SET state='complete' WHERE route=$1 AND collection_id=$2 AND generation=$3";
    publishHead: "INSERT INTO library.canonical_source_head(route,collection_id,generation) VALUES($1,$2,$3)\n      ON CONFLICT(route,collection_id) DO UPDATE SET generation=EXCLUDED.generation";
    retainedScopes: "SELECT source_fence FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 ORDER BY source_fence LIMIT 2";
    insertScope: "INSERT INTO library.canonical_source_scope(route,collection_id,source_fence,identity) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING";
    updateScopeFrontier: "UPDATE library.canonical_source_scope SET frontier=$4::jsonb\n        WHERE route=$1 AND collection_id=$2 AND source_fence=$3 AND frontier IS NOT DISTINCT FROM $5::jsonb RETURNING collection_id";
}>;
export declare function CANONICAL_SOURCE_STATEMENTS(): Readonly<{
    scope: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    head: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    generation: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    workingGeneration: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    generationLock: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    sourceLock: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    factLock: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    abandon: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    retainedGenerations: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    insertGeneration: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    seek: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    insertReference: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    updateFrontier: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    completeGeneration: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    publishHead: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    retainedScopes: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    insertScope: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
    updateScopeFrontier: Readonly<{
        name: string;
        sql: string;
        requestBytes: number;
        resultBytes: number;
        rows: number;
        raw: boolean;
        bound: CanonicalSourceSqlBound;
    }>;
}>;
export declare function canonicalSourceGroupStatement(limit: number): CanonicalSourceStatement;
export declare function canonicalSourceMappingBound(originalCount: number, observations?: LibrarySemanticObservationCapability): CanonicalSourceSqlBound;
export declare function canonicalSourceOwnerFactBound(limit: number): CanonicalSourceSqlBound;
export declare function canonicalSourceRawWindowBound(limit: number): CanonicalSourceSqlBound;
export declare function CANONICAL_SOURCE_RECEIVING_COST(): Readonly<{
    metadata: CanonicalSourceSqlBound;
    sourceScope: CanonicalSourceSqlBound;
    sourceHead: CanonicalSourceSqlBound;
    sourceGeneration: CanonicalSourceSqlBound;
    seek: CanonicalSourceSqlBound;
    group(limit: number): CanonicalSourceSqlBound;
    state: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
export declare function CANONICAL_SOURCE_TERMS(observations?: LibrarySemanticObservationCapability): Readonly<{
    observation: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    begin: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    rawWindow: CanonicalSourceSqlBound;
    mapping: CanonicalSourceSqlBound;
    repairWrite: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    publish: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    readback: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    seek: CanonicalSourceSqlBound;
    group: CanonicalSourceSqlBound;
    executionEnvelope: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
export declare function CANONICAL_SOURCE_REPAIR_STEP(observations?: LibrarySemanticObservationCapability): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare function CANONICAL_SOURCE_PUBLICATION_STEP(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare function CANONICAL_SOURCE_COMPLETED_READBACK(): Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
export declare function CANONICAL_SOURCE_DECLARATION(observations?: LibrarySemanticObservationCapability): Readonly<{
    status: 'complete';
    axes: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
    limits: Readonly<{
        rawKeys: 100;
        zoneAggregate: 256;
        generations: 2;
        scopes: 2;
        attempts: number;
        identitySweepHomes: 4096;
        identitySweeps: 2;
    }>;
    statements: Readonly<{
        scope: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        head: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        generation: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        workingGeneration: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        generationLock: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        sourceLock: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        factLock: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        abandon: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        retainedGenerations: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        insertGeneration: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        seek: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        insertReference: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        updateFrontier: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        completeGeneration: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        publishHead: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        retainedScopes: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        insertScope: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
        updateScopeFrontier: Readonly<{
            name: string;
            sql: string;
            requestBytes: number;
            resultBytes: number;
            rows: number;
            raw: boolean;
            bound: CanonicalSourceSqlBound;
        }>;
    }>;
    terms: Readonly<{
        observation: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        begin: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        rawWindow: CanonicalSourceSqlBound;
        mapping: CanonicalSourceSqlBound;
        repairWrite: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        publish: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        readback: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        seek: CanonicalSourceSqlBound;
        group: CanonicalSourceSqlBound;
        executionEnvelope: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>;
    repair: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    publication: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    readback: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    receiving: Readonly<{
        metadata: CanonicalSourceSqlBound;
        sourceScope: CanonicalSourceSqlBound;
        sourceHead: CanonicalSourceSqlBound;
        sourceGeneration: CanonicalSourceSqlBound;
        seek: CanonicalSourceSqlBound;
        group(limit: number): CanonicalSourceSqlBound;
        state: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>;
}>;
/** Adapter edge for the existing eight-axis native observer. Canonical SQL declares zero engine requests. */
export declare function canonicalSourceWorkDimensions(bound: Bound): WorkDimensions;
export declare function canonicalSourceCallAllowance(bound?: Bound): Readonly<{
    rawKeys: number;
    nativeRows: number;
    nativePoints: number;
    emptySeeks: number;
    statements: number;
    bytes: number;
    identityMetadataRows: number;
}>;
export declare function assertCanonicalSourceStatement(statement: CanonicalSourceStatement, values: readonly unknown[]): CanonicalSourceSqlBound;
export declare function canonicalSourceRawSplit(keys: readonly CanonicalSourceRawKey[], canonicalSubjectId?: string | null): CanonicalSourceRawSplit;
export declare function canonicalSourceRawTotal(split: CanonicalSourceRawSplit): number;
