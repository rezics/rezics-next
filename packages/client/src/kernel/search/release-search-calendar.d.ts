/** Generic calendar projection format, independent of catalogue subtype or property identity. */
export declare const CALENDAR_INDEX_FORMAT = 1;
/** An inert successor definition; never upgrades or certifies an existing physical generation. */
export declare function calendarIndexDefinition(base: Record<string, unknown>): Record<string, unknown>;
/** Mapping compatibility alone is not population readiness or publication authority. */
export declare function hasCalendarIndexFormat(mappings: unknown): boolean;
export type CalendarPhysicalIdentity = Readonly<{
    generation: number;
    incarnation: string;
    indexUuid: string;
}>;
export type CalendarPopulationEvidence = CalendarPhysicalIdentity & Readonly<{
    partitionsByPool: Readonly<Record<string, readonly number[]>>;
}>;
/** Return the compiler capability only for the exact active physical index with complete pool coverage. */
export declare function calendarFormatForReadyGeneration(input: {
    mappings: unknown;
    physical: CalendarPhysicalIdentity;
    active?: CalendarPhysicalIdentity;
    population?: CalendarPopulationEvidence;
    requiredPartitionsByPool: Readonly<Record<string, readonly number[]>>;
}): typeof CALENDAR_INDEX_FORMAT | undefined;
