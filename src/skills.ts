import type { SkillSource } from "agents/skills";
import memorySkill from "../skills/artifact-memory/SKILL.md";
import dreamingSkill from "../skills/artifact-dreaming/SKILL.md";

// Text-only SkillSources avoid loading the optional skill-script runner.
function source(
  name: string,
  description: string,
  markdown: string,
): SkillSource {
  const descriptor = { name, description, sourceId: name };
  return {
    id: name,
    fingerprint: "v2",
    async list() {
      return [descriptor];
    },
    async load(requested) {
      return requested === name
        ? { ...descriptor, body: markdown.replace(/^---\n[\s\S]*?\n---\n/, "") }
        : null;
    },
  };
}
export const memorySkillSource = source(
  "artifact-memory",
  "Use this user's persistent Artifacts memory.",
  memorySkill,
);
export const dreamingSkillSource = source(
  "artifact-dreaming",
  "Consolidate memory from archived session evidence.",
  dreamingSkill,
);
