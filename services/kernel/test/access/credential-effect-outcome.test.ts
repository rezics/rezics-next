import { setDefaultTimeout } from 'bun:test';

// Expiry is authoritative wall time: three retained openings each live up to 60s.
setDefaultTimeout(300_000);
process.env.NATIVE_CREDENTIAL_EFFECT_DRIVER_MODULE = new URL(
  './credential-effect-outcome-driver.ts',
  import.meta.url,
).href;
await import('../../../../specs/native-credential-effect-outcomes.test.ts');
