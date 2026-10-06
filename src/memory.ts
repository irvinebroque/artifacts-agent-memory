import type { Extension } from "@earendil-works/pi-durable";
import { ArtifactRepository } from "./artifact";
import { ArtifactConflict, type RepositoryPolicy } from "./git";
import { seedMemory } from "./format";

/** Platform policy for this use of an otherwise generic artifact tool. */
export const memoryPolicy: RepositoryPolicy = {
  readOnlyPrefixes: ["sessions/", ".platform/"],
  requiredFiles: ["MEMORY.md"],
};

export function memoryContext(
  artifact: () => ArtifactRepository,
  context: () => string | Promise<string>,
): Extension {
  return {
    name: "memory-context",
    sections: [
      { key: "memory-context", render: context },
      {
        key: "memory-entry",
        render: async () => JSON.stringify(await artifact().read("MEMORY.md")),
      },
    ],
  };
}

export async function seedArtifact(
  artifact: ArtifactRepository,
  displayName: string,
) {
  if (await artifact.head()) return;
  await artifact.commit(
    null,
    Object.entries(seedMemory(displayName)).map(([path, content]) => ({
      path,
      content,
    })),
    "Seed user memory",
  );
}

/** Platform-written evidence. Agents only receive a capability with memoryPolicy. */
export async function archiveSource(
  artifact: ArtifactRepository,
  path: string,
  record: unknown,
) {
  if (!path.startsWith("sessions/") && !path.startsWith(".platform/"))
    throw new Error("Invalid evidence path");
  const content = JSON.stringify(record, null, 2) + "\n";
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await artifact.read(path);
    if (current.content !== null) {
      if (current.content !== content)
        throw new Error(
          "An evidence ID cannot be reused with different content",
        );
      return;
    }
    try {
      await artifact.commit(
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
