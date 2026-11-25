/**
 * Registration for the model-only `marimo-pair` skill. Its bundled Markdown
 * uses this plugin's native tools instead of shell scripts.
 *
 * Derived from marimo-team/marimo-pair (Apache-2.0). See NOTICE.
 * @module @apcamargo/dsh-marimo/skill-content
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** kebab-case skill name; appears in the model's available_skills catalog. */
const SKILL_NAME = "marimo-pair";

/** The original SKILL.md frontmatter description, carried over. */
const SKILL_DESCRIPTION =
	"Drive a live marimo notebook as a workspace: run Python in the same kernel the user does, inspect live notebook state, and commit durable notebook changes. Use when the user wants to start a marimo notebook or pair on an active marimo session.";

/** Extra routing guidance for the model's skill catalog. */
const SKILL_WHEN_TO_USE =
	"When a marimo pairing is active (after /marimo-pair), or when the user asks to pair on an active marimo notebook, run code in a marimo kernel, or commit changes to a live notebook.";

/** Model-only: the human surface is the /marimo-pair and /end-marimo-pair commands. */
const SKILL_INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: false });

/** Registry source label for the runtime contribution. */
const SKILL_SOURCE = "runtime";

/** Read the bundled skill body and let packaging errors fail registration. */
async function loadSkillContent() {
	const skillPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "skill.md");
	return fs.readFile(skillPath, "utf8");
}

/**
 * Build the model-only skill registration, loading its body once per application.
 * @returns {Promise<{ name: string, description: string, whenToUse: string, source: string, invocation: { modelInvocable: boolean, userInvocable: boolean }, content: string }>}
 */
async function buildSkillRegistration() {
	return {
		name: SKILL_NAME,
		description: SKILL_DESCRIPTION,
		whenToUse: SKILL_WHEN_TO_USE,
		source: SKILL_SOURCE,
		invocation: { ...SKILL_INVOCATION },
		content: await loadSkillContent(),
	};
}

export { buildSkillRegistration };
