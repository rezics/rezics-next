import { UserRoundIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { buttonVariants } from '@rezics/ui/button';
import { signInPath } from '../../../../features/auth/paths.ts';
import { creatableTypes, entryLabel } from '../../../../features/catalogue/types.ts';
import { readTypes } from '../../../../features/catalogue/types-read.ts';
import { IntakeWizard } from '../../../../features/catalogue-intake/intake-wizard.tsx';
import { copyOf } from '../../../../features/catalogue-intake/messages.ts';
import { EmptyState } from '../../../../features/shell/empty-state.tsx';
import Link from '../../../../features/shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../../../../features/shell/page.tsx';
import { reader } from '../../../../features/work-page/read.ts';
import { localizedPath } from '../../../../i18n/locale.ts';
import { requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: copyOf(await requestLocale()).heading, robots: { index: false } };
}

/** `/catalogue/new`: search first, then say what to add. Main answers every step. */
export default async function CatalogueNewPage() {
  const locale = await requestLocale();
  const t = copyOf(locale);
  const [{ signedIn, actingSubject }] = await Promise.all([reader(), readTypes()]);
  return <PageContainer className="grid max-w-3xl gap-8">
    <PageHeader title={t.heading} description={t.intro} />
    {actingSubject ? <IntakeWizard actingSubject={actingSubject} locale={locale}
      types={creatableTypes().map(entry => ({ type: entry.type, label: entryLabel(entry, locale) }))} />
      : <EmptyState icon={UserRoundIcon} role="status" title={signedIn ? t.noIdentityTitle : t.signInTitle}
        description={signedIn ? t.noIdentityBody : t.signInBody}>
        {signedIn ? null : <Link href={signInPath(localizedPath('/catalogue/new', locale))}
          className={buttonVariants({ size: 'sm' })}>{t.signInButton}</Link>}
      </EmptyState>}
  </PageContainer>;
}
