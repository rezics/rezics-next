import { VerifyEmailResult } from '../../../features/auth/verify-email-result.tsx';
import { AuthFrame } from '../../../features/shell/auth-frame.tsx';
import { type PageSearchParams, pageQuery } from '../../../features/shell/search-params.ts';

export default async function VerifyEmailPage({ searchParams }: { searchParams: PageSearchParams }) {
  const query = await pageQuery(searchParams);
  return <AuthFrame><VerifyEmailResult failed={query.has('error')} /></AuthFrame>;
}
