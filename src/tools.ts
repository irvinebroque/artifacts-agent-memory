import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { readFile, listFiles, searchFiles } from "./files";
import { ArtifactConflict, commitFiles } from "./git";

const Read = Type.Object({
  action: Type.Union([
    Type.Literal("read"),
    Type.Literal("list"),
    Type.Literal("search"),
    Type.Literal("history"),
  ]),
  path: Type.Optional(Type.String()),
  prefix: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
});
const Commit = Type.Object({
  expectedHead: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  message: Type.String({ minLength: 1, maxLength: 240 }),
  edits: Type.Array(
    Type.Object({
      path: Type.String(),
      content: Type.Union([Type.String(), Type.Null()]),
    }),
    { minItems: 1, maxItems: 20 },
  ),
});
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** Pi tool definitions for the repository chosen by the platform. */
export function artifactTools(
  getRepo: () => Promise<ArtifactsRepo>,
): Extension {
  const read: ToolRegistration<typeof Read> = {
    name: "artifact",
    description:
      "Read files, list paths by prefix, search text, or inspect Git history in the attached artifact repository.",
    parameters: Read,
    replay: "safe",
    async execute(args) {
      using repo = await getRepo();
      switch (args.action) {
        case "read":
          if (!args.path) throw new Error("Read requires a repository path");
          return result(await readFile(repo, args.path, args.ref));
        case "list":
          return result(await listFiles(repo, args.prefix));
        case "search":
          return result(await searchFiles(repo, args.query ?? "", args.prefix));
        case "history": {
          const commits = await repo.log({
            ref: "main",
            limit: 20,
          });
          return result(commits);
        }
      }
    },
  };
  const commit: ToolRegistration<typeof Commit> = {
    name: "artifact_commit",
    description:
      "Commit and push file edits atomically to the attached repository. Use the head from a read as expectedHead; on conflict, reread and reconcile. Null content deletes a file.",
    parameters: Commit,
    replay: "unsafe",
    executionMode: "sequential",
    async execute({ expectedHead, edits, message }) {
      using repo = await getRepo();
      try {
        return result(
          await commitFiles(repo, expectedHead, edits, message, {
            // Evidence is platform-written. The agent edits the curated notes.
            readOnlyPrefixes: ["sessions/", ".platform/"],
            requiredFiles: ["MEMORY.md"],
          }),
        );
      } catch (error) {
        if (error instanceof ArtifactConflict)
          return result({
            conflict: true,
            head: error.head,
            message: error.message,
          });
        throw error;
      }
    },
  };
  // No memory-specific operations, user selectors, or credentials in the schema.
  return { name: "artifact-repository", tools: [read, commit] };
}
