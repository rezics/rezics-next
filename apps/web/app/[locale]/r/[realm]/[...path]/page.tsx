import { zoneSiteMetadata, ZoneSiteRoute, type ZoneSiteProps } from '../../../../../features/zones/site-route.tsx';

export const generateMetadata = zoneSiteMetadata;

export default function ZoneSitePage(props: ZoneSiteProps) {
  return ZoneSiteRoute(props);
}
