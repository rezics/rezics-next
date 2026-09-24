import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CreateWorkForm } from './create-work-form.tsx';

export default async function StudioPage() {
  const jar = await cookies();
  if (!jar.get('rezics_access')?.value) redirect('/sign-in?next=%2Fstudio');
  if (!jar.get('rezics_subject')?.value) redirect('/identity?next=%2Fstudio');
  return <main className="page-width"><div className="auth-layout"><h1>Create a Work</h1>
    <p className="muted">Start with a title. Contributions and Realm decisions can be added after creation.</p>
    <CreateWorkForm /></div></main>;
}
