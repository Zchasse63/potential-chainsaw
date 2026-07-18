/** Return only ASCII digits from a phone-like value. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Canonicalize a US phone number to E.164.
 *
 * Non-US, extended, short, long, and otherwise unrecognizable numbers return
 * null: under Kelo's US-only SMS guard they have no reliable SMS identity.
 */
export function toE164US(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = phoneDigits(raw);
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}
