/**
 * Semantic-version comparison for the minimum-version gate.
 *
 * Versions are the app's `expo.version` strings ("0.3.0"). Anything that is
 * not three dot-separated integers is treated as 0 in the missing places, so
 * a malformed value can only ever make a build look OLDER, never newer -
 * the safe direction for a gate that decides whether to block.
 */
export function parseVersion(version: string | undefined | null): [number, number, number] {
  const parts = String(version ?? "")
    .trim()
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/**
 * Whether a build must update. The version is compared first; the build
 * number only matters when the versions are equal, which is the case this
 * app actually hits - several native builds have shipped as 0.3.0.
 */
export function isBelowMinimum(input: {
  version: string | undefined;
  build: number | undefined;
  minVersion: string;
  minBuild: number | null;
}): boolean {
  const byVersion = compareVersions(input.version, input.minVersion);
  if (byVersion < 0) return true;
  if (byVersion > 0) return false;
  if (input.minBuild === null || input.build === undefined) return false;
  return input.build < input.minBuild;
}
