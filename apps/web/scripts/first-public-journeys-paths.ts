/** Performance first-public journey walk paths. The driver and capability table share this catalog. */
export const FIRST_PUBLIC_JOURNEY_PATHS = [
  {
    id: 'P01',
    title: 'Settings Profile edit, Save, private readback, leave/return with draft and focus',
    job: 'Open signed-in Settings Profile, edit, Save, read back the current private profile, leave and return with correct draft and focus recovery.',
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P02',
    title: 'Public profile save fields/view flags; read as owner, member and anonymous',
    job: 'Change admitted public profile fields and view flags, Save/read back, then view the immutable public profile as owner, another member and anonymous.',
    auth: 'mixed',
    owner: 'Accounts',
  },
  {
    id: 'P03',
    title: 'Safety managed-account directory, detail/profile, exact frontier/focus return',
    job: "Open Safety's managed-account directory, page to an admitted account, open its detail/profile and return to the exact directory frontier and focus.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P04',
    title: 'Settings security into native Auth security page and current-session return',
    job: "Follow Settings' account security action into the trusted native Auth security page and return using the current session.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P05',
    title: 'Settings rename into native Auth, complete rename, return to current identity',
    job: "Follow Settings' rename action into native Auth, complete the admitted rename and return to the current account identity.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P06',
    title: 'Settings deletion into native Auth deletion/recovery',
    job: "Follow Settings' deletion action into native Auth and complete the owner-admitted deletion/recovery path.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P07',
    title: 'Sign out, signed-out destination, uncertain-response session read',
    job: 'Sign out through the native action, reach the signed-out destination and recover an uncertain response through the current session read.',
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P08',
    title: 'Safety verification select, submit, revisit, withdraw, return',
    job: 'From Safety choose an eligible verification subject, submit, revisit and withdraw the exact request, then return to Safety with the current status.',
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P09',
    title: 'Notification preferences Save/readback and Reset',
    job: 'Open per-kind notification preferences, edit and Save/read back, then Reset/read back with compulsory kinds and current admission visible.',
    auth: 'signed-in',
    owner: 'Inbox',
  },
  {
    id: 'P10',
    title: 'Reading spoiler/suitability Save/readback, Reset/native defaults',
    job: 'Open Reading, Save/read back spoiler and suitability choices, then Reset and read back native defaults.',
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P11',
    title: 'Layout type override Save/readback, remove, resulting default',
    job: 'Open layout defaults, select a native type, Save/read back its override, remove it and read back the resulting default.',
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P12',
    title: 'Private Collections inventory/privacy Save/readback and version-conflict recovery',
    job: "Open Settings' private Collection inventory, change an admitted Collection's privacy, Save/read back and recover a current-version conflict for that same row.",
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P13',
    title: 'Inbox page reply/mention/moderation, destination, same-range return, acknowledge/badge',
    job: 'Open the in-app Inbox, page to a reply, mention or moderation notice, visit its admitted destination, return to the same range and acknowledge with the correct unread badge.',
    auth: 'signed-in',
    owner: 'Inbox',
  },
  {
    id: 'P14',
    title: 'Follow edge, page Following, target, original-frontier return, remove/replay',
    job: 'Follow a supported target, read and page the private Following list, visit the current target, return to the original frontier, remove the edge and recover its acknowledged replay.',
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P15',
    title: 'Labels create/select, assign, FULL assignment/shelf, exact removal/readback',
    job: 'Create or select an admitted label, assign it to a subject, read the FULL assignment and label shelf, then remove the exact assignment and read back.',
    auth: 'signed-in',
    owner: 'Library',
  },
  {
    id: 'P16',
    title: 'Active shelf page/session/target/return, complete or retire, updated shelf',
    job: 'Open the assigned active shelf, page to a session, follow its target and return, then complete or retire the session and read the updated shelf.',
    auth: 'signed-in',
    owner: 'Library',
  },
  {
    id: 'P17',
    title: 'Published Log publish, owner/member/anonymous snapshot, retract/Undo, My Logs return',
    job: 'Publish a session Log, read its public snapshot as owner/member/anonymous, retract and restore the eligible episode, and return to the captured private My Logs frontier under the current session.',
    auth: 'mixed',
    owner: 'Library',
  },
] as const;

export type JourneyId = (typeof FIRST_PUBLIC_JOURNEY_PATHS)[number]['id'];
export type JourneyAuth = (typeof FIRST_PUBLIC_JOURNEY_PATHS)[number]['auth'];
export type JourneyOwner = (typeof FIRST_PUBLIC_JOURNEY_PATHS)[number]['owner'];
export type JourneyStatus = 'PASS' | 'FAIL' | 'FAIL-unreached';
