/**
 * @file version.mjs
 * @description Central version management and zero-dependency semver comparator for agent-mesh.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads the current package version from package.json.
 * @returns {string} Semver version string.
 */
function loadPackageVersion() {
  try {
    const pkgPath = join(import.meta.dirname, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "1.1.0";
  } catch {
    return "1.1.0";
  }
}

export const VERSION = loadPackageVersion();

/**
 * Parses a semver version string into its numeric components and optional prerelease tag.
 * @param {string} v - Version string (e.g. "1.1.0", "1.0.0-rc.1").
 * @returns {{ major: number, minor: number, patch: number, prerelease: string | null } | null}
 */
export function parseSemver(v) {
  if (typeof v !== "string") return null;
  const match = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
  };
}

/**
 * Zero-dependency semver comparator: returns true if version a is strictly less than version b.
 * - Compares major, minor, and patch numerically.
 * - When core numbers match, a version WITH a prerelease tag is less than a release without one (e.g. 1.0.0-rc.1 < 1.0.0).
 * - Missing or unparseable versions return false.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function semverLt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;

  if (pa.major !== pb.major) return pa.major < pb.major;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch;

  // Equal core numbers: check prerelease
  // 1.0.0-beta < 1.0.0
  if (pa.prerelease && !pb.prerelease) return true;
  if (!pa.prerelease && pb.prerelease) return false;
  if (pa.prerelease && pb.prerelease) return pa.prerelease < pb.prerelease;

  return false;
}
