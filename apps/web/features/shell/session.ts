/**
 * What the shell shows about a signed-in session. The session layer maps its own
 * session read onto this; the shell never reads cookies or tokens itself.
 */
export interface ShellSession {
  /** Account display name; the avatar falls back to its initial, then an icon. */
  name?: string;
  email?: string;
  avatarUrl?: string;
  /** The Agent this browser session acts as, once one is chosen. */
  agent?: { id: string; label: string };
}
