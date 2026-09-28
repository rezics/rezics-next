// A plain module, not a client one: Server Components read these values too,
// and a 'use client' module's exports reach them only as client references.
export type AccountSection = 'home' | 'personal-info' | 'security' | 'connected-apps' | 'data-privacy';

export const sectionPaths: Record<AccountSection, string> = { home: '/', 'personal-info': '/personal-info',
  security: '/security', 'connected-apps': '/connected-apps', 'data-privacy': '/data-privacy' };

/** Focused pages inside a section, linked from more than one place. */
export const focusedPaths = { checkup: '/security/checkup', devices: '/security/devices',
  activity: '/security/activity', secureAccount: '/security/secure-account', passkeys: '/security/passkeys',
  twoStep: '/security/two-step-verification', download: '/data-privacy/download',
  deleteAccount: '/data-privacy/delete-account' } as const;
