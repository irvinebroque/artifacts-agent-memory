import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TREE_BYTES,
  repositoryPath,
} from "./format";

export type Edit = { path: string; content: string | null };
export type RepositoryPolicy = {
  readOnlyPrefixes?: readonly string[];
  requiredFiles?: readonly string[];
};

export class ArtifactConflict extends Error {
  constructor(public readonly head: string | null) {
    super(
      "Artifact changed. Reread the latest files and reconcile before committing.",
    );
  }
}

/** The binding reads Git objects; writes use a normal Git clone/commit/push. */
export async function commitFiles(
  repo: ArtifactsRepo,
  expectedHead: string | null,
  edits: Edit[],
  message: string,
  policy: RepositoryPolicy = {},
) {
  const info = await repo.info();
  const token = await repo.createToken("write", 300);
  try {
    const copy = await GitCheckout.open(
      info.remote,
      token.plaintext,
      expectedHead === null,
    );
    return { head: await copy.commit(expectedHead, edits, message, policy) };
  } catch (error) {
    const commits = await repo.log({
      ref: "main",
      limit: 1,
    });
    const latest = commits[0]?.hash ?? null;
    if (latest !== expectedHead) throw new ArtifactConflict(latest);
    throw error;
  } finally {
    await repo.revokeToken(token.id);
  }
}

/** Ephemeral working copy. Artifacts, rather than this filesystem, is durable. */
export class GitCheckout {
  readonly fs = createFsFromVolume(new Volume());
  readonly dir = "/memory";
  private constructor(
    private readonly remote: string,
    private readonly token: string,
  ) {}

  static async open(remote: string, token: string, empty = false) {
    const copy = new GitCheckout(remote, token);
    if (empty) {
      await git.init({ fs: copy.fs, dir: copy.dir, defaultBranch: "main" });
    } else {
      await git.clone({
        fs: copy.fs,
        http,
        dir: copy.dir,
        url: remote,
        ref: "main",
        singleBranch: true,
        depth: 1,
        onAuth: copy.auth,
      });
    }
    return copy;
  }

  // The expiry suffix is metadata, not part of the Git Basic auth password.
  private auth = () => ({
    username: "x",
    password: this.token.split("?expires=")[0],
  });

  async head(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
    } catch (error) {
      if (error instanceof git.Errors.NotFoundError) return null;
      throw error;
    }
  }

  async commit(
    expectedHead: string | null,
    edits: Edit[],
    message: string,
    policy: RepositoryPolicy = {},
  ) {
    const head = await this.head();
    if (head !== expectedHead) throw new ArtifactConflict(head);
    if (!edits.length || edits.length > 20)
      throw new Error("Commit requires 1–20 edits");
    if (!message.trim() || message.length > 240)
      throw new Error("Commit message must be 1–240 characters");
    const seen = new Set<string>();
    for (const edit of edits) {
      repositoryPath(edit.path);
      if (
        policy.readOnlyPrefixes?.some(
          (prefix) =>
            edit.path === prefix.replace(/\/$/, "") ||
            edit.path.startsWith(prefix),
        )
      ) {
        throw new Error("Path is read-only for this artifact capability");
      }
      if (seen.has(edit.path)) throw new Error("Duplicate path in commit");
      seen.add(edit.path);
      if (policy.requiredFiles?.includes(edit.path) && edit.content === null)
        throw new Error(`${edit.path} is required`);
      if (
        edit.content !== null &&
        new TextEncoder().encode(edit.content).length > MAX_FILE_BYTES
      ) {
        throw new Error("Artifact file exceeds 64 KiB");
      }
    }

    for (const { path, content } of edits) {
      if (content === null) {
        await git.remove({ fs: this.fs, dir: this.dir, filepath: path });
        await this.fs.promises
          .unlink(`${this.dir}/${path}`)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
      } else {
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (path.includes("/"))
          await this.fs.promises.mkdir(`${this.dir}/${parent}`, {
            recursive: true,
          });
        await this.fs.promises.writeFile(`${this.dir}/${path}`, content);
        await git.add({ fs: this.fs, dir: this.dir, filepath: path });
      }
    }
    const files = await git.listFiles({ fs: this.fs, dir: this.dir });
    for (const path of policy.requiredFiles ?? []) {
      if (!files.includes(path)) throw new Error(`${path} is required`);
    }
    if (files.length > MAX_FILES)
      throw new Error("Artifact tree exceeds 500 files");
    let size = 0;
    for (const path of files)
      size += Number((await this.fs.promises.stat(`${this.dir}/${path}`)).size);
    if (size > MAX_TREE_BYTES) throw new Error("Artifact tree exceeds 2 MiB");

    const changed = (
      await git.statusMatrix({ fs: this.fs, dir: this.dir })
    ).some(([, before, , staged]) => before !== staged);
    if (!changed && head) return head;
    const oid = await git.commit({
      fs: this.fs,
      dir: this.dir,
      message,
      author: {
        name: "Artifact agent",
        email: "memory@example.invalid",
      },
    });
    // Never force. Git's ref comparison also catches a write AFTER our clone.
    const pushed = await git.push({
      fs: this.fs,
      http,
      dir: this.dir,
      url: this.remote,
      ref: "main",
      onAuth: this.auth,
    });
    if (!pushed.ok || Object.values(pushed.refs).some((ref) => !ref.ok)) {
      throw new Error("Git rejected the artifact push");
    }
    return oid;
  }
}
