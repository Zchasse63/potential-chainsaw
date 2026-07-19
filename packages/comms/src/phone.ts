/** Return only ASCII digits from a phone-like value. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** NANP structural validity: a US national number is NXX-NXX-XXXX where the
 * area code (NPA, position 1) and central-office/exchange code (NXX, position
 * 4) both start [2-9]. This rejects junk placeholders like 0000000000 and
 * numbers with 0/1-leading area or exchange codes, which are not dialable and
 * must never be treated as a real SMS identity. Mirror of the SQL
 * public.to_e164_us NANP guard — keep the two in exact lockstep. */
function isValidNanpNational(national: string): boolean {
  const npa = national[0];
  const nxx = national[3];
  return npa !== undefined && npa >= "2" && npa <= "9" && nxx !== undefined && nxx >= "2" && nxx <= "9";
}

/**
 * Canonicalize a US phone number to E.164.
 *
 * Non-US, extended, short, long, structurally-invalid (failing NANP), and
 * otherwise unrecognizable numbers return null: under Kelo's US-only SMS guard
 * they have no reliable SMS identity.
 */
export function toE164US(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = phoneDigits(raw);
  let national: string | null = null;
  if (digits.length === 11 && digits.startsWith("1")) national = digits.slice(1);
  else if (digits.length === 10) national = digits;
  if (national === null || !isValidNanpNational(national)) return null;
  return `+1${national}`;
}
