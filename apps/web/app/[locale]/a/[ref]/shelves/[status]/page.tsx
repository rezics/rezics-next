import ProfileShelfRoute, { generateMetadata as metadata } from '../../../../[handle]/shelves/[status]/page.tsx';
import { profileIdentityParams } from '../../../../../../features/address/profile-params.ts';

type Props = { params: Promise<{ ref: string; status: string }>; searchParams: Promise<{ cursor?: string | string[] }> };
export const generateMetadata = (props: Props) => metadata({ ...props, params: profileIdentityParams(props.params) });
export default function Page(props: Props) { return ProfileShelfRoute({ ...props, params: profileIdentityParams(props.params) }); }
