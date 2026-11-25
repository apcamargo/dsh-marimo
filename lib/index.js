/**
 * Register marimo commands, tools, pairing state, policy, UI projection, and
 * temporary session titles.
 *
 * Ported from marimo-team/marimo-pair (Apache-2.0). See NOTICE.
 * @module @apcamargo/dsh-marimo
 */

import { registerCommands } from "./commands.js";
import { Config, resolveConfig } from "./config.js";
import { POLICY_FALLBACK, renderPairingPolicy } from "./prompts.js";
import { registerPairingProjection } from "./projection.js";
import { buildSkillRegistration } from "./skill-content.js";
import { openMarimoPairDomain } from "./state.js";
import { registerTitleRelease } from "./title.js";
import { registerTools } from "./tools.js";

const name = "dsh-marimo";

/** Services provided by the `dsh-base` bundle. */
const inject = ["commands", "tools", "systemPrompt", "skills", "storageDomain"];

const POLICY_SECTION = Object.freeze({ name: "dsh-marimo:policy", order: 550 });

/**
 * Open storage and register all plugin surfaces in one effect. On unload,
 * cancel active work, drain it, then close the domain to prevent late writes.
 * @param ctx - host context carrying the injected services.
 * @param config - validated plugin configuration (schemastery applies defaults).
 * @returns resolution after the domain is open and every surface registered.
 */
async function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const domain = await openMarimoPairDomain(ctx);
	// Skill registration is synchronous; yield its disposer inside the effect.
	const skillRegistration = await buildSkillRegistration();
	ctx.effect(function* () {
		const lifetime = new AbortController();
		const inFlight = new Set();
		// Reverse-order teardown unregisters every surface before this drain,
		// preventing new work from starting while the domain closes.
		yield async () => {
			lifetime.abort();
			await Promise.allSettled([...inFlight]);
			await domain.close();
		};
		// Nested effects: the framework tracks their disposers while each runs.
		yield registerCommands(ctx, domain, resolved, { signal: lifetime.signal, inFlight });
		yield registerTools(ctx, domain, resolved, { signal: lifetime.signal, inFlight }, {
			readRecord: (openedDomain, sessionId) => {
				try {
					return openedDomain.table("sessions").get(sessionId);
				} catch {
					return undefined;
				}
			},
			updateSessionRecord: (openedDomain, sessionId, transform) =>
				openedDomain.table("sessions").update(sessionId, transform),
		});
		yield registerPolicySection(ctx, domain);
		// The Web UI's notebook button mirrors the pairing state through the
		// session-projection registry; skipped in profiles without it.
		yield registerPairingProjection(ctx, domain);
		// The pairing title is temporary: the first human message after pairing
		// releases the pin so the harness's automatic naming can replace it.
		yield registerTitleRelease(ctx, domain);
		yield ctx.skills.register(skillRegistration);
	}, "marimo-pair lifecycle");
}

/**
 * Render policy text from this session's record while paired. Return an empty
 * section otherwise, or the safety fallback when storage cannot be read.
 * @returns the registration disposer for teardown-ordering.
 */
function registerPolicySection(ctx, domain) {
	return ctx.systemPrompt.section({
		...POLICY_SECTION,
		interpolate: false,
		text: (context) => {
			try {
				const sessionId = context?.agent?.id;
				if (!sessionId) return "";
				const record = domain.table("sessions").get(sessionId);
				if (!record?.active) return "";
				return renderPairingPolicy(record) || POLICY_FALLBACK;
			} catch {
				return POLICY_FALLBACK;
			}
		},
	});
}

// Cordis validates the profile against `Config` before calling `apply`.
export { Config, POLICY_SECTION, apply, inject, name };
