/** Mounted Content source-classification client until official kernel emit publishes these routes. */
export type SourceClassificationAssociation = {
    subjectId: string;
    candidateId: string;
    contextId: string;
    targetId: string;
    property: string;
    revision: number;
    release: string;
    qualifiersDigest: string;
};
export type SourceClassificationVersion = {
    kind: 'revision';
    revision: string;
} | {
    kind: 'unversioned';
    digest: string;
};
export type SourceClassificationObservation = {
    sourceAlias: string;
    sourceRecordId: string;
    sourceAssociationId: string;
    asOf: string;
    sourceVersion: SourceClassificationVersion;
    attribution: string;
    licence: string;
    confidence?: number;
    lie?: boolean;
    confidenceCount?: number;
    lieCount?: number;
};
export type SourceClassificationClear = {
    sourceAlias: string;
    sourceRecordId: string;
    sourceAssociationId: string;
    asOf: string;
    cleared: true;
};
export type SourceClassificationFigure = {
    provider: 'vndb';
    association: SourceClassificationAssociation;
    observation: {
        digest: string;
        sourceVersion: SourceClassificationVersion;
    };
    sourceAlias: string;
    sourceRecordId: string;
    sourceAssociationId: string;
    confidence: {
        state: 'available';
        value: number;
        unit: 'vndb-tag-rating';
        minExclusive: 0;
        max: 3;
    } | {
        state: 'unavailable';
        reason: 'not_supplied';
    };
    lie: {
        state: 'available';
        value: boolean;
        unit: 'boolean';
    } | {
        state: 'unavailable';
        reason: 'not_supplied';
    };
    confidenceCount?: number;
    lieCount?: number;
    asOf: string;
    ageSeconds: number;
    attribution: string;
    licence: string;
};
export type SourceClassificationRead = {
    state: 'available';
    value: SourceClassificationFigure;
} | {
    state: 'unavailable';
    reason: 'not_found' | 'not_observed' | 'provenance_unavailable' | 'authority_unavailable' | 'changed';
};
export type SourceClassificationBatch = {
    items: SourceClassificationRead[];
    actions: ('put' | 'clear')[];
};
export type SourceClassificationPutResult = {
    observationDigest: string;
    state: 'published';
    figure: SourceClassificationFigure;
};
export type SourceClassificationClearResult = {
    observationDigest: string;
    state: 'cleared';
};
type ClassificationCall<Body, Data, Headers extends Record<string, string> | undefined = undefined> = (body: Body, options?: (Headers extends undefined ? {
    fetch?: {
        signal?: AbortSignal;
    };
} : {
    headers: Headers;
    fetch?: {
        signal?: AbortSignal;
    };
})) => Promise<{
    data: Data | null;
    error: unknown;
    response: Response;
    status: number;
}>;
/** Eden methods for POST /v1/subjects/:id/source-classifications:{read,put,clear}. */
export type SourceClassificationsClient = {
    $read: {
        post: ClassificationCall<{
            associations: SourceClassificationAssociation[];
        }, SourceClassificationBatch>;
    };
    $put: {
        post: ClassificationCall<{
            association: SourceClassificationAssociation;
            expectedObservation: string | null;
            value: SourceClassificationObservation;
        }, SourceClassificationPutResult, {
            'idempotency-key': string;
        }>;
    };
    $clear: {
        post: ClassificationCall<{
            association: SourceClassificationAssociation;
            expectedObservation: string | null;
            value: SourceClassificationClear;
        }, SourceClassificationClearResult, {
            'idempotency-key': string;
        }>;
    };
};
