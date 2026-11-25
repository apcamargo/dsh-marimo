/**
 * Human-only pairing commands. Model guidance must ask the user to run them.
 * Pairing requires a code-mode check, not just a successful health probe.
 *
 * @module @apcamargo/dsh-marimo/commands
 */

import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
	answersMarimo,
	assertHostAllowed,
	discoverServers,
	executeCode,
	fetchSessions,
	normalizeBaseUrl,
	resolveSessionId,
} from "./marimo.js";
import { PAIRING_SUMMARY_PROMPT, buildConnectedPrompt, buildPairingFailurePrompt, truncate } from "./prompts.js";
import { clearActivePairing, getSessionRecord, setActivePairing, updateMarimoSessionId } from "./state.js";
import { pairingSessionTitle, pinPairingTitle } from "./title.js";
import { resolveTargetSession } from "./tools.js";

const PAIR_DEFINITION_ID = "@apcamargo/dsh-marimo/marimo-pair";
const END_PAIR_DEFINITION_ID = "@apcamargo/dsh-marimo/end-marimo-pair";

/** Source for queued turns; the harness has no generic plugin source kind. */
const PAIRING_MESSAGE_SOURCE = Object.freeze({ kind: "apcamargo-dsh-marimo" });

const PAIRING_CANCELLED_MESSAGE = "Pairing cancelled.";

/** The code-mode inspection command that must succeed before pairing. */
const CODE_MODE_PROBE = "import marimo._code_mode as cm; help(cm)";

const PAIR_USAGE =
	"Usage: /marimo-pair [status|<url> [--file <path>|--session <id>]]. Pair this session with a running marimo notebook server.";
const END_PAIR_USAGE =
	"Usage: /end-marimo-pair [summary|done|status]. Summarize the pairing, finish it in place, or show its state.";

/**
 * Explain that token-authenticated servers do not appear in discovery instead
 * of telling the user to start a second server.
 * @param {string} tokenEnvVar - configured token environment variable name.
 */
function startServerGuidance(tokenEnvVar = "MARIMO_TOKEN") {
	return [
		"No reachable marimo server was found. Discovery reads marimo's server registry, and marimo registers a server only when it is started with --no-token:",
		"  - marimo edit notebook.py --no-token        # registers it for discovery",
		"  - add --sandbox when the notebook has a PEP 723 # /// script header",
		"  - start without --headless and open the notebook UI in a browser",
		`If marimo is already running with token auth (started without --no-token), it does not register: set ${tokenEnvVar} in the harness process environment (the token is printed when marimo starts) and pair by URL: /marimo-pair http://<host>:<port>`,
	].join("\n");
}

/** Tokenize quotes and retain each token's raw end offset for slicing. */
function tokenizeArgs(value) {
	const tokens = [];
	let current = "";
	let quote = null;
	let end = -1;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			if (char === "\\" && i + 1 < value.length) {
				current += value[i + 1];
				end = i + 1;
				i += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
				end = i;
				continue;
			}
			current += char;
			end = i;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			end = i;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) tokens.push({ text: current, end: end + 1 });
			current = "";
			continue;
		}
		current += char;
		end = i;
	}
	if (current.length > 0) tokens.push({ text: current, end: end + 1 });
	return tokens;
}

/**
 * Parse `status`, a server URL, or bare discovery. Multi-word input is never
 * treated as `status`.
 * @returns {{ kind: "status" } | { kind: "connect", url?: string, file?: string, session?: string } | { kind: "invalid", error: string }}
 */
function parsePairArgs(rawInput) {
	const input = rawInput?.trim() ?? "";
	if (input.length === 0) return { kind: "connect" };
	const parts = tokenizeArgs(input);
	if (parts.length === 1 && parts[0].text.toLowerCase() === "status") return { kind: "status" };
	if (parts.length === 1) {
		const candidate = parts[0].text;
		if (/^https?:\/\//i.test(candidate)) return { kind: "connect", url: candidate };
		return { kind: "invalid", error: `'${candidate}' is not a server URL. ${PAIR_USAGE}` };
	}
	if (parts.length === 3 && /^https?:\/\//i.test(parts[0].text)) {
		const selector = parts[1].text;
		if (selector === "--file") return { kind: "connect", url: parts[0].text, file: parts[2].text };
		if (selector === "--session") return { kind: "connect", url: parts[0].text, session: parts[2].text };
	}
	return { kind: "invalid", error: PAIR_USAGE };
}

/**
 * Parse end-command arguments. The bare form queues a summary.
 * @returns {{ kind: "summary" | "done" | "status" } | { kind: "invalid", error: string }}
 */
function parseEndArgs(rawInput) {
	const input = rawInput?.trim().toLowerCase() ?? "";
	if (input.length === 0) return { kind: "summary" };
	if (input === "summary" || input === "done" || input === "status") return { kind: input };
	return { kind: "invalid", error: END_PAIR_USAGE };
}

function errorResult(text) {
	return { kind: "error", text };
}

function successResult(text) {
	return { kind: "success", text };
}

/** Submit one model-visible message as the agent's next turn, attributed to this plugin. */
function sendPairingTurn(invocation, text) {
	invocation.agent.followup(
		createUserMessage({
			content: [{ type: "text", text }],
			source: PAIRING_MESSAGE_SOURCE,
		}),
	);
}

/**
 * Queue a visible failure turn in addition to the command outcome. Queueing
 * failures must not hide the original command error.
 * @param {object} invocation - the command invocation carrying the agent.
 * @param {string} command - the failing human command, without the slash.
 * @param {string} text - the failure text the command outcome carries.
 */
function queueFailureTurn(invocation, command, text) {
	try {
		sendPairingTurn(invocation, buildPairingFailurePrompt(command, text));
	} catch {
		// The command outcome still reports the failure.
	}
}

/** Render pairing state with usage for starting or ending a pairing. */
function renderPairingState(record, { live = undefined, reachable = undefined } = {}) {
	const lines = ["Marimo pairing state"];
	if (record.active) {
		lines.push(`Status: active${record.startedAt ? ` (started ${record.startedAt})` : ""}`);
		lines.push(`Server: ${record.url ?? "unknown"}${live === true ? " [healthy]" : live === false ? " [not answering]" : ""}`);
		lines.push(`Notebook: ${record.notebookPath ?? "unknown"}`);
		lines.push(`Session: ${record.marimoSessionId ?? "unknown"}`);
		if (reachable !== undefined) {
			lines.push(`Open sessions: ${reachable.length === 0 ? "none" : reachable.map((session) => `${session.id} ${session.path ?? session.filename ?? ""}`).join("\n")}`);
		}
	} else {
		lines.push("Status: no pairing active");
	}
	lines.push("");
	lines.push(PAIR_USAGE);
	lines.push(END_PAIR_USAGE);
	return lines.join("\n");
}

/** Convert command errors to outcomes, preserving cancellation. */
function boundaryError(error, signal) {
	if (signal.aborted) return errorResult(PAIRING_CANCELLED_MESSAGE);
	return errorResult(error instanceof Error ? error.message : String(error));
}

/**
 * Execute one `/marimo-pair` invocation.
 * @returns the settled command outcome.
 */
async function executeMarimoPair(ctx, domain, config, invocation, lifetime) {
	const signal = AbortSignal.any([invocation.signal, lifetime]);
	try {
		return await runPairCommand(ctx, domain, config, invocation, signal);
	} catch (error) {
		const result = boundaryError(error, signal);
		if (result.text !== PAIRING_CANCELLED_MESSAGE) queueFailureTurn(invocation, "marimo-pair", result.text);
		return result;
	}
}

/**
 * Run `/marimo-pair`. Failures leave durable state untouched and propagate to
 * the boundary translator.
 * @param ctx - host context; carries the optional session-title service.
 */
async function runPairCommand(ctx, domain, config, invocation, signal) {
	signal.throwIfAborted();
	const sessionId = invocation.agent.id;
	const parsed = parsePairArgs(invocation.rawInput);
	if (parsed.kind === "invalid") return errorResult(parsed.error);

	const record = getSessionRecord(domain, sessionId);

	if (parsed.kind === "status") {
		// Refresh a stale session id only after a successful probe.
		if (record.active && record.url) {
			try {
				const baseUrl = normalizeBaseUrl(record.url);
				assertHostAllowed(baseUrl, config.allowRemoteHosts);
				const live = await answersMarimo(baseUrl, { timeoutMs: config.healthTimeoutMs, signal });
				const { sessions } = await fetchSessions(baseUrl, { token: readToken(config), tokenEnvVar: config.tokenEnvVar, timeoutMs: config.sessionsTimeoutMs, signal });
				const stored = record.marimoSessionId;
				if (stored && !sessions.some((entry) => entry.id === stored)) {
					const target = resolveTargetSession(sessions, { pairedNotebookPath: record.notebookPath, pairedSessionId: stored });
					if (target.refreshedSessionId) await updateMarimoSessionId(domain, sessionId, target.refreshedSessionId);
				}
				return successResult(renderPairingState(getSessionRecord(domain, sessionId), { live, reachable: sessions }));
			} catch (error) {
				if (signal.aborted) throw error;
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		}
		return successResult(renderPairingState(record));
	}

	// Refuse a second pairing and show how to end the current one.
	if (record.active) {
		const notebook = record.notebookPath ? truncate(record.notebookPath, 40) : "a notebook";
		return errorResult(`Already pairing ${notebook}. Use /end-marimo-pair to finish, or /marimo-pair status.`);
	}

	signal.throwIfAborted();
	// Report failures in both the command outcome and conversation so the
	// user sees them and the agent can help.
	const failConnect = (text) => {
		queueFailureTurn(invocation, "marimo-pair", text);
		return errorResult(text);
	};
	try {
		let targetUrl = parsed.url;
		let origin = "user-url";
		if (!targetUrl) {
			const { servers, unreachable } = await discoverServers({
				healthTimeoutMs: config.healthTimeoutMs,
				extraRegistryDirs: config.extraRegistryDirs,
				signal,
			});
			const reachable = servers.filter((server) => server.url);
			if (reachable.length === 1) {
				targetUrl = reachable[0].url;
				origin = "discovered";
			} else if (reachable.length > 1) {
				return failConnect(`Multiple marimo servers are running. Re-run with one URL:\n${reachable.map((server) => `  ${server.url}`).join("\n")}`);
			} else {
				const extra = unreachable.length > 0 ? `\n${unreachable.map((entry) => `- ${entry.reason}`).join("\n")}` : "";
				return failConnect(`${startServerGuidance(config.tokenEnvVar)}${extra}`);
			}
		}

		const baseUrl = normalizeBaseUrl(targetUrl);
		assertHostAllowed(baseUrl, config.allowRemoteHosts);

		if (!(await answersMarimo(baseUrl, { timeoutMs: config.healthTimeoutMs, signal }))) {
			return failConnect(`No marimo answered at ${baseUrl}. Check that the server is running and the notebook UI is open.${startServerGuidance(config.tokenEnvVar)}`);
		}

		const { sessions } = await fetchSessions(baseUrl, { token: readToken(config), tokenEnvVar: config.tokenEnvVar, timeoutMs: config.sessionsTimeoutMs, signal });
		const resolvedSessionId = resolveSessionId(sessions, { file: parsed.file, session: parsed.session });
		const selectedSession = sessions.find((entry) => entry.id === resolvedSessionId);
		const notebookPath = selectedSession?.path ?? selectedSession?.filename;

		// A health check does not prove code mode is available; inspect it in
		// the kernel before storing the pairing.
		const probe = await executeCode(baseUrl, CODE_MODE_PROBE, {
			token: readToken(config),
			tokenEnvVar: config.tokenEnvVar,
			session: resolvedSessionId,
			timeoutMs: config.executeTimeoutMs,
			signal,
			allowRemoteHosts: config.allowRemoteHosts,
		});
		if (!probe.success) {
			return failConnect(
				`The code-mode inspection failed on ${baseUrl} (marimo >= 0.21.1 is required for code mode).\n${probe.stderr || probe.output || "No error output."}`,
			);
		}

		// Do not save state or queue a turn if cancelled during setup.
		signal.throwIfAborted();
		// Name untitled sessions after the notebook. Keep user titles and track
		// this plugin's pin separately for later pairings.
		const pinnedTitle = pinPairingTitle(ctx, invocation.agent, {
			ownedTitle: record.title,
			title: pairingSessionTitle({ notebookPath, url: baseUrl }),
		});
		await setActivePairing(domain, sessionId, {
			url: baseUrl,
			notebookPath,
			marimoSessionId: resolvedSessionId,
			origin,
			title: pinnedTitle,
		});
		sendPairingTurn(invocation, buildConnectedPrompt({ url: baseUrl, notebookPath }));

		const hint = notebookPath ? ` (${truncate(notebookPath, 40)})` : "";
		return successResult(`Pairing started: ${baseUrl}${hint}. The code-mode inspection ran. Findings appear in this session. Finish with /end-marimo-pair.`);
	} catch (error) {
		// Let cancellation reach the boundary; report other failures everywhere.
		if (signal.aborted) throw error;
		return failConnect(error instanceof Error ? error.message : String(error));
	}
}

/** Token from the configured environment variable, read at call time. */
function readToken(config) {
	const name = config.tokenEnvVar || "MARIMO_TOKEN";
	return process.env[name];
}

/**
 * Execute one `/end-marimo-pair` invocation.
 * @returns the settled command outcome.
 */
async function executeEndMarimoPair(ctx, domain, config, invocation, lifetime) {
	const signal = AbortSignal.any([invocation.signal, lifetime]);
	try {
		return await runEndPairCommand(domain, config, invocation, signal);
	} catch (error) {
		const result = boundaryError(error, signal);
		if (result.text !== PAIRING_CANCELLED_MESSAGE) queueFailureTurn(invocation, "end-marimo-pair", result.text);
		return result;
	}
}

/** The `/end-marimo-pair` command body; failures propagate to the boundary translator. */
async function runEndPairCommand(domain, config, invocation, signal) {
	signal.throwIfAborted();
	const parsed = parseEndArgs(invocation.rawInput);
	if (parsed.kind === "invalid") return errorResult(parsed.error);

	const sessionId = invocation.agent.id;
	const record = getSessionRecord(domain, sessionId);

	if (parsed.kind === "status") {
		// Refresh a stale id only after a successful probe, as in pair status.
		if (record.active && record.url) {
			try {
				const baseUrl = normalizeBaseUrl(record.url);
				assertHostAllowed(baseUrl, config.allowRemoteHosts);
				const live = await answersMarimo(baseUrl, { timeoutMs: config.healthTimeoutMs, signal });
				const { sessions } = await fetchSessions(baseUrl, { token: readToken(config), tokenEnvVar: config.tokenEnvVar, timeoutMs: config.sessionsTimeoutMs, signal });
				const stored = record.marimoSessionId;
				if (stored && !sessions.some((entry) => entry.id === stored)) {
					const target = resolveTargetSession(sessions, { pairedNotebookPath: record.notebookPath, pairedSessionId: stored });
					if (target.refreshedSessionId) await updateMarimoSessionId(domain, sessionId, target.refreshedSessionId);
				}
				return successResult(renderPairingState(getSessionRecord(domain, sessionId), { live, reachable: sessions }));
			} catch (error) {
				if (signal.aborted) throw error;
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		}
		return successResult(renderPairingState(record));
	}

	if (!record.active) {
		return errorResult(`No pairing is active in this session (start one with /marimo-pair).\n${END_PAIR_USAGE}`);
	}

	if (parsed.kind === "summary") {
		// Queue the handoff before clearing its pairing state.
		sendPairingTurn(invocation, PAIRING_SUMMARY_PROMPT);
		await clearActivePairing(domain, sessionId);
		return successResult("Pairing finished. A structured handoff of the notebook changes is queued as the next turn.");
	}
	await clearActivePairing(domain, sessionId);
	return successResult("Pairing finished. The session is back to ordinary work.");
}

/** Track one in-flight command so unloading can wait for it to settle. */
function track(inFlight, operation) {
	inFlight.add(operation);
	const forget = () => inFlight.delete(operation);
	operation.then(forget, forget);
	return operation;
}

/**
 * Register the human-only pairing commands with Cordis-owned disposers.
 * @param ctx - context carrying the command registry.
 * @param domain - opened storage domain.
 * @param config - resolved plugin config.
 * @param lifecycle - plugin abort signal and in-flight command set.
 */
function registerCommands(ctx, domain, config, lifecycle) {
	return ctx.effect(function* () {
		yield ctx.commands.register({
			definitionId: CommandDefinitionId(PAIR_DEFINITION_ID),
			name: "marimo-pair",
			description: "Pair this session with a running marimo notebook server (discover, or pair by URL)",
			input: {
				hint: "[status|<url> [--file <path>|--session <id>]]",
			},
			handler: (invocation) => track(lifecycle.inFlight, executeMarimoPair(ctx, domain, config, invocation, lifecycle.signal)),
		});
		yield ctx.commands.register({
			definitionId: CommandDefinitionId(END_PAIR_DEFINITION_ID),
			name: "end-marimo-pair",
			description: "Finish the active marimo pairing (summarize the notebook changes, or finish in place)",
			input: {
				hint: "[summary|done|status]",
			},
			handler: (invocation) => track(lifecycle.inFlight, executeEndMarimoPair(ctx, domain, config, invocation, lifecycle.signal)),
		});
	}, "marimo-pair commands");
}

export {
	boundaryError,
	executeEndMarimoPair,
	executeMarimoPair,
	parseEndArgs,
	parsePairArgs,
	registerCommands,
	tokenizeArgs,
};
