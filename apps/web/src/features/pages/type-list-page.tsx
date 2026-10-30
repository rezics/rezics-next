import type { TypeListTarget } from './type-list-model';
import { findTypeList } from './type-list-model';
import type { SubjectPageData } from './subject';
import { PageData } from './data';
import { TypeList } from './type-list';
import { subjectPageMessages } from './route-support';

export function TypeListPage({
  page,
  target,
  node,
  locale,
}: {
  page: SubjectPageData;
  target: TypeListTarget;
  node: string;
  locale: string;
}) {
  const list = findTypeList(page.document, node);
  if (!list) return null;
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageData
        locale={locale}
        subject={page.subject}
        document={page.document}
        reads={page.reads}
        context={page.context}
        continuation={page.continuation}
        {...(page.account ? { account: page.account } : {})}
        listTarget={target}
        fullList={node}
        messages={subjectPageMessages()}
      >
        <TypeList {...list.props} />
      </PageData>
    </div>
  );
}
