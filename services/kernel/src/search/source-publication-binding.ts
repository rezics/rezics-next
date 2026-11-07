import type { SearchSourcePublicationApplication } from './source-publication-application.ts';

let installed: SearchSourcePublicationApplication | undefined;

export function installSearchSourcePublicationApplication(application: SearchSourcePublicationApplication): void {
  installed = application;
}

export function searchSourcePublicationApplication(): SearchSourcePublicationApplication {
  if (!installed) throw new TypeError('Search Semantic source port is not installed');
  return installed;
}
