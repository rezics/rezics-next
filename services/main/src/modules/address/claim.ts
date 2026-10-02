// Shared command errors retained by Main's central problem adapter. Address
// writes and name normalization are owned by the registry and shared codec.
export {
  NameInvalid as InvalidAddressClaim,
  NameConflict as AddressClaimConflict,
  NameUnavailable as AddressClaimUnavailable,
} from './registry.ts';
