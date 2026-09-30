import { typeRegistry, typeRegistryDigest } from '../../../../packages/model/src/generated/types.ts';
import { seedTypes, type TypeRegistry } from './types.ts';

// Stories and tests read the registry Main would serve, from the compiled source it serves it from.

/** The registry `GET /v1/types` answers with. */
export const servedTypes = { profile: 'types-v1', digest: typeRegistryDigest,
  types: Object.values(typeRegistry) } as TypeRegistry;

/** Seeds the module snapshot with it; call once before rendering or looking a type up. */
export const seedServedTypes = () => seedTypes(servedTypes);
