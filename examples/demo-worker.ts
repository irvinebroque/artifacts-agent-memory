import { ArtifactRepository } from "../src/artifact";
import { archiveSource } from "../src/memory";
import { SessionAgent } from "./session-agent";
export { UserMemory } from "../src/user-memory";
export { SessionAgent };

// This HTTP adapter exists only to run the example. Platforms call the owner
// through DO RPC and install artifactTools in their own session harness.
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
  const owner = env.UserMemory.getByName(userId);
  const artifact = await owner.provision(userId, "Alice");
  const repo = new ArtifactRepository(env.ARTIFACTS, artifact.repo);
  emit({ event: "artifact", userId, ...artifact });

  // Each conversation is fresh. Only the artifact connects their memories.
  const turn = async (sessionId: string, prompt: string) => {
    if (cancelled()) throw new Error("Demo disconnected");
    const agent = env.SessionAgent.getByName(
      JSON.stringify([userId, sessionId]),
    );
    await agent.initialize(userId, sessionId, artifact.repo);
    await agent.startTurn("t1", prompt);
    emit({ event: "session_started", sessionId });
    const result = await poll(() => agent.turnStatus("t1"), cancelled);
    emit({ event: "answer", sessionId, text: result.text });
  };
  await turn(
    "teach",
    "I prefer concise summaries. Priya owns pricing for our payments project, and we launch in October. Please remember these facts.",
  );
  await turn(
    "recall",
    "What do you remember about my preferred summaries and our payments project?",
  );
  await turn(
    "correct",
    "Correction: our payments launch moved to November. October is outdated. Please remember that.",
  );
  // Simulate a captured turn whose session ended before the agent curated it.
  // Dreaming can recover this useful preference from the platform's evidence.
  const source = "sessions/interrupted/t1.json";
  await archiveSource(repo, source, {
    source: `artifact://${source}`,
    role: "user",
    text: "Please organize my project updates as decisions, blockers, and next steps.",
    receivedAt: new Date().toISOString(),
  });
  emit({ event: "source_archived", source, curatedBySession: false });
  await owner.requestDream("demo-night");
  emit({ event: "dream_started" });
  const dream = await poll(() => owner.dreamStatus("demo-night"), cancelled);
  emit({ event: "dream", text: dream.text });
  await turn(
    "after-dream",
    "When does our payments project launch, who owns pricing, and which sections do I prefer in project updates?",
  );
  emit({
    event: "memory",
    ...(await repo.read("MEMORY.md")),
    tree: await repo.list(),
  });
  emit({ event: "done" });
}

// Failed attempts may be retried by the durable queue. Give those retries time
// to settle rather than treating the first failed attempt as terminal.
async function poll<T extends { status: string; text: string | null }>(
  read: () => Promise<T | null>,
  cancelled: () => boolean,
): Promise<T> {
  const deadline = Date.now() + 10 * 60_000;
  let failedSince: number | undefined;
  while (Date.now() < deadline) {
    if (cancelled()) throw new Error("Demo disconnected");
    const result = await read();
    if (result?.status === "done") return result;
    if (result?.status === "failed") {
      failedSince ??= Date.now();
      if (Date.now() - failedSince > 30_000)
        throw new Error("Agent retries failed");
    } else failedSince = undefined;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for the agent");
}
