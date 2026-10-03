// Shared command errors retained by Main's central problem adapter. Address
// writes and alias normalization are owned by the registry and shared codec.
export {
  AliasInvalid as InvalidAddressClaim,
  AliasConflict as AddressClaimConflict,
  AliasUnavailable as AddressClaimUnavailable,
} from './registry.ts';
