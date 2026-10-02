import { zoneSiteMetadata, ZoneSiteRoute, type ZoneSiteProps } from '../../../../../features/zones/site-route.tsx';

export const generateMetadata = zoneSiteMetadata;
export default function Page(props: ZoneSiteProps) { return ZoneSiteRoute(props); }
