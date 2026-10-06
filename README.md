# Agent memory with Cloudflare Artifacts

This combines:

- [Cognition's Agent Memory Repo](https://cognition.com/agent-memory-repo) and the [open file structure spec](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/main/SPEC.md)
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Pi + Pi Durable harness in the Agents SDK](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/)

Each user gets a Git repository for memory. Your platform attaches that artifact
to its existing Pi agent through repository tools and a memory skill. A separate
platform-owned agent consolidates the same repository overnight, using a
Durable Object alarm.

```mermaid
flowchart LR
  Platform[Platform backend] -->|Provision through DO RPC| Owner[UserMemory agent<br/>one per user]
  Owner -->|Create and seed| Artifact[(User's artifact repository)]
  Platform -->|Attach artifact tools and skill| Session[Platform's Pi session agent]
  Session -->|Read, list, search, commit| Artifact
  Platform -->|Archive source turns| Artifact
  Alarm[Durable Object alarm<br/>08:00 UTC per user] --> Owner
  Owner -->|Pi dreaming session<br/>consolidate and commit| Artifact
```

## Integrate with a platform

```ts
// In your platform Worker, after authenticating the user:
const userId = authenticatedUser.id;
const owner = env.UserMemory.getByName(userId);
const { repo } = await owner.provision(userId, authenticatedUser.name);
// Retain repo in your user record and attach it to later agent sessions.
```

Then when instantiating a Pi agent:

```ts
import {
  ArtifactRepository,
  artifactTools,
  memoryContext,
  memoryPolicy,
  memorySkillSource,
} from "./src/index";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { skills } from "agents/harness/pi";

// Inside PiHarness's harness({ storage, context }) callback.
// models is your configured Pi model registry.
// repoName and currentSource come from your trusted session state.
const artifact = new ArtifactRepository(env.ARTIFACTS, repoName, memoryPolicy);
const registry = createRegistry();
registry.install(artifactTools(() => artifact));
registry.install(
  memoryContext(
    () => artifact,
    () => `Activate artifact-memory. Current source: ${currentSource}.`,
  ),
);
registry.install(await skills([memorySkillSource]));
return Harness.open(storage, { models, registry }, context);
```

`memoryContext` includes the latest `MEMORY.md` on each model request. The skill
teaches the agent when to retrieve deeper notes, which facts to retain, and how
to format them.

The agent works on ordinary repository files:

| Tool              | Operations                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `artifact`        | `read` a path, `list` by prefix, literal `search`, or Git `history`                       |
| `artifact_commit` | Commit and push file edits atomically against `expectedHead`; null content deletes a file |

For example, `artifact({ action: "read", path: "preferences.md" })` reads a note.

## Memory format

Provisioning seeds three files:

```text
memory-<user hash>/
  MEMORY.md
  preferences.md
  projects/README.md
```

The memory skill uses the Cognition format: single-line facts with provenance
and root-relative links, omitting `.md` in Markdown links:

```md
- Alice prefers concise summaries [source: artifact://sessions/teach/t1.json; added: 2026-10-06]
- Priya owns pricing for [[projects/payments]] [source: artifact://sessions/teach/t1.json]
```

## Overnight dreaming

Each `UserMemory` agent registers its own alarm-backed schedule:

```ts
await this.schedule(this.env.DREAM_CRON, "dream", undefined, {
  retry: { maxAttempts: 3 },
});
```
