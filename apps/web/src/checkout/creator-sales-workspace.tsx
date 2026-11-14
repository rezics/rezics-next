import type { ReactNode } from 'react';

type Props = {
  context: ReactNode;
  browsing: ReactNode;
  inspection?: ReactNode;
  evidence?: ReactNode;
};

/** Keep the supplied page context, received rows and selected sale in one responsive workspace. */
export function CreatorSalesWorkspace({ context, browsing, inspection, evidence }: Props) {
  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0 space-y-5">{context}</div>
      <div
        className={
          inspection
            ? 'grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(22rem,1fr)]'
            : 'min-w-0'
        }
      >
        <div className="min-w-0 space-y-5">{browsing}</div>
        {inspection && <div className="min-w-0">{inspection}</div>}
      </div>
      {evidence && <div className="min-w-0">{evidence}</div>}
    </div>
  );
}
