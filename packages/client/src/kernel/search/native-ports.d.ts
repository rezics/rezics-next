import type { SearchAccessSourcePort } from './access-source-port.ts';
import type { SearchContentSourcePort } from './content-source-port.ts';
import type { SearchLibraryNativePort } from './library-native-port.ts';
import type { SearchSemanticSourcePort } from './semantic-source-port.ts';
/** Installed natives for Search Source, publication, scope, discovery and identity receiving. */
export type SearchNativePorts = Readonly<SearchSemanticSourcePort & SearchAccessSourcePort & SearchLibraryNativePort & SearchContentSourcePort>;
