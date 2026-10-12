/**
 * @file worktree.mjs
 * @description Git worktree manager for agent-mesh.
 * Isolates writing agents in dedicated worktrees to prevent dirty-tree collisions,
 * and handles Windows-specific file lock retries during removal.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Creates or verifies an isolated git worktree for a specific agent.
 * @param {string} repoRoot - Main repository root directory.
 * @param {string} agentName - Name of the agent (e.g. 'claude', 'opencode').
 * @param {string} [branchName] - Branch name, defaults to mesh/<agent>/workspace.
 * @returns {string} Absolute path to the agent's isolated worktree directory.
 */
export function ensureAgentWorktree(repoRoot, agentName, branchName = null) {
  const root = resolve(repoRoot);
  const wtDir = join(root, ".agent-mesh", "wt", agentName);
  const branch = branchName || `mesh/${agentName}/workspace`;

  // Ensure .agent-mesh is excluded locally via .git/info/exclude (H7)
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitDir) {
      const excludeFile = resolve(root, gitDir, "info", "exclude");
      mkdirSync(resolve(root, gitDir, "info"), { recursive: true });
      const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
      if (!current.includes(".agent-mesh")) {
        appendFileSync(excludeFile, "\n.agent-mesh\n.agent-mesh/**\n");
      }
    }
  } catch {}

  if (existsSync(wtDir)) {
    return wtDir;
  }

  mkdirSync(join(root, ".agent-mesh", "wt"), { recursive: true });

  try {
    // Check if the branch already exists
    let branchExists = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", branch], {
        cwd: root,
        stdio: "ignore",
      });
      branchExists = true;
    } catch {
      branchExists = false;
    }

    const args = ["worktree", "add"];
    if (!branchExists) {
      args.push("-b", branch);
    }
    args.push(wtDir);
    if (branchExists) {
      args.push(branch);
    }

    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return wtDir;
  } catch (err) {
    // Fall back to main repo root if worktree creation fails (e.g. not a git repo)
    return root;
  }
}

/**
 * Safely removes an agent's worktree with backoff retry for Windows file locks.
 * @param {string} repoRoot
 * @param {string} agentName
 * @param {number} [maxRetries=5]
 */
export async function removeAgentWorktree(repoRoot, agentName, maxRetries = 5) {
  const root = resolve(repoRoot);
  const wtDir = join(root, ".agent-mesh", "wt", agentName);

  if (!existsSync(wtDir)) return;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtDir], {
        cwd: root,
        stdio: "ignore",
      });
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to remove worktree at ${wtDir} after ${maxRetries} attempts: ${err.message}`);
      }
      // Wait for Windows file handles (antivirus, indexer) to release
      await new Promise((r) => setTimeout(r, attempt * 200));
    }
  }
}
