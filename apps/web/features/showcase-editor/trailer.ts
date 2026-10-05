import { trailerEmbed } from '../showcase/stage.ts';

// A trailer is a link on the Work. Main normalizes YouTube and Bilibili watch links and keeps any
// other https link as it is; the stage opens a recognized video in a privacy-enhanced player on the
// page and everything else in a new tab. The editor says which, from the same function the stage uses.

/** Why a typed link cannot be a trailer before Main is asked, or null when Main should judge it. */
export function trailerProblem(text: string): 'empty' | 'not-https' | 'credentials' | 'too-long' | null {
  const value = text.trim();
  if (!value) return 'empty';
  if (value.length > 2048) return 'too-long';
  let url: URL;
  try { url = new URL(value); } catch { return 'not-https'; }
  if (url.protocol !== 'https:') return 'not-https';
  if (url.username || url.password) return 'credentials';
  return null;
}

/** How the stage opens a trailer link: in a player on the page (and whose), or on its own site in a new tab. */
export function trailerOpening(href: string): { kind: 'player'; provider: 'youtube' | 'bilibili' } | { kind: 'tab'; host: string } | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  const embed = trailerEmbed(href);
  if (embed) return { kind: 'player', provider: embed.includes('bilibili') ? 'bilibili' : 'youtube' };
  return { kind: 'tab', host: url.hostname };
}
