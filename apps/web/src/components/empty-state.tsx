import type { ReactNode } from "react";

/**
 * Honest empty state (design guide §6): the body copy must say WHETHER the
 * emptiness is real or a sync problem — never a bare "nothing here".
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2 border border-hairline bg-surface-app px-4 py-8 text-center">
      <p className="text-body font-medium text-ink-secondary">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-body text-ink-muted">{body}</p>
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}
