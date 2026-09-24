import { safeReturnPath } from '../../features/auth/paths.ts';
import { SignInForm } from './sign-in-form.tsx';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <main className="page-width"><div className="auth-layout">
    <SignInForm next={safeReturnPath(next)} /></div></main>;
}
