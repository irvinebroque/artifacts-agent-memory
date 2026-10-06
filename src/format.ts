export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FILES = 500;
export const MAX_TREE_BYTES = 2 * 1024 * 1024;

export function repositoryPath(path: string): string {
  if (
    path.length > 240 ||
    !/^[a-zA-Z0-9_./-]+$/.test(path) ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error("Invalid repository-relative path");
  return path;
}

export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new Error(
      "IDs must contain 1–80 letters, digits, underscores, or hyphens",
    );
  return value;
}

export async function repoName(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId),
  );
  return `memory-${Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function seedMemory(displayName: string): Record<string, string> {
  const name = displayName
    .replace(/[\r\n\[\]<>#]/g, " ")
    .trim()
    .slice(0, 80);
  return {
    "MEMORY.md": `# Memory: ${name || "User"}\n\n## Index\n- [[preferences]]\n- [[projects/README]]\n`,
    "preferences.md": "# Preferences\n\n",
    "projects/README.md": "# Projects\n\n",
  };
}

export function sourcePath(sessionId: string, turnId: string): string {
  return `sessions/${identifier(sessionId)}/${identifier(turnId)}.json`;
}
