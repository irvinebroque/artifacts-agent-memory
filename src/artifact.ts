import {
  GitCheckout,
  type Edit,
  type RepositoryPolicy,
  ArtifactConflict,
} from "./git";
import { MAX_FILE_BYTES, MAX_FILES, repositoryPath } from "./format";

export class ArtifactRepository {
  constructor(
    private readonly artifacts: Artifacts,
    readonly name: string,
    private readonly policy: RepositoryPolicy = {},
  ) {}

  async head(): Promise<string | null> {
    using repo = await this.artifacts.get(this.name);
    return (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? null;
  }

  async list(prefix = "") {
    if (prefix) repositoryPath(prefix.replace(/\/$/, ""));
    using repo = await this.artifacts.get(this.name);
    const commit = (await repo.log({ ref: "main", limit: 1 }))[0];
    if (!commit) return { head: null, paths: [] as string[] };
    const paths: string[] = [];
    let entriesSeen = 0;
    const walk = async (
      hash: string,
      prefix: string,
      depth: number,
    ): Promise<void> => {
      if (depth > 12) throw new Error("Artifact tree is too deep");
      for (const entry of (await repo.readTree(hash)) ?? []) {
        if (++entriesSeen > MAX_FILES * 4)
          throw new Error("Artifact tree is too large");
        const path = prefix + entry.name;
        if (entry.type === "tree")
          await walk(entry.hash, path + "/", depth + 1);
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

  async read(path: string, ref?: string) {
    repositoryPath(path);
    using repo = await this.artifacts.get(this.name);
    const head =
      ref ?? (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? null;
    const blob = head ? await repo.readFile({ ref: head, path }) : null;
    if (blob && blob.size > MAX_FILE_BYTES)
      throw new Error("File exceeds 64 KiB");
    return { head, path, content: blob ? await blob.text() : null };
  }

  async search(query: string, prefix = "") {
    if (!query.trim() || query.length > 200)
      throw new Error("Search requires 1–200 characters");
    const { head, paths } = await this.list(prefix);
    const matches: { path: string; line: number; text: string }[] = [];
    if (head)
      for (const path of paths) {
        const { content } = await this.read(path, head);
        for (const [line, text] of (content ?? "").split("\n").entries()) {
          if (text.toLowerCase().includes(query.toLowerCase()))
            matches.push({ path, line: line + 1, text });
          if (matches.length === 50) return { head, matches, truncated: true };
        }
      }
    return { head, matches, truncated: false };
  }

  async history() {
    using repo = await this.artifacts.get(this.name);
    return repo.log({ ref: "main", limit: 20 });
  }

  async commit(expectedHead: string | null, edits: Edit[], message: string) {
    using repo = await this.artifacts.get(this.name);
    const info = await repo.info();
    const token = await repo.createToken("write", 300);
    try {
      const copy = await GitCheckout.open(
        info.remote,
        token.plaintext,
        expectedHead === null,
      );
      return {
        head: await copy.commit(expectedHead, edits, message, this.policy),
      };
    } catch (error) {
      // Preserve genuine service/auth errors; only reclassify a changed remote.
      const latest = await this.head();
      if (latest !== expectedHead) throw new ArtifactConflict(latest);
      throw error;
    } finally {
      await repo.revokeToken(token.id);
    }
  }
}
