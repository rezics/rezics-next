import { createNativePagePorts } from '../presentation/adapters/semantic-page.ts';
import {
  bindPageApplication,
  createPageApplication,
  presentationApplication,
  tryPresentationApplication,
  type PageApplication,
} from '../presentation/page-application.ts';

/** Ordinary server, worker and native preload bind Semantic, selected, profile and page-read producers. */
export function composePresentationApplication(): PageApplication {
  return bindPageApplication(createPageApplication(createNativePagePorts()));
}

export function composedPresentationApplication(): PageApplication {
  return tryPresentationApplication() ?? composePresentationApplication();
}

export { presentationApplication };
