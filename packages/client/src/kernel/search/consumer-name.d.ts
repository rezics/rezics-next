export type SearchConsumerFamily = 'subjects' | 'discovery';
/** Exact admitted `KERNEL_SEARCH_PREFIX`: 1–48 `[a-z0-9-]` characters, no final line terminator. */
export declare function isAdmittedSearchPrefix(prefix: string): boolean;
/** Native checkpoint identity for one prefix, generation and family. */
export declare function searchConsumerName(prefix: string, generation: number, family: SearchConsumerFamily): string;
export declare function subjectConsumer(prefix: string, generation: number): string;
export declare function discoveryConsumer(prefix: string, generation: number): string;
