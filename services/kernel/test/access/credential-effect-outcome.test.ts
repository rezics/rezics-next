import { setDefaultTimeout } from 'bun:test';

// Native Auth workflows retain their integration-test budget; expiry advances the kernel clock.
setDefaultTimeout(300_000);
process.env.NATIVE_CREDENTIAL_EFFECT_DRIVER_MODULE = new URL(
  './credential-effect-outcome-driver.ts',
  import.meta.url,
).href;
await import('../../../../specs/native-credential-effect-outcomes.test.ts');
