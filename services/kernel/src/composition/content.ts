import {
  ensureContentApplication,
  tryContentApplication,
  unbindContentApplication,
  createNativeContentRealmApplication,
  nativeRealmEvidenceHost,
  bindContentRealmApplication,
} from '../content/adapters/index.ts';
import { createRealmScopeEvidence } from '../community/adapters/index.ts';
import { createSubjectScopeEvidence } from '../semantic/adapters/index.ts';
import { withRealmDisclosureWork } from '../search/adapters/index.ts';
import type { ContentAmbient, ContentApplication } from '../content/contract/index.ts';

/** Ordinary server and worker composition bind the actual independent owner producers. */
export function composeContentApplication(ambient?: Partial<ContentAmbient>): ContentApplication {
  const application = ensureContentApplication(ambient ?? {});
  const parent = createRealmScopeEvidence(nativeRealmEvidenceHost);
  const subject = createSubjectScopeEvidence(nativeRealmEvidenceHost);
  bindContentRealmApplication(
    createNativeContentRealmApplication(
      {
        parent: parent.observe,
        subject: subject.observe,
        withWork(reader, work, maximum, run) {
          // Content refuses actorless readers before asking Search for a native ledger.
          return withRealmDisclosureWork(reader, work, maximum, run);
        },
      },
      application.ambient.now,
    ),
  );
  return application;
}

export function composedContentApplication(): ContentApplication {
  return composeContentApplication();
}
export function startContentApplication(ambient?: Partial<ContentAmbient>) {
  const application = composeContentApplication(ambient);
  return {
    application,
    stop() {
      if (tryContentApplication() === application) unbindContentApplication();
    },
  };
}
