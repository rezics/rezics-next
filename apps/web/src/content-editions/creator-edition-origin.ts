const CREATOR_EDITION_ORIGIN_QUERY = "editionOrigin";
const CREATOR_EDITION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CreatorEditionOriginReceipt = {
  token: string;
  accountId: string;
  locale: string;
  cursor: string | null;
  editionId: string | null;
};

export type CreatorEditionOriginResolution =
  | { kind: "current"; receipt: CreatorEditionOriginReceipt }
  | { kind: "lost"; reason: "missing" | "replaced" | "account" | "locale" | "edition" };

// The receipt intentionally lives for this tab's current JavaScript lifetime only.
// URLs carry its opaque token, never its cursor, account, or Edition identity.
let activeCreatorEditionOrigin: CreatorEditionOriginReceipt | null = null;

export function creatorEditionLocale(): string {
  const language = getLocale().toLowerCase();
  if (language === "zh-hant" || language === "zh-tw" || language === "zh-hk") return "zh-Hant";
  if (language === "zh-hans" || language === "zh-cn" || language === "zh-sg") return "zh-Hans";
  if (language.startsWith("ja")) return "ja";
  if (language.startsWith("de")) return "de";
  if (language.startsWith("es")) return "es";
  if (language.startsWith("fr")) return "fr";
  if (language.startsWith("ko")) return "ko";
  return "en";
}

export function createCreatorEditionOrigin(input: {
  accountId: string;
  cursor: string | null;
  editionId: string | null;
}): string | null {
  if (!input.accountId || (input.editionId && !CREATOR_EDITION_ID.test(input.editionId))) return null;
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") return null;
  const token = crypto.randomUUID();
  activeCreatorEditionOrigin = {
    token,
    accountId: input.accountId,
    locale: creatorEditionLocale(),
    cursor: input.cursor,
    editionId: input.editionId,
  };
  return token;
}

export function readCreatorEditionOrigin(
  token: string | null | undefined,
  accountId: string | null | undefined,
  expectedEditionId?: string | null,
): CreatorEditionOriginResolution {
  if (!token || token !== activeCreatorEditionOrigin?.token) return { kind: "lost", reason: "missing" };
  const receipt = activeCreatorEditionOrigin;
  if (!accountId || receipt.accountId !== accountId) {
    activeCreatorEditionOrigin = null;
    return { kind: "lost", reason: "account" };
  }
  if (receipt.locale !== creatorEditionLocale()) {
    activeCreatorEditionOrigin = null;
    return { kind: "lost", reason: "locale" };
  }
  if (expectedEditionId && receipt.editionId && expectedEditionId !== receipt.editionId) {
    activeCreatorEditionOrigin = null;
    return { kind: "lost", reason: "edition" };
  }
  return { kind: "current", receipt };
}

export function bindCreatorEditionOriginEdition(token: string, editionId: string): boolean {
  const receipt = activeCreatorEditionOrigin;
  if (!receipt || receipt.token !== token || !CREATOR_EDITION_ID.test(editionId)) return false;
  if (receipt.editionId && receipt.editionId !== editionId) {
    activeCreatorEditionOrigin = null;
    return false;
  }
  activeCreatorEditionOrigin = { ...receipt, editionId };
  return true;
}

export function restartCreatorEditionOrigin(token: string): CreatorEditionOriginReceipt | null {
  const receipt = activeCreatorEditionOrigin;
  if (!receipt || receipt.token !== token) return null;
  activeCreatorEditionOrigin = { ...receipt, cursor: null };
  return activeCreatorEditionOrigin;
}

export function retireCreatorEditionOrigin(token?: string | null): void {
  if (!token || activeCreatorEditionOrigin?.token === token) activeCreatorEditionOrigin = null;
}

export function creatorEditionOriginTokenFromSearch(search: string | Record<string, unknown>): string | null {
  const value =
    typeof search === 'string' ? new URLSearchParams(search).get(CREATOR_EDITION_ORIGIN_QUERY) : search.editionOrigin;
  const token = typeof value === 'string' ? value : null;
  return token && token.length <= 64 ? token : null;
}

export function addCreatorEditionOriginToken(href: string, token: string): string {
  const [address, hash = ""] = href.split("#", 2);
  const separator = address.includes("?") ? "&" : "?";
  return `${address}${separator}${CREATOR_EDITION_ORIGIN_QUERY}=${encodeURIComponent(token)}${hash ? `#${hash}` : ""}`;
}

export function creatorEditionOriginReturnHref(receipt: CreatorEditionOriginReceipt): string {
  const search = new URLSearchParams();
  if (receipt.cursor) search.set("cursor", receipt.cursor);
  search.set(CREATOR_EDITION_ORIGIN_QUERY, receipt.token);
  return localizeHref(`/editions?${search.toString()}#creator-editions-inventory`);
}
import { getLocale, localizeHref } from "../paraglide/runtime.js";

