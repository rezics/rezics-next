/** Executed by the private Source receiver, rather than inferred from page size.
 * An exhausted-page recheck is the second verifier inside the Source fence; it is
 * not a Library finishScope/finalFence. Planning belongs to the Library participant.
 */
export const IDENTITY_SOURCE_ORIGINAL_SCHEDULE = Object.freeze({
  custodyAdvancements: 1,
  directoryPages: 1,
  source: Object.freeze({
    retainedDiscovery: 1,
    original: 1,
    acceptedBinding: 1,
    published: 2,
    participantReconcile: 3,
    prepare: 1,
    retainedFallback: 1,
    progress: 1,
    directory: 1,
    directoryRecheck: 1,
    scopeAdmission: 1,
    receivingSelection: 1,
    receivingReconcile: 1,
    receivingCommand: 1,
    checkpoint: 1,
    finish: 1,
    terminalVerify: 1,
    historyAuthority: 1,
    historyHandoff: 1,
  }),
  library: Object.freeze({
    discovery: 0,
    plannerSteps: 0,
    effectPages: 1,
    currentVerifications: 1,
    exhaustedPageRechecks: 1,
    finalFences: 0,
  }),
});
export type IdentitySourceLibraryOperation = keyof typeof IDENTITY_SOURCE_ORIGINAL_SCHEDULE.library;
export type IdentitySourceScheduledOperation = keyof typeof IDENTITY_SOURCE_ORIGINAL_SCHEDULE.source;
