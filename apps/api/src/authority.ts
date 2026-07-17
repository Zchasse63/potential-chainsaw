/**
 * Authority matrix (plan-final §1 "authority registry": per capability,
 * glofox_authoritative → kelo_with_writeback → kelo_only → retired).
 *
 * TODO(phase 4/7): this is a CONSTANT until the authority_states table ships
 * with write-back — /health must then read the tenant's real per-capability
 * rows instead. During coexistence every capability is Glofox-authoritative:
 * reads AND writes point at Glofox, cadence follows the import schedule
 * (plan-final §4: hourly baseline; 15-minute roster during operating hours),
 * and no cutover is scheduled.
 */
export interface AuthorityEntry {
  capability: string;
  read_source: "glofox";
  write_source: "glofox";
  state: "glofox_authoritative";
  cadence: string;
  cutover: null;
}

const HOURLY = "hourly";
const ROSTER = "15m during operating hours, hourly otherwise";

export const AUTHORITY_MATRIX: readonly AuthorityEntry[] = [
  {
    capability: "people",
    read_source: "glofox",
    write_source: "glofox",
    state: "glofox_authoritative",
    cadence: HOURLY,
    cutover: null,
  },
  {
    capability: "marketing",
    read_source: "glofox",
    write_source: "glofox",
    state: "glofox_authoritative",
    cadence: HOURLY,
    cutover: null,
  },
  {
    capability: "scheduling",
    read_source: "glofox",
    write_source: "glofox",
    state: "glofox_authoritative",
    cadence: ROSTER,
    cutover: null,
  },
  {
    capability: "booking",
    read_source: "glofox",
    write_source: "glofox",
    state: "glofox_authoritative",
    cadence: ROSTER,
    cutover: null,
  },
  {
    capability: "payments",
    read_source: "glofox",
    write_source: "glofox",
    state: "glofox_authoritative",
    cadence: HOURLY,
    cutover: null,
  },
];
