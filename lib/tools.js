/**
 * Model tools backed by the marimo HTTP client. They stay registered whether
 * paired or not. Call arguments override the session's stored pairing target.
 *
 * `AbortSignal.any` combines the caller and plugin lifetime signals without
 * replacing `exec.signal`. Kernel failures return a result; transport, policy,
 * and stream failures throw.
 *
 * @module @apcamargo/dsh-marimo/tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	MarimoError,
	assertHostAllowed,
	discoverServers,
	executeCode,
	fetchSessions,
	normalizeBaseUrl,
	resolveSessionId,
} from "./marimo.js";

/** Include the policy in every result, including subagent and explicit-URL calls. */
const RESULT_REMINDER = "Reminder: never edit the notebook .py file. Persist changes via marimo._code_mode (cm) inside marimo_execute_code.";

/** Unpaired guidance: commands are human-only, so the model is told to ask the user. */
const UNPAIRED_MESSAGE =
	"No active marimo pairing in this session. Ask the user to run /marimo-pair (or /marimo-pair <url>), or pass url explicitly.";

/**
 * Track one in-flight operation so unloading can wait for it to settle.
 * @returns the same operation.
 */
function track(inFlight, operation) {
	inFlight.add(operation);
	const forget = () => inFlight.delete(operation);
	operation.then(forget, forget);
	return operation;
}

/** Read the token at call time. Tool arguments persist in session logs. */
function readToken(config) {
	const name = config.tokenEnvVar || "MARIMO_TOKEN";
	return process.env[name];
}

/**
 * Resolve an explicit or paired session without guessing. Validate stored ids
 * against the current map because reconnects can change them.
 * @param {{ id: string, path?: string, filename?: string }[]} sessions
 * @param {{ file?: string, session?: string, pairedNotebookPath?: string, pairedSessionId?: string }} selectors
 * @returns {{ id: string, refreshedSessionId?: string }}
 */
function resolveTargetSession(sessions, { file, session, pairedNotebookPath, pairedSessionId } = {}) {
	if (session || file) {
		return { id: resolveSessionId(sessions, { file, session }) };
	}
	if (pairedNotebookPath) {
		const matches = sessions.filter((entry) => entry.path === pairedNotebookPath || entry.filename === pairedNotebookPath);
		if (matches.length === 1) {
			const id = matches[0].id;
			return id !== pairedSessionId ? { id, refreshedSessionId: id } : { id };
		}
		// An existing id can disambiguate duplicate views only while it still
		// points at the originally paired notebook. Never substitute another file.
		if (matches.length > 1 && matches.some((entry) => entry.id === pairedSessionId)) {
			return { id: pairedSessionId };
		}
		throw new MarimoError(
			"CONNECTION",
			matches.length === 0
				? `The paired notebook '${pairedNotebookPath}' has no active session. Re-pair it or pass file/session explicitly.`
				: `Multiple active sessions match the paired notebook '${pairedNotebookPath}'. Pass the exact session id instead.`,
		);
	}
	if (pairedSessionId) {
		if (sessions.some((entry) => entry.id === pairedSessionId)) return { id: pairedSessionId };
		throw new MarimoError("CONNECTION", "The paired session is no longer active and its notebook path is unknown. Re-pair it or pass file/session explicitly.");
	}
	return { id: resolveSessionId(sessions, {}) };
}

/**
 * Resolve the base URL for one call: an explicit `url` argument wins, else the
 * session's paired url. Normalized and policy-checked.
 * @param {{ url?: string }} args
 * @param {{ url?: string } | undefined} record - the session's durable pairing record.
 * @param {{ allowRemoteHosts?: string[] }} config
 * @returns {{ baseUrl: string, paired: boolean }}
 */
function resolveBaseUrl(args, record, config) {
	if (args.url) {
		const baseUrl = normalizeBaseUrl(args.url);
		assertHostAllowed(baseUrl, config.allowRemoteHosts);
		return { baseUrl, paired: false };
	}
	if (record?.url) {
		const baseUrl = normalizeBaseUrl(record.url);
		assertHostAllowed(baseUrl, config.allowRemoteHosts);
		return { baseUrl, paired: true };
	}
	throw new MarimoError("CONNECTION", UNPAIRED_MESSAGE);
}

function executeCodeDefinition({ config, domain, readRecord, updateSessionRecord, lifetimeSignal, inFlight }) {
	return {
		name: "marimo_execute_code",
		description:
			"Execute Python in the live marimo notebook's scratchpad (defaults to the server paired by /marimo-pair). Scratchpad bindings are temporary. Persist changes through marimo._code_mode (cm).",
		parameters: {
			code: { type: "string", required: true, description: "Python code to evaluate in the kernel scratchpad" },
			url: { type: "string", description: "Notebook server base URL. Defaults to the paired server" },
			file: { type: "string", description: "Notebook file path to target when several sessions are open (mutually exclusive with session)" },
			session: { type: "string", description: "Exact marimo session id. Ephemeral and mutually exclusive with file" },
		},
		output: {
			schema: {
				type: "object",
				description: "The kernel's settled outcome for this call.",
				additionalProperties: false,
				properties: {
					success: { type: "boolean", required: true, description: "Whether the kernel ran the code without failure" },
					output: { type: "string", required: true, description: "The done event's output payload (empty when absent)" },
					stdout: { type: "string", required: true, description: "Captured scratchpad stdout" },
					stderr: { type: "string", required: true, description: "Captured scratchpad stderr" },
					sessionId: { type: "string", required: true, description: "The marimo session id the code ran in" },
					warnings: { type: "array", required: true, items: { type: "string" }, description: "Non-fatal call notes (truncation, session refresh)" },
				},
			},
			render: (_args, value) => {
				const parts = [];
				if (value.stdout.length > 0) parts.push(value.stdout);
				if (value.output.length > 0) parts.push(value.output);
				if (value.stderr.length > 0) parts.push(value.stderr);
				if (value.warnings.length > 0) parts.push(value.warnings.join(" "));
				parts.push(RESULT_REMINDER);
				return [{ type: "text", text: parts.join("\n") }];
			},
		},
		execute: (args, exec) =>
			track(
				inFlight,
				(async () => {
					const record = readRecord(domain, exec.agent?.id);
					const { baseUrl, paired } = resolveBaseUrl(args, record, config);
					const { sessions } = await fetchSessions(baseUrl, {
						token: readToken(config),
						tokenEnvVar: config.tokenEnvVar,
						timeoutMs: config.sessionsTimeoutMs,
						signal: exec.signal,
					});
					const { id, refreshedSessionId } = resolveTargetSession(sessions, {
						file: args.file,
						session: args.session,
						pairedNotebookPath: paired ? record?.notebookPath : undefined,
						pairedSessionId: paired ? record?.marimoSessionId : undefined,
					});
					const warnings = [];
					if (refreshedSessionId && exec.agent?.id) {
						await updateSessionRecord(domain, exec.agent.id, (current) => ({ ...current, marimoSessionId: refreshedSessionId }));
						warnings.push("Refreshed a stale stored session id from the current session map.");
					}
					const result = await executeCode(baseUrl, args.code, {
						token: readToken(config),
						tokenEnvVar: config.tokenEnvVar,
						session: id,
						timeoutMs: config.executeTimeoutMs,
						signal: AbortSignal.any([exec.signal, lifetimeSignal]),
						allowRemoteHosts: config.allowRemoteHosts,
					});
					if (result.warnings.length > 0) warnings.push(...result.warnings);
					return {
						success: result.success,
						output: result.output,
						stdout: result.stdout,
						stderr: result.stderr,
						sessionId: id,
						warnings,
					};
				})(),
			),
	};
}

function discoverServersDefinition({ config, inFlight }) {
	return {
		name: "marimo_discover_servers",
		description: "List running marimo notebook servers from the local server registry, with liveness and health checks. Read-only.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				description: "Live servers from the registry, and every entry that did not answer.",
				additionalProperties: false,
				properties: {
					servers: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								serverId: { type: "string", required: true },
								origin: { type: "string", required: true },
								url: { type: "string", required: true },
								startedAt: { type: "string" },
								version: { type: "string" },
							},
						},
					},
					unreachable: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								serverId: { type: "string", required: true },
								reason: { type: "string", required: true },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const lines = [];
				if (value.servers.length === 0) {
					lines.push("No reachable marimo servers found in the registry.");
					lines.push(
						"Only servers started with --no-token register for discovery. Pair by URL with /marimo-pair <url>, or start marimo (marimo edit notebook.py --no-token).",
					);
				}
				for (const server of value.servers) {
					lines.push(`${server.url}${server.version ? ` (marimo ${server.version})` : ""}${server.origin === "configured" ? " [configured registry]" : ""}`);
				}
				for (const entry of value.unreachable) {
					lines.push(`unreachable: ${entry.reason}`);
				}
				return [{ type: "text", text: lines.join("\n") }];
			},
		},
		execute: (_args, exec) =>
			track(
				// Drain discovery before the lifecycle closes its state domain.
				inFlight,
				(async () => {
					const result = await discoverServers({
						healthTimeoutMs: config.healthTimeoutMs,
						extraRegistryDirs: config.extraRegistryDirs,
						signal: exec.signal,
					});
					return {
						servers: result.servers.map((server) => ({
							serverId: server.serverId,
							origin: server.origin,
							url: server.url,
							...(server.startedAt !== undefined ? { startedAt: server.startedAt } : {}),
							...(server.version !== undefined ? { version: server.version } : {}),
						})),
						unreachable: result.unreachable.map((entry) => ({ serverId: entry.serverId, reason: entry.reason })),
					};
				})(),
			),
	};
}

function listSessionsDefinition({ config, domain, readRecord, inFlight, lifetimeSignal }) {
	return {
		name: "marimo_list_sessions",
		description: "List the active sessions (open notebooks) on the paired marimo server or a given url.",
		parameters: {
			url: { type: "string", description: "Notebook server base URL. Defaults to the paired server" },
		},
		output: {
			schema: {
				type: "object",
				description: "The active sessions on one server.",
				additionalProperties: false,
				properties: {
					url: { type: "string", required: true },
					sessions: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string", required: true },
								path: { type: "string" },
								filename: { type: "string" },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const lines = [`${value.url}:`];
				if (value.sessions.length === 0) {
					lines.push("  No active sessions. Make sure a notebook is open in the browser.");
				}
				for (const session of value.sessions) {
					lines.push(`  ${session.id}  ${session.path ?? session.filename ?? ""}`);
				}
				return [{ type: "text", text: lines.join("\n") }];
			},
		},
		execute: (args, exec) =>
			track(
				inFlight,
				(async () => {
					const record = readRecord(domain, exec.agent?.id);
					if (!args.url && !record?.url) {
						throw new MarimoError("CONNECTION", UNPAIRED_MESSAGE);
					}
					const baseUrl = normalizeBaseUrl(args.url ?? record.url);
					assertHostAllowed(baseUrl, config.allowRemoteHosts);
					const { sessions } = await fetchSessions(baseUrl, {
						token: readToken(config),
						tokenEnvVar: config.tokenEnvVar,
						timeoutMs: config.sessionsTimeoutMs,
						signal: AbortSignal.any([exec.signal, lifetimeSignal]),
					});
					return {
						url: baseUrl,
						sessions: sessions.map((session) => ({
							id: session.id,
							...(session.path !== undefined ? { path: session.path } : {}),
							...(session.filename !== undefined ? { filename: session.filename } : {}),
						})),
					};
				})(),
			),
	};
}

/**
 * Register tools with Cordis-owned disposers. Track operations in `inFlight`
 * so unloading drains them before closing the state domain.
 * @param ctx - host context carrying the `tools` registry.
 * @param domain - opened storage domain.
 * @param config - resolved plugin config.
 * @param lifecycle - plugin abort signal and in-flight operation set.
 * @param helpers - record reader and updater from the state module.
 */
function registerTools(ctx, domain, config, lifecycle, helpers) {
	const shared = {
		config,
		domain,
		readRecord: helpers.readRecord,
		updateSessionRecord: helpers.updateSessionRecord,
		lifetimeSignal: lifecycle.signal,
		inFlight: lifecycle.inFlight,
	};
	return ctx.effect(function* () {
		yield ctx.tools.register(defineTool(executeCodeDefinition(shared)));
		yield ctx.tools.register(defineTool(discoverServersDefinition(shared)));
		yield ctx.tools.register(defineTool(listSessionsDefinition(shared)));
	}, "marimo-pair tools");
}

export { registerTools, resolveBaseUrl, resolveTargetSession, UNPAIRED_MESSAGE };
