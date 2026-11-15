/** Compatibility entry for sign-in navigation. The local-address policy has one implementation. */
import { returnTarget } from '../reader/lifetime/contract';

export { returnTarget };

export function websiteSignInHref(destination: string): string {
  const target = returnTarget(destination, 'https://rezics.invalid');
  return `/auth/sign-in?return_to=${encodeURIComponent(target)}`;
}
