import { Button } from "./button.jsx";

/**
 * Error panel (design guide §6): states plainly what did NOT happen (the
 * `consequence` prop — e.g. "no charge was attempted"), offers retry, and
 * carries the reference/correlation id when the API provided one.
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
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
        {correlationId !== undefined && (
          <p className="font-mono text-chrome text-danger-on-tint">Reference {correlationId}</p>
        )}
      </div>
    </div>
  );
}
