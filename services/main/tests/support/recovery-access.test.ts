import { expect, test } from 'bun:test';
import { AdmissionUnavailable } from '../../src/modules/access/admission.ts';
import { recoveryAccess } from './recovery-access.ts';

test('a closed or missing recovery fence refuses the shared access double', async () => {
  await expect(recoveryAccess({ open: false }).assertRecoveryOpen()).rejects.toBeInstanceOf(
    AdmissionUnavailable,
  );
  await expect(recoveryAccess({}).assertRecoveryOpen()).rejects.toBeInstanceOf(
    AdmissionUnavailable,
  );
  await expect(recoveryAccess().assertRecoveryOpen()).resolves.toBeUndefined();
});
