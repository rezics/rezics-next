import type { Pool } from 'pg';
import type { PublicFilterSource } from './public-filter-source-contract.ts';
import type { SourceBindingApplication, SourceBindingApplicationPorts, SourceBindingConfiguration } from './source-binding-port.ts';
/** Construct one owner application for Source reads, binding, bootstrap and retained repair. */
export declare function createSourceBindingApplication(ports: SourceBindingApplicationPorts): SourceBindingApplication;
/** Installed only by native Semantic composition after its real owner producers are available. */
export declare function bindSourceBindingApplication(application: SourceBindingApplication): void;
export declare function sourceBindingApplication(): SourceBindingApplication;
/** Kept for callers that construct a Source before constructing a binding explicitly. */
export declare function publicFilterSourceOrigin(source: PublicFilterSource): SourceBindingConfiguration | undefined;
/** Read immutable Source custody through the Search capability installed with the native owner. */
export declare function readPublicFilterSourceDefinition(id: string, pool: Pool, routeDigest: string, maxBytes?: number): Promise<Readonly<{
    definition: import('./public-filter-source-binding.ts').PublicFilterSourceDefinition;
    bytes: number;
}>>;
