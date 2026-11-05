import { compileCatalogue } from '@rezics/definitions/compile';
import {
  fixture,
  libraryProfile,
  unitData,
} from '../../../../../packages/definitions/test/support/library-profiles.ts';

/** Every revision enters through source validation and the real compiler. */
export function compileSessionProfile(maximum = '10', precision = 2, capability: 'all' | 'removed' | 'absent' = 'all') {
  const profile = libraryProfile(`fixture.sessions-${maximum}-${precision}-${capability}`, 'minute');
  profile.progress.allowed = [
    { mode: 'scalar_amount', units: [{ ...unitData('minute'), maximum, precision }] },
    { mode: 'cursor_position', units: [unitData('marker', 'cursor_position')] },
    { mode: 'completed_units', units: [unitData('plot', 'completed_units')] },
  ];
  if (capability === 'removed') profile.progress.allowed.shift();
  if (capability === 'absent') delete profile.progress;
  return compileCatalogue(fixture(profile));
}

export const sessionScopes = [
  'subject:read',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'progress_session:update',
];
