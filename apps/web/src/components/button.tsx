import type { ButtonHTMLAttributes } from "react";

/**
 * Minimal button on the token action matrix (tokens.css v1.1). Rendered at
 * 44px so every surface satisfies the ≥44px hit-target law without invisible
 * padding extensions (design amendments round 2, rule 12).
 */
type Variant = "primary" | "secondary" | "ghost";

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-brand-600 text-ink-on-brand hover:bg-brand-700 active:bg-brand-800 " +
    "disabled:bg-neutral-050 disabled:text-ink-disabled disabled:cursor-not-allowed",
  secondary:
    "border border-border-strong bg-surface-card text-ink hover:bg-neutral-050 " +
    "active:bg-neutral-100 disabled:text-ink-disabled disabled:cursor-not-allowed",
  ghost: "text-link hover:bg-ghost-hover disabled:text-ink-disabled disabled:cursor-not-allowed",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({ variant = "primary", className, type, ...rest }: ButtonProps) {
  const classes = [
    "inline-flex h-11 items-center justify-center gap-2 rounded-2 px-4 text-body font-medium transition-colors duration-1",
    VARIANT_CLASSES[variant],
    className ?? "",
  ]
    .join(" ")
    .trim();
  return <button type={type ?? "button"} className={classes} {...rest} />;
}
