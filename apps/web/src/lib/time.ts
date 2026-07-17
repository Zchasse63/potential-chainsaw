/**
 * Timestamp formatting per UX plan §4 copy rules: relative under 24h,
 * absolute after; timezone labeling is ONE page-level label (design
 * amendments round 2, rule 10), not per value.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "Unknown time";
  }
  const diff = now.getTime() - ms;
  if (diff < MINUTE) {
    return "just now";
  }
  if (diff < HOUR) {
    const minutes = Math.floor(diff / MINUTE);
    return `${minutes} min ago`;
  }
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    return `${hours} hr ago`;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

/**
 * The single page-level timezone label. Phase 0 has no tenant-settings
 * endpoint exposing the studio timezone, so times are honestly labeled as
 * the device's — never implied to be studio time.
 */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
