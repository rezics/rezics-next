import {
  ensureContentApplication,
  bindReadingPageCapabilities,
  createNativeReadingPageCapabilities,
  tryContentApplication,
  unbindContentApplication,
  createNativeContentRealmApplication,
  nativeRealmEvidenceHost,
  bindContentRealmApplication,
  bindFeedCapabilities,
  createNativeFeedCapabilities,
} from '../content/adapters/index.ts';
import { createNativeAccessReadingPorts } from '../access/adapters/index.ts';
import { createRealmScopeEvidence } from '../community/adapters/index.ts';
import { createSubjectScopeEvidence } from '../semantic/adapters/index.ts';
import { withRealmDisclosureWork } from '../search/adapters/index.ts';
import type { ContentAmbient, ContentApplication } from '../content/contract/index.ts';

/** The ordinary server, worker and native preload install real Access reading operands. */
export function composeContentReading(): void {
  bindReadingPageCapabilities(createNativeReadingPageCapabilities(createNativeAccessReadingPorts()));
}

/** Ordinary server and worker composition bind the actual independent owner producers. */
export function composeContentApplication(ambient?: Partial<ContentAmbient>): ContentApplication {
  composeContentReading();
  bindFeedCapabilities(createNativeFeedCapabilities());
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
