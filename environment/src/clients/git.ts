import { execSync } from "node:child_process";

export function gitForEachRef(bareRepoPath: string): string[] {
  const out = execSync(
    `git -C "${bareRepoPath}" for-each-ref --format="%(refname:short)" refs/heads/`,
    { encoding: "utf-8" },
  );
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function gitShow(
  bareRepoPath: string,
  ref: string,
  filePath: string,
): string | undefined {
  try {
    return execSync(
      `git -C "${bareRepoPath}" show ${ref}:${filePath}`,
      { encoding: "utf-8" },
    );
  } catch {
    return undefined;
  }
}
