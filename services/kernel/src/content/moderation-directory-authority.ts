import type { AccountActor } from "../request/access.ts";
import type { ModerationDirectoryScope } from "./moderation-directory-source.ts";

/** Local composition seam for absent foreign authority CURRENTNESS, not a
 * second permission evaluator. Access still evaluates every scope exactly.
 * A future installed owner supplies both rounds from its native frontier.
 */
export type ModerationDirectoryAuthority = Readonly<{
  epoch: string;
  /** Exclusive kernel-clock horizon, including scheduled transitions and bearer. */
  validUntil: number;
}>;
export type ModerationDirectoryAuthorityReader = (
  input: Readonly<{
    actor: AccountActor;
    scopes: readonly ModerationDirectoryScope[];
    coverage: string;
    deadline: number;
  }>,
) => Promise<ModerationDirectoryAuthority | null>;

/** Accounts has no admitted complete actor/principal-resource source on this
 * base; membership inverses and Access known-resource roles are insufficient.
 * No scans, repairs or permission flags manufacture its replacement.
 */
export const nativeModerationAuthorityUnavailable: ModerationDirectoryAuthorityReader =
  async () => null;
