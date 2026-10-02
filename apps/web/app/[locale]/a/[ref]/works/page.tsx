import ProfileWorksRoute, { generateMetadata as metadata } from '../../../[handle]/works/page.tsx';
import { profileIdentityParams } from '../../../../../features/address/profile-params.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<{ cursor?: string | string[] }> };
export const generateMetadata = (props: Props) => metadata({ ...props, params: profileIdentityParams(props.params) });
export default function Page(props: Props) { return ProfileWorksRoute({ ...props, params: profileIdentityParams(props.params) }); }
