import { isUiLocale } from '../../../i18n/define.ts';
import { discoverSearchUrl } from '../../../features/search/redirect.ts';

/** Retired search bookmarks reach Discover directly with their selection intact. */
export async function GET(request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isUiLocale(locale)) return new Response(null, { status: 404 });
  return Response.redirect(discoverSearchUrl(new URL(request.url), locale), 301);
}

export const HEAD = GET;
