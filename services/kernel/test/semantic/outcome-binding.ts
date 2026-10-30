import { createSemanticDriver as createNativeDriver } from './outcome-driver.ts';

/** The original capability suite exercises named account grants while public groups stay closed. */
export function createSemanticDriver() {
  return createNativeDriver(undefined, { originalCapabilities: true });
}
