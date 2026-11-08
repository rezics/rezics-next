/** Native reads supplied to the Subject reading application by ordinary Kernel composition. */
export type SubjectReadingFenceTuple = Readonly<{
    route: number;
    source: string;
    external_id: string;
    field_group: string;
}>;
export type SubjectReadingFence = SubjectReadingFenceTuple & Readonly<{
    takenDown: boolean;
    securityRevision: string | null;
}>;
export type SubjectReadingNativePort<Runtime, Connection, Release, Context, Document, CharacterDocuments, Cover, FenceTuple extends SubjectReadingFenceTuple, Fence extends SubjectReadingFence> = Readonly<{
    readContextSnapshot(connection: Connection, context: string): Promise<Context | null>;
    readActiveRelease(connection: Connection): Promise<{
        digest: string;
        release: Release;
    } | null>;
    readRelease(connection: Connection, digest: string): Promise<Release | null>;
    layerRelease(connection: Connection, release: {
        digest: string;
        release: Release;
    }, context: string): Promise<{
        digest: string;
        release: Release;
    }>;
    readCurrentDocument(runtime: Runtime, document: string): Promise<Document | null>;
    readCharacterDocuments(runtime: Runtime, subject: unknown, release: Release, locale: string): Promise<CharacterDocuments | undefined>;
    checkCover(connection: Connection, media: string): Promise<Cover | null>;
    checkCovers(connection: Connection, media: readonly string[]): Promise<ReadonlyMap<string, Cover | null>>;
    readCoverFences(connection: Connection, tuples: readonly FenceTuple[]): Promise<readonly Fence[]>;
    readAnchoredCoverFences(pool: Connection, partition: number, tuples: readonly FenceTuple[]): Promise<readonly Fence[]>;
    importedTupleRoute(routeKey: Uint8Array, source: string, externalId: string): number;
}>;
/** Request-local Access preparation is explicit at the application boundary. */
export type SubjectReadingAuthorizationPort<Check> = Readonly<{
    prepareDetail(subject: string): Promise<Check>;
    prepareSummary(subject: string, related: readonly string[]): Promise<Check>;
}>;
