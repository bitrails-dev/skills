/**
 * @file agents-dir.mjs
 * @description The `.agents` convention as one shared concept. Many agent harnesses read skills (and some read
 * hooks/config) from `~/.agents` (global) and `<project>/.agents` (project). Descriptors declare how their
 * harness treats it (`agents` field); installers, doctor and discovery resolve locations only through here.
 *
 * `MESH_AGENTS_HOME` overrides the global directory (tests, relocated homes).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SKILL_NAME = "agent-mesh";

/** Global `.agents` directory (`~/.agents`). */
export const agentsHome = () => process.env.MESH_AGENTS_HOME || join(homedir(), ".agents");

/**
 * @param {"global"|"project"} scope
 * @param {string} [root] project root (project scope)
 */
export const agentsDir = (scope, root = process.cwd()) => (scope === "global" ? agentsHome() : join(root, ".agents"));

/** Path below the `.agents` directory of a scope. */
export const agentsPath = (scope, root, ...parts) => join(agentsDir(scope, root), ...parts);

/** Where the skills CLI places this skill for a scope. */
export const skillDir = (scope, root) => agentsPath(scope, root, "skills", SKILL_NAME);

/** True when the skill is present in the given scope's `.agents/skills`. */
export const skillInstalled = (scope, root) => existsSync(join(skillDir(scope, root), "SKILL.md"));

/**
 * What a descriptor may declare about the convention.
 * @typedef {object} AgentsSupport
 * @property {"both"|"project"|"user-import"|"none"} skills how the harness treats `.agents/skills`
 *   both: global + project are read; project: only `<project>/.agents/skills`; user-import: `~/.agents/skills`
 *   is only an import source; none: the harness uses its own directories
 * @property {boolean} config true when mesh writes this harness's hook/MCP config under `.agents` (project scope)
 * @property {"docs"|"binary"|"observed"|"unverified"} evidence where the claim comes from
 * @property {string} [note]
 */

/** Short label for doctor/guide output. */
export function describeAgentsSupport(support) {
  if (!support) return "unknown";
  const skills = { both: "reads ~/.agents/skills and .agents/skills", project: "reads .agents/skills (project only)", "user-import": "imports ~/.agents/skills on request", none: "uses its own skills directory" }[support.skills];
  return `${skills}${support.config ? "; mesh config under .agents" : ""} [${support.evidence}]`;
}
