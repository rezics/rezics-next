import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import type { ConceptState } from './state.ts';
import { readConceptWorks } from './works-read.ts';

/** Keep the server reader's audience for both restart and continuation. */
export function conceptWorksLoader(signedIn: boolean) {
  return (state: ConceptState, locale: UiLocale, cursor?: string) =>
    readConceptWorks(browserMainApi(undefined, { anonymous: !signedIn }), state, locale, cursor);
}
