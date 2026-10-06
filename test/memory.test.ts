import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GitCheckout, ArtifactConflict } from "../src/git";
import { repositoryPath, repoName } from "../src/format";
import { gitServer } from "./git-server";

const memoryPolicy = {
  readOnlyPrefixes: ["sessions/", ".platform/"],
  requiredFiles: ["MEMORY.md"],
};

describe("Artifacts Git memory flow", () => {
  let server: Awaited<ReturnType<typeof gitServer>>;
  let head: string;
  beforeEach(async () => {
    server = await gitServer();
    const copy = await GitCheckout.open(server.remote, server.token, true);
    head = await copy.commit(
      null,
      [
        {
          path: "MEMORY.md",
          content:
            "# Memory: Alice\n\n## Index\n- [[preferences]]\n- [[projects/README]]\n",
        },
        { path: "preferences.md", content: "# Preferences\n\n" },
        { path: "projects/README.md", content: "# Projects\n\n" },
      ],
      "Seed",
    );
  });
  afterEach(async () => {
    await server?.close();
  });

  test("a fresh session retrieves facts from the remote, including index links", async () => {
    const first = await GitCheckout.open(server.remote, server.token);
    const preferences =
      "# Preferences\n\n- Alice prefers short summaries [source: artifact://sessions/first/t1.json; added: 2026-10-06]\n";
    const saved = await first.commit(
      head,
      [{ path: "preferences.md", content: preferences }],
      "Remember preference",
    );
    const second = await GitCheckout.open(server.remote, server.token);
    expect(await second.head()).toBe(saved);
    expect(
      await second.fs.promises.readFile("/memory/preferences.md", "utf8"),
    ).toBe(preferences);
    expect(
      await second.fs.promises.readFile("/memory/MEMORY.md", "utf8"),
    ).toContain("[[preferences]]");
  });

  test("a stale read cannot overwrite a newer commit", async () => {
    const first = await GitCheckout.open(server.remote, server.token);
    const updated = await first.commit(
      head,
      [{ path: "preferences.md", content: "# New fact\n" }],
      "New fact",
    );
    const stale = await GitCheckout.open(server.remote, server.token);
    await expect(
      stale.commit(
        head,
        [{ path: "preferences.md", content: "# Stale fact\n" }],
        "Stale",
      ),
    ).rejects.toBeInstanceOf(ArtifactConflict);
    expect(await stale.head()).toBe(updated);
  });

  test("Git rejects a concurrent push after both agents cloned the same head", async () => {
    const live = await GitCheckout.open(server.remote, server.token);
    const dreamer = await GitCheckout.open(server.remote, server.token);
    const winner = await live.commit(
      head,
      [{ path: "preferences.md", content: "# User correction\n" }],
      "Live correction",
    );
    await expect(
      dreamer.commit(
        head,
        [{ path: "preferences.md", content: "# Outdated dream\n" }],
        "Dream",
      ),
    ).rejects.toThrow();
    const fresh = await GitCheckout.open(server.remote, server.token);
    expect(await fresh.head()).toBe(winner);
    expect(
      await fresh.fs.promises.readFile("/memory/preferences.md", "utf8"),
    ).toBe("# User correction\n");
  });

  test("multi-file edits commit together and unchanged retries create no duplicate commit", async () => {
    const copy = await GitCheckout.open(server.remote, server.token);
    const edits = [
      {
        path: "projects/payments.md",
        content: "# Payments\n\n- Launch in October\n",
      },
      {
        path: "MEMORY.md",
        content: "# Memory: Alice\n\n## Index\n- [[projects/payments]]\n",
      },
    ];
    const oid = await copy.commit(head, edits, "Remember project and link");
    const fresh = await GitCheckout.open(server.remote, server.token);
    expect(await fresh.commit(oid, edits, "Retry")).toBe(oid);
    expect(
      await fresh.fs.promises.readFile("/memory/projects/payments.md", "utf8"),
    ).toContain("Launch");
  });

  test("agents cannot modify evidence, escape the memory root, or delete MEMORY.md", async () => {
    const copy = await GitCheckout.open(server.remote, server.token);
    for (const path of [
      "sessions/a/t.json",
      ".platform/dreams/d.json",
      "../secret",
      "/etc/passwd",
      ".git/config",
      "notes/.git/config",
    ]) {
      await expect(
        copy.commit(head, [{ path, content: "bad" }], "Invalid", memoryPolicy),
      ).rejects.toThrow();
    }
    await expect(
      copy.commit(
        head,
        [{ path: "MEMORY.md", content: null }],
        "Delete index",
        memoryPolicy,
      ),
    ).rejects.toThrow("required");
    expect(await copy.head()).toBe(head);
  });

  test("platform-written sources persist beside curated memory", async () => {
    const copy = await GitCheckout.open(server.remote, server.token);
    const source = JSON.stringify({
      role: "user",
      text: "Our launch moved to November",
    });
    await copy.commit(
      head,
      [{ path: "sessions/a/t.json", content: source }],
      "Archive",
    );
    const fresh = await GitCheckout.open(server.remote, server.token);
    expect(
      await fresh.fs.promises.readFile("/memory/sessions/a/t.json", "utf8"),
    ).toBe(source);
  });

  test("the generic repository can remove MEMORY.md while a memory capability preserves it", async () => {
    const copy = await GitCheckout.open(server.remote, server.token);
    const saved = await copy.commit(
      head,
      [
        { path: "MEMORY.md", content: null },
        { path: "README.md", content: "# A general artifact\n" },
      ],
      "Use a different repository format",
    );
    const fresh = await GitCheckout.open(server.remote, server.token);
    expect(await fresh.head()).toBe(saved);
    await expect(
      fresh.fs.promises.readFile("/memory/MEMORY.md"),
    ).rejects.toThrow();
    expect(await fresh.fs.promises.readFile("/memory/README.md", "utf8")).toBe(
      "# A general artifact\n",
    );
  });

  test("a mixed commit containing a protected source publishes none of its edits", async () => {
    const copy = await GitCheckout.open(server.remote, server.token);
    await expect(
      copy.commit(
        head,
        [
          { path: "preferences.md", content: "# This must not land\n" },
          { path: "sessions/a/t.json", content: "forged evidence" },
        ],
        "Mixed edit",
        memoryPolicy,
      ),
    ).rejects.toThrow("read-only");
    const fresh = await GitCheckout.open(server.remote, server.token);
    expect(await fresh.head()).toBe(head);
    expect(
      await fresh.fs.promises.readFile("/memory/preferences.md", "utf8"),
    ).toBe("# Preferences\n\n");
  });

  test("dreaming can consolidate a note and repair its index in one commit", async () => {
    const live = await GitCheckout.open(server.remote, server.token);
    const original = await live.commit(
      head,
      [{ path: "projects/old.md", content: "# Old location\n" }],
      "Remember project",
    );
    const dreamer = await GitCheckout.open(server.remote, server.token);
    await dreamer.commit(
      original,
      [
        { path: "projects/old.md", content: null },
        {
          path: "projects/payments.md",
          content: "# Canonical payments note\n",
        },
        {
          path: "MEMORY.md",
          content: "# Memory: Alice\n\n## Index\n- [[projects/payments]]\n",
        },
      ],
      "Consolidate project memory",
    );
    const fresh = await GitCheckout.open(server.remote, server.token);
    await expect(
      fresh.fs.promises.readFile("/memory/projects/old.md"),
    ).rejects.toThrow();
    expect(
      await fresh.fs.promises.readFile("/memory/MEMORY.md", "utf8"),
    ).toContain("[[projects/payments]]");
    expect(
      await fresh.fs.promises.readFile("/memory/projects/payments.md", "utf8"),
    ).toContain("Canonical");
  });
});

test("user artifact identities are deterministic and isolated", async () => {
  expect(await repoName("alice")).toBe(await repoName("alice"));
  expect(await repoName("alice")).not.toBe(await repoName("bob"));
  expect(() => repositoryPath("../secret")).toThrow();
});
