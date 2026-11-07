import type { Access } from '../access/index.ts';
import type { Pool } from 'pg';
import type { PublicFilterSource } from './public-filter-source-contract.ts';
import type {
  SourceBindingApplication,
  SourceBindingApplicationPorts,
  SourceBindingConfiguration,
} from './source-binding-port.ts';

let installed: SourceBindingApplication | undefined;

/** Construct one owner application for Source reads, binding, bootstrap and retained repair. */
export function createSourceBindingApplication(ports: SourceBindingApplicationPorts): SourceBindingApplication {
  const origins = new WeakMap<PublicFilterSource, SourceBindingConfiguration>();

  const createSource = (config: SourceBindingConfiguration): PublicFilterSource => {
    const source = ports.native.createSource(config, createBinding, ports.search, ports.access);
    origins.set(source, Object.freeze({ ...config, routeKey: new Uint8Array(config.routeKey) }));
    return source;
  };

  const createBinding = (pool: Pool, routing: Uint8Array, access: Access) =>
    ports.native.createBinding(pool, routing, access, {
      search: ports.search,
      access: ports.access,
      sourceOrigin: (source) => origins.get(source),
      sourceFactory: createSource,
    });

  const readDefinition: SourceBindingApplication['readDefinition'] = (id, pool, routeDigest, maxBytes) =>
    ports.native.readDefinition(id, pool, routeDigest, ports.search, maxBytes);

  return Object.freeze({ createBinding, createSource, sourceOrigin: (source) => origins.get(source), readDefinition });
}

/** Installed only by native Semantic composition after its real owner producers are available. */
export function bindSourceBindingApplication(application: SourceBindingApplication): void {
  installed = application;
}

export function sourceBindingApplication(): SourceBindingApplication {
  if (!installed) throw new Error('Semantic Source binding application is not composed');
  return installed;
}

/** Kept for callers that construct a Source before constructing a binding explicitly. */
export function publicFilterSourceOrigin(source: PublicFilterSource): SourceBindingConfiguration | undefined {
  return installed?.sourceOrigin(source);
}

/** Read immutable Source custody through the Search capability installed with the native owner. */
export function readPublicFilterSourceDefinition(
  id: string,
  pool: Pool,
  routeDigest: string,
  maxBytes?: number,
) {
  return sourceBindingApplication().readDefinition(id, pool, routeDigest, maxBytes);
}
