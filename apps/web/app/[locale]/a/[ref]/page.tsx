import ProfileRoute, { generateMetadata as metadata } from '../../[handle]/page.tsx';
import { profileIdentityParams } from '../../../../features/address/profile-params.ts';

type Props = { params: Promise<{ ref: string }> };
export const generateMetadata = (props: Props) => metadata({ params: profileIdentityParams(props.params) });
export default function Page(props: Props) { return ProfileRoute({ params: profileIdentityParams(props.params) }); }
