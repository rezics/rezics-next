/** Performance first-public journey walk paths. The driver and capability table share this catalog. */
export const FIRST_PUBLIC_JOURNEY_PATHS = [
  {
    id: 'P01',
    job: 'Open signed-in Settings Profile, edit, Save, read back the current private profile, leave and return with correct draft and focus recovery.',
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P02',
    job: 'Change admitted public profile fields and view flags, Save/read back, then view the immutable public profile as owner, another member and anonymous.',
    auth: 'mixed',
    owner: 'Accounts',
  },
  {
    id: 'P03',
    job: "Open Safety's managed-account directory, page to an admitted account, open its detail/profile and return to the exact directory frontier and focus.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P04',
    job: "Follow Settings' account security action into the trusted native Auth security page and return using the current session.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P05',
    job: "Follow Settings' rename action into native Auth, complete the admitted rename and return to the current account identity.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P06',
    job: "Follow Settings' deletion action into native Auth and complete the owner-admitted deletion/recovery path.",
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P07',
    job: 'Sign out through the native action, reach the signed-out destination and recover an uncertain response through the current session read.',
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P08',
    job: 'From Safety choose an eligible verification subject, submit, revisit and withdraw the exact request, then return to Safety with the current status.',
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P09',
    job: 'Open per-kind notification preferences, edit and Save/read back, then Reset/read back with compulsory kinds and current admission visible.',
    auth: 'signed-in',
    owner: 'Inbox',
  },
  {
    id: 'P10',
    job: 'Open Reading, Save/read back spoiler and suitability choices, then Reset and read back native defaults.',
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P11',
    job: 'Open layout defaults, select a native type, Save/read back its override, remove it and read back the resulting default.',
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P12',
    job: "Open Settings' private Collection inventory, change an admitted Collection's privacy, Save/read back and recover a current-version conflict for that same row.",
    auth: 'signed-in',
    owner: 'Settings',
  },
  {
    id: 'P13',
    job: 'Open the in-app Inbox, page to a reply, mention or moderation notice, visit its admitted destination, return to the same range and acknowledge with the correct unread badge.',
    auth: 'signed-in',
    owner: 'Inbox',
  },
  {
    id: 'P14',
    job: 'Follow a supported target, read and page the private Following list, visit the current target, return to the original frontier, remove the edge and recover its acknowledged replay.',
    auth: 'signed-in',
    owner: 'Accounts',
  },
  {
    id: 'P15',
    job: 'Create or select an admitted label, assign it to a subject, read the FULL assignment and label shelf, then remove the exact assignment and read back.',
    auth: 'signed-in',
    owner: 'Library',
  },
  {
    id: 'P16',
    job: 'Open the assigned active shelf, page to a session, follow its target and return, then complete or retire the session and read the updated shelf.',
    auth: 'signed-in',
    owner: 'Library',
  },
  {
    id: 'P17',
    job: 'Publish a session Log, read its public snapshot as owner/member/anonymous, retract and restore the eligible episode, and return to the captured private My Logs frontier under the current session.',
    auth: 'mixed',
    owner: 'Library',
  },
] as const;

export type JourneyId = (typeof FIRST_PUBLIC_JOURNEY_PATHS)[number]['id'];
export type JourneyAuth = (typeof FIRST_PUBLIC_JOURNEY_PATHS)[number]['auth'];
export type JourneyOwner = (typeof FIRST_PUBLIC_JOURNEY_PATHS)[number]['owner'];
export type JourneyStatus = 'PASS' | 'FAIL' | 'FAIL-unreached';
