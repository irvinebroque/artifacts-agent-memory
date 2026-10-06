import { readFile, listFiles } from "../src/files";
import { archiveSource } from "../src/archive";
import { commitFiles } from "../src/git";
import { repoName } from "../src/format";
import { SessionAgent } from "./session-agent";
export { UserMemory } from "./user-memory";
export { SessionAgent };

// This protected HTTP runner demonstrates the platform lifecycle below.
// Platforms use the binding and the two agents directly in their own backend.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/demo")
      return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Use POST", { status: 405 });
    if (
      !env.DEMO_API_KEY ||
      request.headers.get("authorization") !== `Bearer ${env.DEMO_API_KEY}`
    )
      return new Response("Unauthorized", { status: 401 });

    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: unknown) => {
          if (!cancelled)
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        try {
          await runDemo(env, emit, () => cancelled);
        } catch (error) {
          console.error(
            JSON.stringify({ event: "demo_failed", message: String(error) }),
          );
          emit({
            event: "error",
            message: "Demo failed; inspect Worker logs for details.",
          });
        } finally {
          if (!cancelled) controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      },
    });
  },
} satisfies ExportedHandler<Env>;

async function runDemo(
  env: Env,
  emit: (event: unknown) => void,
  cancelled: () => boolean,
) {
  const userId = `demo-${crypto.randomUUID()}`;
  const name = await repoName(userId);

  // Platform signup: create the artifact directly through the Workers binding.
  // A deterministic name lets a signup retry continue after creation or seeding.
  let initialToken: string | undefined;
  try {
    using created = (await env.ARTIFACTS.create(name, {
      setDefaultBranch: "main",
      description: "Per-user agent memory",
    })) as ArtifactsCreateRepoResult & Disposable;
    initialToken = created.token;
  } catch (error) {
    // A signup may be retrying after creation. Continue only if the binding
    // confirms that this exact repository already exists.
    try {
      using existing = await env.ARTIFACTS.get(name);
      using info = (await existing.info()) as ArtifactsRepoInfo & Disposable;
    } catch {
      throw error;
    }
  }
  using repo = await env.ARTIFACTS.get(name);
  if (initialToken) await repo.revokeToken(initialToken);
  {
    using commits = (await repo.log({
      ref: "main",
      limit: 1,
    })) as ArtifactsCommitMetadata[] & Disposable;
    if (!commits.length) {
      await commitFiles(
        repo,
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
        "Seed user memory",
      );
    }
  }

  // Persist name in your user record. Give it to the per-user dreaming agent.
  const owner = env.UserMemory.getByName(userId);
  using initialized = await owner.initialize(userId, name);
  using info = (await repo.info()) as ArtifactsRepoInfo & Disposable;
  emit({
    event: "artifact",
    userId,
    repo: name,
    remote: info.remote,
    ...initialized,
  });
  if (
    initialized.schedule.callback !== "dream" ||
    initialized.schedule.cron !== env.DREAM_CRON ||
    initialized.alarmAt === null
  )
    throw new Error("Nightly dreaming schedule was not registered");
  emit({ event: "check", name: "nightly_schedule", passed: true });

  // Check a repeated signup cannot replace the repository or duplicate its alarm.
  let exists = false;
  try {
    using duplicate = (await env.ARTIFACTS.create(name, {
      setDefaultBranch: "main",
    })) as ArtifactsCreateRepoResult & Disposable;
    await repo.revokeToken(duplicate.token);
  } catch {
    using existing = await env.ARTIFACTS.get(name);
    using info = (await existing.info()) as ArtifactsRepoInfo & Disposable;
    exists = info.name === name;
  }
  using retried = await owner.initialize(userId, name);
  if (!exists || retried.schedule.id !== initialized.schedule.id)
    throw new Error("Signup retry created another artifact or schedule");
  emit({ event: "check", name: "provisioning_retry", passed: true });

  // Each conversation is fresh. Only the artifact connects their memories.
  const turn = async (
    sessionId: string,
    prompt: string,
    queuedPrompt?: string,
  ) => {
    if (cancelled()) throw new Error("Demo disconnected");
    const agent = env.SessionAgent.getByName(
      JSON.stringify([userId, sessionId]),
    );
    await agent.initialize(userId, sessionId, name);
    using accepted = await agent.startTurn("t1", prompt);
    if (queuedPrompt) {
      using acceptedNext = await agent.startTurn("t2", queuedPrompt);
    }
    emit({ event: "session_started", sessionId });
    const result = await poll(() => agent.turnStatus("t1"), cancelled);
    emit({ event: "answer", sessionId, text: result.text });
    if (queuedPrompt) {
      const next = await poll(() => agent.turnStatus("t2"), cancelled);
      requireFacts(next.text ?? "", [/Priya/i, /October/i], "queued follow-up");
      using commits = (await repo.log({
        ref: "main",
        limit: 20,
      })) as ArtifactsCommitMetadata[] & Disposable;
      const history = commits;
      const firstAnswer = history.findIndex(
        (commit) =>
          commit.message === `Archive sessions/${sessionId}/t1.answer.json`,
      );
      const secondSource = history.findIndex(
        (commit) => commit.message === `Archive sessions/${sessionId}/t2.json`,
      );
      if (firstAnswer < 0 || secondSource < 0 || secondSource >= firstAnswer)
        throw new Error("Queued turns were not processed in order");
      emit({ event: "check", name: "ordered_turns", passed: true });
    }
    return result.text ?? "";
  };
  await turn(
    "teach",
    "I prefer concise summaries. Priya owns pricing for our payments project, and we launch in October. Please remember these facts.",
    "Confirm who owns pricing and when the payments project launches.",
  );
  const recalled = await turn(
    "recall",
    "What do you remember about my preferred summaries and our payments project?",
  );
  requireFacts(
    recalled,
    [/concise|short|brief/i, /Priya/i, /October/i],
    "fresh-session recall",
  );
  emit({ event: "check", name: "fresh_session_recall", passed: true });
  await turn(
    "correct",
    "Correction: our payments launch moved to November. October is outdated. Please remember that.",
  );
  // Two captured sessions ended before their agents curated this preference.
  // Dreaming can discover the recurring pattern in the platform's evidence.
  const source = "sessions/interrupted/t1.json";
  await archiveSource(repo, source, {
    source: `artifact://${source}`,
    role: "user",
    text: "My standing preference for every project update is three sections: decisions, blockers, and next steps. Remember this for future conversations.",
    receivedAt: new Date().toISOString(),
  });
  emit({ event: "source_archived", source, curatedBySession: false });
  const repeatedSource = "sessions/interrupted-repeat/t1.json";
  await archiveSource(repo, repeatedSource, {
    source: `artifact://${repeatedSource}`,
    role: "user",
    text: "As usual, organize all project updates into decisions, blockers, and next steps. This is my ongoing preference.",
    receivedAt: new Date().toISOString(),
  });
  emit({
    event: "source_archived",
    source: repeatedSource,
    curatedBySession: false,
  });
  // Exercise the real alarm path now, using the same callback as overnight.
  const dreamId = "demo-night";
  using scheduled = await owner.requestDream(dreamId, 1);
  emit({ event: "dream_scheduled", ...scheduled });
  const dream = await poll(() => owner.dreamStatus(dreamId), cancelled);
  emit({ event: "dream", text: dream.text });
  const tree = await listFiles(repo);
  const curated = await Promise.all(
    tree.paths
      .filter(
        (path) =>
          path.endsWith(".md") &&
          !path.startsWith("sessions/") &&
          !path.startsWith(".platform/"),
      )
      .map((path) => readFile(repo, path, tree.head ?? undefined)),
  );
  const facts = curated.map((file) => file.content ?? "").join("\n");
  requireFacts(
    facts,
    [
      /November/i,
      /Priya/i,
      /decisions/i,
      /blockers/i,
      /next steps/i,
      /artifact:\/\/sessions\/interrupted(?:-repeat)?\/t1.json/,
    ],
    "persisted curated memory and provenance",
  );
  const report = await readFile(
    repo,
    `.platform/dreams/${dreamId}.json`,
    tree.head ?? undefined,
  );
  if (report.content === null) throw new Error("Dream report was not archived");
  emit({
    event: "check",
    name: "dream_saved_pattern_and_provenance",
    passed: true,
  });
  const afterDream = await turn(
    "after-dream",
    "When does our payments project launch, who owns pricing, and which sections do I prefer in project updates?",
  );
  requireFacts(
    afterDream,
    [/November/i, /Priya/i, /decisions/i, /blockers/i, /next steps/i],
    "recall after dreaming",
  );
  emit({ event: "check", name: "alarm_dreaming_and_recall", passed: true });
  using history = (await repo.log({
    ref: "main",
    limit: 20,
  })) as ArtifactsCommitMetadata[] & Disposable;
  emit({
    event: "memory",
    ...(await readFile(repo, "MEMORY.md", tree.head ?? undefined)),
    tree,
    curated,
    history,
  });
  emit({ event: "done" });
}

function requireFacts(text: string, patterns: RegExp[], stage: string) {
  for (const pattern of patterns) {
    if (!pattern.test(text))
      throw new Error(`Missing ${pattern.source} in ${stage}`);
  }
}

// Failed attempts may be retried by the durable task. Give those retries time
// to settle rather than treating the first failed attempt as terminal.
async function poll(
  read: () => Promise<
    ({ status: string; text: string | null } & Disposable) | null
  >,
  cancelled: () => boolean,
): Promise<{ status: string; text: string | null }> {
  const deadline = Date.now() + 10 * 60_000;
  let failedSince: number | undefined;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error("Demo disconnected");
    using result = await read();
    if (result?.status === "done")
      return { status: result.status, text: result.text };
    if (result?.status === "failed") {
      failedSince ??= Date.now();
      if (Date.now() - failedSince > 30_000)
        throw new Error("Agent retries failed");
    } else failedSince = undefined;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for the agent");
}
