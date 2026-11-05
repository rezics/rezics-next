type SubmittedProfile = { client_id: string; scope: readonly string[] };

/** Build the native acknowledgement from the exact profile sent by the installed caller. */
export function nativeSignInProof(
  profile: SubmittedProfile,
  method: 'pwd' | 'pop' = 'pwd',
  accountId = 'acct-signin-fixture',
) {
  return {
    account_id: accountId,
    client_id: profile.client_id,
    scope: [...new Set(profile.scope)].sort(),
    authn_epoch: 2,
    auth_time: 1_700_000_000,
    amr: [method],
  };
}

/** The pinned discoverable ceremony DTO: 32 bytes of challenge, required UV and the configured RP. */
export function nativeSignInOptions(challenge = 'A'.repeat(43)) {
  return { rpId: 'rezics.com' as const, challenge, timeout: 60000 as const, userVerification: 'required' as const };
}
