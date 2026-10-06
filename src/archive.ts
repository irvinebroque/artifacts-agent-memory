import { readFile } from "./files";
import { ArtifactConflict, commitFiles } from "./git";

/** Archive actual conversation evidence; identical retries make no extra commit. */
export async function archiveSource(
  repo: ArtifactsRepo,
  path: string,
  record: unknown,
) {
  if (!path.startsWith("sessions/") && !path.startsWith(".platform/"))
    throw new Error("Invalid evidence path");
  const content = JSON.stringify(record, null, 2) + "\n";
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readFile(repo, path);
    if (current.content !== null) {
      if (current.content !== content)
        throw new Error(
          "An evidence ID cannot be reused with different content",
        );
      return;
    }
    try {
      await commitFiles(
        repo,
        current.head,
        [{ path, content }],
        `Archive ${path}`,
      );
      return;
    } catch (error) {
      if (!(error instanceof ArtifactConflict)) throw error;
    }
  }
  throw new Error("Artifact is busy; retry the archive");
}
