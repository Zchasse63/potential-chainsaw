/**
 * Error panel (design guide §6): states plainly what did NOT happen (the
 * `consequence` prop — e.g. "no charge was attempted"), offers retry, and
 * carries the reference/correlation id when the API provided one.
 *
 * The retry control renders the design-system Button's secondary variant
 * INLINE: Button itself stays in apps/web (Wave 8.1b scope — operator
 * surface), and packages/ui must not import from any app. The classes are
 * byte-identical to apps/web/src/components/button.tsx variant="secondary";
 * keep them in sync if that file changes.
 */
export function ErrorPanel({
  title,
  consequence,
  detail,
  correlationId,
  onRetry,
}: {
  title: string;
  consequence: string;
  detail?: string;
  correlationId?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="rounded-3 border border-danger-border bg-danger-tint p-4">
      <p className="text-body font-medium text-danger-on-tint">{title}</p>
      <p className="mt-1 text-body text-danger-on-tint">{consequence}</p>
      {detail !== undefined && <p className="mt-1 text-chrome text-danger-on-tint">{detail}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        {onRetry !== undefined && (
          <button
            type="button"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-2 px-4 text-body font-medium transition-colors duration-1 border border-border-strong bg-surface-card text-ink hover:bg-neutral-050 active:bg-neutral-100 disabled:text-ink-disabled disabled:cursor-not-allowed"
            onClick={onRetry}
          >
            Try again
          </button>
        )}
        {correlationId !== undefined && (
          <p className="font-mono text-chrome text-danger-on-tint">Reference {correlationId}</p>
        )}
      </div>
    </div>
  );
}
