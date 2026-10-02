// Display convention: a year is 365 days, matching the relative-date formatter.
const PERMANENT_LIFETIME_SECONDS = 100 * 365 * 24 * 60 * 60;
// Query results already decode block quantities as numbers.
const NEVER_EXPIRES = Number(0xffffffffffffffffn);

export function isPermanentLifetime(lifetimeBlocks: number, blockDurationSeconds: number): boolean {
  return Number.isFinite(lifetimeBlocks) && Number.isFinite(blockDurationSeconds) &&
    lifetimeBlocks > 0 && blockDurationSeconds > 0 &&
    lifetimeBlocks * blockDurationSeconds > PERMANENT_LIFETIME_SECONDS;
}

export function isPermanentEntity(
  createdAt: number | null,
  expiresAt: number | null,
  blockDurationSeconds: number | null,
): boolean {
  if (expiresAt === NEVER_EXPIRES) return true;
  if (createdAt === null || expiresAt === null || blockDurationSeconds === null) return false;
  return isPermanentLifetime(expiresAt - createdAt, blockDurationSeconds);
}
