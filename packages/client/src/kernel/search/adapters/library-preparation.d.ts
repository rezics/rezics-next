/** Native Search producer for Library's retained preparation episode. */
import type { NativePreparationWorkFactory } from '../../library/adapters/index.ts';
import type { NativeScopeWork } from '../../library/adapters/index.ts';
import type { SearchLibraryScopePort } from '../library-scope-port.ts';
export declare function createNativeLibraryScopeWork(library: SearchLibraryScopePort): NativeScopeWork;
/** Compatibility binding used when composition has already constructed a Library capability. */
export declare const nativeLibraryScopeWork: NativeScopeWork;
/** Resolve the existing worker runtime at dispatch, after Search registration has installed it. */
export declare const createLibraryPreparationWork: NativePreparationWorkFactory;
