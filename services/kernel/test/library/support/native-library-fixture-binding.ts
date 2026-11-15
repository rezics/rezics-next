import {
  bindLibraryDomain,
  composeLibraryDomain,
  peekLibraryDomain,
  unbindLibraryDomain,
} from '../../../src/composition/library.ts';
import { bindLibraryPresentation, peekLibraryPresentation } from '../../../src/library/domain-binding.ts';

/** Install real Library producers for an Access fixture and restore only the binding it owns. */
export function bindNativeLibraryFixture(options: Parameters<typeof composeLibraryDomain>[0]): () => void {
  const previousDomain = peekLibraryDomain();
  const previousPresentation = peekLibraryPresentation();
  const installed = composeLibraryDomain(options);
  return () => {
    if (peekLibraryDomain() !== installed) return;
    if (previousDomain) bindLibraryDomain(previousDomain);
    else {
      unbindLibraryDomain();
      if (previousPresentation) bindLibraryPresentation(previousPresentation);
    }
  };
}
