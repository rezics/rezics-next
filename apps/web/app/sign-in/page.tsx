import { redirect } from 'next/navigation';
import { signInPath } from '../../features/auth/paths.ts';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ next?: string }>;
}) {
  redirect(signInPath((await searchParams).next));
}
