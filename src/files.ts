import { MAX_FILE_BYTES, MAX_FILES, repositoryPath } from "./format";

// These functions traverse Git trees and turn binding Blobs into tool results.
// Every caller supplies the native ArtifactsRepo handle.
export async function readFile(
  repo: ArtifactsRepo,
  path: string,
  ref?: string,
) {
  repositoryPath(path);
  const commits = ref ? null : await repo.log({ ref: "main", limit: 1 });
  const head = ref ?? commits?.[0]?.hash ?? null;
  const file = head ? await repo.readFile({ ref: head, path }) : null;
  if (file && file.size > MAX_FILE_BYTES)
    throw new Error("File exceeds 64 KiB");
  return { head, path, content: file ? await file.text() : null };
}

export async function listFiles(repo: ArtifactsRepo, prefix = "") {
  if (prefix) repositoryPath(prefix.replace(/\/$/, ""));
  const commits = await repo.log({
    ref: "main",
    limit: 1,
  });
  const commit = commits[0];
  if (!commit) return { head: null, paths: [] as string[] };
  const paths: string[] = [];
  let entriesSeen = 0;
  const walk = async (
    hash: string,
    parent: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 12) throw new Error("Artifact tree is too deep");
    const entries = await repo.readTree(hash);
    for (const entry of entries ?? []) {
      if (++entriesSeen > MAX_FILES * 4)
        throw new Error("Artifact tree is too large");
      const path = parent + entry.name;
      if (entry.type === "tree") await walk(entry.hash, path + "/", depth + 1);
      else if (entry.type === "blob" || entry.type === "exec") {
        paths.push(path);
        if (paths.length > MAX_FILES)
          throw new Error("Artifact tree exceeds 500 files");
      }
    }
  };
  await walk(commit.treeHash, "", 0);
  return {
    head: commit.hash,
    paths: paths.filter((path) => path.startsWith(prefix)).sort(),
  };
}

export async function searchFiles(
  repo: ArtifactsRepo,
  query: string,
  prefix = "",
) {
  if (!query.trim() || query.length > 200)
    throw new Error("Search requires 1–200 characters");
  const { head, paths } = await listFiles(repo, prefix);
  const matches: { path: string; line: number; text: string }[] = [];
  if (head)
    for (const path of paths) {
      const { content } = await readFile(repo, path, head);
      for (const [line, text] of (content ?? "").split("\n").entries()) {
        if (text.toLowerCase().includes(query.toLowerCase()))
          matches.push({ path, line: line + 1, text });
        if (matches.length === 50) return { head, matches, truncated: true };
      }
    }
  return { head, matches, truncated: false };
}
