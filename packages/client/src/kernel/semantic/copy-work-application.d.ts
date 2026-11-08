import { type CopyWorkDisclosureObservation, type CopyWorkDisclosureRequest, type CopyWorkDisclosureState } from './copy-work-disclosure-contract.ts';
import type { CopyWorkDisclosureDependencies, CopyWorkReaderPort, CopyWorkListPresentationOptions } from './copy-work-reader-port.ts';
/** Copy-work disclosure orchestration; all current native reads remain explicit producer ports. */
export declare function readCopyWorkDisclosureWith(port: CopyWorkReaderPort, deps: CopyWorkDisclosureDependencies, request: CopyWorkDisclosureRequest): Promise<CopyWorkDisclosureObservation>;
export declare function createSemanticCopyWorkApplication(port: CopyWorkReaderPort): Readonly<{
    searchEvidence: Readonly<{
        validateHitOptions(request: {
            descriptions?: unknown;
            languages?: unknown;
            properties?: unknown;
        }): {
            languages?: readonly string[];
        };
        chooseTexts(values: readonly Readonly<{
            language: string;
            value: string;
        }>[], languages: readonly string[] | undefined, original: string | undefined, map?: (value: string) => string): Record<string, string>;
        pendingFacts(subject: Readonly<{
            statements: readonly import("./copy-work-reader-port.ts").CopyWorkIndexedStatement[];
        }>, properties: readonly string[]): Map<string, import("./copy-work-reader-port.ts").CopyWorkPendingFact[]>;
        workContext: Readonly<{
            limits: Readonly<{
                entries: number;
                lookahead: number;
                qualifiers: number;
                labelBytes: number;
                hitBytes: number;
                pageBytes: number;
            }>;
            bytes(value: unknown): number;
            kind(identities: readonly string[]): import("./copy-work-reader-port.ts").CopyWorkWorkKind;
        }>;
    }>;
    readCopyWorkDisclosure: (deps: CopyWorkDisclosureDependencies, request: CopyWorkDisclosureRequest) => Promise<Readonly<{
        results: ReadonlyMap<string, CopyWorkDisclosureState>;
        current: () => Promise<boolean>;
    }>>;
    readWorkReleaseCards: (input: Parameters<CopyWorkReaderPort['readWorkReleaseCards']>[0]) => Promise<import("./work-release-cards.ts").WorkReleaseCards>;
    createFacetPopulationSource: (config: Parameters<CopyWorkReaderPort['createFacetPopulationSource']>[0]) => Readonly<{
        readFacetPopulationPage: import("./facet-population-contract.ts").ReadFacetPopulationPage;
    }>;
    readListPresentationFacts: (deps: CopyWorkDisclosureDependencies, originals: readonly string[], options?: CopyWorkListPresentationOptions) => Promise<import("./copy-work-reader-port.ts").CopyWorkListPresentationResult>;
}>;
export type SemanticCopyWorkApplication = ReturnType<typeof createSemanticCopyWorkApplication>;
/** Runtime composition installs the concrete native readers and Search evidence exactly once per process boot. */
export declare function bindSemanticCopyWorkApplication(application: SemanticCopyWorkApplication): void;
export declare function semanticCopyWorkApplication(): SemanticCopyWorkApplication;
export declare const readCopyWorkDisclosure: (deps: CopyWorkDisclosureDependencies, request: CopyWorkDisclosureRequest) => Promise<Readonly<{
    results: ReadonlyMap<string, CopyWorkDisclosureState>;
    current: () => Promise<boolean>;
}>>;
export declare const readWorkReleaseCards: (...args: Parameters<SemanticCopyWorkApplication['readWorkReleaseCards']>) => Promise<import("./work-release-cards.ts").WorkReleaseCards>;
export declare const createFacetPopulationSource: (...args: Parameters<SemanticCopyWorkApplication['createFacetPopulationSource']>) => Readonly<{
    readFacetPopulationPage: import("./facet-population-contract.ts").ReadFacetPopulationPage;
}>;
export declare const readListPresentationFacts: (...args: Parameters<SemanticCopyWorkApplication['readListPresentationFacts']>) => Promise<import("./copy-work-reader-port.ts").CopyWorkListPresentationResult>;
export type { CopyWorkSearchEvidencePort, CopyWorkReaderPort } from './copy-work-reader-port.ts';
