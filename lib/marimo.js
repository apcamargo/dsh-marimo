/**
 * HTTP client for marimo health, session, and execution endpoints.
 *
 * Wire contract, verified against marimo 0.25.1:
 * - `GET {base}/health` returns a healthy marker without auth. Never send the token.
 * - `GET {base}/api/sessions` returns session IDs mapped to `{path, filename}`.
 * - `POST {base}/api/kernel/execute` takes `Marimo-Session-Id` and
 *   `{"code": ...}`. It streams SSE `stdout`/`stderr` events containing
 *   `data: {"data": "..."}`, then `done` with
 *   `{"success", "output": {"mimetype", "data"}}`.
 *   Execution errors use stderr. `done.success === false` reports failure.
 * - An invalid session ID returns HTTP 500 with a non-SSE JSON `detail` error.
 *
 * @module @apcamargo/dsh-marimo/marimo
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Stable error codes: CONNECTION (transport/HTTP), STREAM (no `done`), AUTH (401), DENIED (host policy). */
class MarimoError extends Error {
	/**
	 * @param {"CONNECTION"|"STREAM"|"AUTH"|"DENIED"} code
	 * @param {string} message
	 */
	constructor(code, message) {
		super(message);
		this.name = "MarimoError";
		this.code = code;
	}
}

/** Capture limit per stream, reported in warnings when reached. */
const STREAM_CAP_BYTES = 256 * 1024;

/** Body marker that identifies a marimo server. */
const HEALTHY_MARKER = '"healthy"';

/** Upper bound for `AbortSignal.timeout` delays. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function timeoutSignal(ms) {
	const bounded = Math.max(1, Math.min(Number(ms) || 0, MAX_TIMEOUT_MS));
	return AbortSignal.timeout(bounded);
}

/**
 * Return the platform registry directory, then configured extras.
 * Tests can override `$XDG_STATE_HOME` to use a temporary registry.
 * @param {string[]} extraDirs - configured extra directories.
 * @returns {{ dir: string, origin: string }[]}
 */
function registryDirs(extraDirs = []) {
	const dirs = [];
	if (process.platform === "win32") {
		dirs.push({ dir: path.join(os.homedir(), ".marimo", "servers"), origin: "local" });
	} else {
		const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
		dirs.push({ dir: path.join(stateHome, "marimo", "servers"), origin: "local" });
	}
	for (const extra of extraDirs) {
		if (typeof extra === "string" && extra.length > 0) dirs.push({ dir: extra, origin: "configured" });
	}
	return dirs;
}

/**
 * Return 0 for running, 1 for gone (`ESRCH`), or 2 for unknown.
 * Permission failures must mean unknown, never dead.
 * @param {unknown} pid
 * @returns {0 | 1 | 2}
 */
function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return 2;
	try {
		process.kill(pid, 0);
		return 0;
	} catch (error) {
		return error?.code === "ESRCH" ? 1 : 2;
	}
}

/**
 * Return connection candidates in preference order.
 * Use loopback instead of a bind-all address.
 * @param {string} host
 * @returns {string[]}
 */
function candidateHosts(host) {
	switch (host) {
		case "0.0.0.0":
		case "":
			return ["127.0.0.1"];
		case "::":
			return ["::1"];
		default:
			return [host];
	}
}

/** Return whether `host` is loopback and always allowed.
 * @param {string} host
 */
function isLoopbackHost(host) {
	const normalized = host?.toLowerCase() ?? "";
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "0.0.0.0" || normalized === "[::]";
}

/**
 * Normalize a base URL. Allow HTTP(S), strip credentials and trailing slashes.
 * @returns {string} the normalized base URL.
 * @throws {MarimoError} DENIED for unsupported schemes, CONNECTION for invalid URLs.
 */
function normalizeBaseUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(String(rawUrl));
	} catch {
		throw new MarimoError("CONNECTION", `Invalid URL: ${String(rawUrl)}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new MarimoError("DENIED", `Only http/https URLs are supported, got ${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) {
		parsed.username = "";
		parsed.password = "";
	}
	return parsed.origin === "null" ? String(parsed).replace(/\/+$/, "") : parsed.origin.replace(/\/+$/, "");
}

/**
 * Allow loopback and require `allowRemoteHosts` for every other host.
 * Call before sending code or a token.
 * @param {string} baseUrl - normalized base URL.
 * @param {string[]} allowRemoteHosts - configured non-loopback allowlist.
 * @throws {MarimoError} DENIED when the host is neither loopback nor allowlisted.
 */
function assertHostAllowed(baseUrl, allowRemoteHosts = []) {
	const parsed = new URL(baseUrl);
	if (isLoopbackHost(parsed.hostname)) return;
	const allowed = (allowRemoteHosts ?? []).some((entry) => typeof entry === "string" && entry.toLowerCase() === parsed.hostname.toLowerCase());
	if (!allowed) {
		throw new MarimoError(
			"DENIED",
			`Non-loopback host '${parsed.hostname}' is denied by default. Add it to the marimo-pair plugin's allowRemoteHosts configuration, or pair a loopback server.`,
		);
	}
}

/**
 * Check `/health` for marimo's healthy marker.
 * Return false on failure and never send the token.
 * @param {string} baseUrl
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<boolean>}
 */
async function answersMarimo(baseUrl, { timeoutMs, signal } = {}) {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(`${baseUrl}/health`, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.any([controller.signal, timeoutSignal(timeoutMs ?? 2000)]),
		});
		if (!response.ok) return false;
		const body = await response.text();
		return body.includes(HEALTHY_MARKER);
	} catch {
		return false;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * List responsive servers and explain unreachable entries without editing the registry.
 * Process state alone is unreliable. PIDs can be recycled and live servers may not respond.
 * @param {{ healthTimeoutMs?: number, extraRegistryDirs?: string[], signal?: AbortSignal }} options
 * @returns {Promise<{ servers: {serverId: string, origin: string, url: string, startedAt: string|undefined, version: string|undefined}[], unreachable: {serverId: string, reason: string}[] }>}
 */
async function discoverServers({ healthTimeoutMs = 2000, extraRegistryDirs = [], signal } = {}) {
	const servers = [];
	const unreachable = [];
	for (const { dir, origin } of registryDirs(extraRegistryDirs)) {
		let files;
		try {
			files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}
		for (const file of files) {
			let entry;
			try {
				entry = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
			} catch {
				continue;
			}
			const serverId = String(entry.server_id ?? file.replace(/\.json$/, ""));
			const liveness = processAlive(entry.pid);
			const port = Number(entry.port);
			let url;
			if (Number.isInteger(port) && port > 0 && typeof entry.host === "string") {
				for (const candidateHost of candidateHosts(entry.host)) {
					const base = candidateHost.includes(":") && !candidateHost.startsWith("[")
						? `http://[${candidateHost}]:${port}`
						: `http://${candidateHost}:${port}`;
					if (await answersMarimo(base, { timeoutMs: healthTimeoutMs, signal })) {
						url = base;
						break;
					}
				}
			}
			if (url) {
				servers.push({ serverId, origin, url, startedAt: entry.started_at, version: entry.version });
				continue;
			}
			// No response. Use process state to explain the failure.
			if (liveness === 0) {
				unreachable.push({ serverId, reason: `${serverId} is running (PID ${entry.pid}) but nothing answers at its address. The notebook UI may be closed.` });
			} else if (liveness === 2) {
				unreachable.push({ serverId, reason: `${serverId} cannot be checked (PID ${entry.pid}): the probe failed and the process state is unknown.` });
			} else {
				unreachable.push({ serverId, reason: `${serverId} did not answer and its process (PID ${entry.pid}) is gone. If marimo is no longer running, that PID may belong to an unrelated process that reused the id.` });
			}
		}
	}
	return { servers, unreachable };
}

/** Build the bearer header for protected endpoints, never `/health`.
 * @param {string | undefined} token
 */
function authHeaders(token) {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Build the shared 401 error, naming the token variable the harness process needs.
 * @param {string} baseUrl
 * @param {string | undefined} tokenEnvVar - configured token environment variable name.
 * @returns {MarimoError} the AUTH error.
 */
function authError(baseUrl, tokenEnvVar) {
	const name = tokenEnvVar || "MARIMO_TOKEN";
	return new MarimoError(
		"AUTH",
		`The marimo server at ${baseUrl} requires its auth token. Set ${name} in the harness process environment before retrying. The plugin reads it at call time, and marimo prints the token when the server starts.`,
	);
}

/**
 * Extract `detail` from a JSON error body.
 * Otherwise return up to 500 characters of the raw body, or the HTTP status.
 * @param {Response} response
 */
async function errorDetail(response) {
	try {
		const body = await response.text();
		try {
			const parsed = JSON.parse(body);
			if (typeof parsed?.detail === "string" && parsed.detail.length > 0) return parsed.detail;
		} catch {
			// Use the raw response body when it is not JSON.
		}
		return body.length > 0 ? body.slice(0, 500) : `HTTP ${response.status}`;
	} catch {
		return `HTTP ${response.status}`;
	}
}

/**
 * Fetch `/api/sessions` and normalize its map to `{id, path, filename}` records.
 * @param {string} baseUrl
 * @param {{ token?: string, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ url: string, sessions: { id: string, path: string|undefined, filename: string|undefined }[] }>}
 * @throws {MarimoError} AUTH on 401, CONNECTION otherwise.
 */
async function fetchSessions(baseUrl, { token, tokenEnvVar, timeoutMs = 5000, signal } = {}) {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const deadline = timeoutSignal(timeoutMs);
	const onDeadline = () => controller.abort(deadline.reason);
	if (deadline.aborted) onDeadline();
	else deadline.addEventListener("abort", onDeadline, { once: true });
	let response;
	let readingBody = false;
	try {
		response = await fetch(`${baseUrl}/api/sessions`, {
			method: "GET",
			redirect: "error",
			headers: { ...authHeaders(token) },
			signal: controller.signal,
		});
		if (response.status === 401) throw authError(baseUrl, tokenEnvVar);
		if (!response.ok) {
			throw new MarimoError("CONNECTION", `The sessions request to ${baseUrl} failed (HTTP ${response.status}): ${await errorDetail(response)}`);
		}
		readingBody = true;
		const raw = await response.json();
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw new MarimoError("CONNECTION", `The sessions response from ${baseUrl} has an unexpected shape.`);
		}
		const sessions = Object.entries(raw).map(([id, value]) => ({
			id,
			path: typeof value?.path === "string" ? value.path : undefined,
			filename: typeof value?.filename === "string" ? value.filename : undefined,
		}));
		return { url: baseUrl, sessions };
	} catch (error) {
		if (signal?.aborted) throw new MarimoError("CONNECTION", "The sessions request was cancelled.");
		if (deadline.aborted) throw new MarimoError("CONNECTION", `The sessions request exceeded its ${timeoutMs} ms deadline.`);
		if (error instanceof MarimoError) throw error;
		if (readingBody) throw new MarimoError("CONNECTION", `The sessions response from ${baseUrl} is not JSON: ${error?.message ?? String(error)}`);
		throw new MarimoError("CONNECTION", `Failed to connect to the marimo server at ${baseUrl}: ${error?.message ?? String(error)}`);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		deadline.removeEventListener("abort", onDeadline);
	}
}

/** Format active sessions for selection errors. */
function sessionListing(sessions) {
	return sessions.map((session) => `  ${session.id}  ${session.path ?? session.filename ?? ""}`).join("\n");
}

/**
 * Resolve `file` or `session`, which are mutually exclusive.
 * Refuse missing or ambiguous matches rather than risk using the wrong kernel.
 * @param {{ id: string, path?: string, filename?: string }[]} sessions
 * @param {{ file?: string, session?: string }} selectors
 * @returns {string} the resolved session id.
 * @throws {MarimoError} CONNECTION with the listing on every miss.
 */
function resolveSessionId(sessions, { file, session } = {}) {
	if (session && file) {
		throw new MarimoError("CONNECTION", "The file and session selectors are mutually exclusive. Pass one.");
	}
	if (session) {
		const exact = sessions.find((entry) => entry.id === session);
		if (!exact) {
			throw new MarimoError("CONNECTION", `No active session matches the session id '${session}'. Active sessions:\n${sessionListing(sessions)}`);
		}
		return exact.id;
	}
	if (file) {
		const matches = sessions.filter((entry) => entry.path === file || entry.filename === file);
		if (matches.length === 0) {
			throw new MarimoError("CONNECTION", `No active session matches the notebook '${file}'. Active sessions:\n${sessionListing(sessions)}`);
		}
		if (matches.length > 1) {
			throw new MarimoError("CONNECTION", `Multiple active sessions match the notebook '${file}'. Pass the exact session id instead. Active sessions:\n${sessionListing(sessions)}`);
		}
		return matches[0].id;
	}
	if (sessions.length === 0) {
		throw new MarimoError("CONNECTION", "No active sessions on the server. Make sure a notebook is open in the browser.");
	}
	if (sessions.length > 1) {
		throw new MarimoError("CONNECTION", `Multiple sessions on the server. Select one with a file or session selector. Active sessions:\n${sessionListing(sessions)}`);
	}
	return sessions[0].id;
}

/** Capture stream text up to `STREAM_CAP_BYTES` and record truncation. */
class StreamCapture {
	constructor() {
		this.text = "";
		this.bytes = 0;
		this.truncated = false;
	}
	/** @param {string} chunk */
	append(chunk) {
		if (this.truncated) return;
		const incoming = Buffer.byteLength(chunk, "utf8");
		if (this.bytes + incoming > STREAM_CAP_BYTES) {
			const room = STREAM_CAP_BYTES - this.bytes;
			this.text += chunk.slice(0, room > 0 ? Math.floor((room / incoming) * chunk.length) : 0);
			this.bytes = STREAM_CAP_BYTES;
			this.truncated = true;
			return;
		}
		this.text += chunk;
		this.bytes += incoming;
	}
}

/**
 * Parse SSE output and its completion payload.
 * Support CRLF, blank-line separators, multiline data, and unterminated records.
 * Preserve non-SSE bytes in `unparsed` so error details are not lost.
 * @param {import("node:stream/web").ReadableStream<Uint8Array>} body
 * @param {{ signal?: AbortSignal }} options
 */
async function parseSseStream(body, { signal } = {}) {
	const stdout = new StreamCapture();
	const stderr = new StreamCapture();
	const unparsed = new StreamCapture();
	let currentEvent;
	let dataLines = [];
	let donePayload;

	const dispatch = () => {
		if (currentEvent === undefined && dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		const event = currentEvent;
		currentEvent = undefined;
		if (event === undefined) {
			// Data without an event has unrecognized SSE framing.
			unparsed.append(`${data}\n`);
			return;
		}
		let payload;
		try {
			payload = JSON.parse(data);
		} catch {
			unparsed.append(`${data}\n`);
			return;
		}
		if (event === "stdout") {
			stdout.append(typeof payload?.data === "string" ? payload.data : "");
		} else if (event === "stderr") {
			stderr.append(typeof payload?.data === "string" ? payload.data : "");
		} else if (event === "done") {
			donePayload = payload;
		} else {
			unparsed.append(`${data}\n`);
		}
	};

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel().catch(() => {});
				throw new MarimoError("STREAM", "Execution was cancelled before the server finished streaming.");
			}
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex;
			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.startsWith("event:")) {
					dispatch();
					currentEvent = line.slice("event:".length).trim();
				} else if (line.startsWith("data:")) {
					dataLines.push(line.slice("data:".length).replace(/^ /, ""));
				} else if (line.trim().length === 0) {
					dispatch();
				} else {
					// Keep non-SSE lines so error bodies can be reported.
					unparsed.append(`${line}\n`);
				}
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) {
			// Preserve an unterminated final line.
			const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
			else if (!line.startsWith("event:")) unparsed.append(`${line}\n`);
		}
		dispatch();
	} finally {
		reader.releaseLock?.();
	}
	return { stdout, stderr, unparsed, donePayload };
}

/**
 * Execute Python in a session scratchpad through `/api/kernel/execute`.
 * Return kernel failures (`done.success === false`) in the result.
 * Throw for cancellation, timeouts, and transport or stream failures.
 * @param {string} baseUrl - normalized base URL.
 * @param {string} code
 * @param {{ token?: string, session?: string, timeoutMs?: number, signal?: AbortSignal, allowRemoteHosts?: string[] }} options
 * @returns {Promise<{ success: boolean, output: string, stdout: string, stderr: string, warnings: string[] }>}
 * @throws {MarimoError} DENIED, AUTH, CONNECTION, or STREAM.
 */
async function executeCode(baseUrl, code, { token, tokenEnvVar, session, timeoutMs = 120000, signal, allowRemoteHosts = [] } = {}) {
	assertHostAllowed(baseUrl, allowRemoteHosts);
	if (typeof code !== "string" || code.length === 0) {
		throw new MarimoError("CONNECTION", "No code was passed to execute.");
	}
	if (!session) {
		throw new MarimoError("CONNECTION", "No session id was resolved for the execute request.");
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const deadline = timeoutSignal(timeoutMs);
	const onDeadline = () => controller.abort(deadline.reason);
	if (deadline.aborted) onDeadline();
	else deadline.addEventListener("abort", onDeadline, { once: true });
	const abortedError = () =>
		new MarimoError("STREAM", signal?.aborted ? "Execution was cancelled." : `Execution exceeded its ${timeoutMs} ms deadline.`);
	let response;
	try {
		response = await fetch(`${baseUrl}/api/kernel/execute`, {
			method: "POST",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				"Marimo-Session-Id": session,
				...authHeaders(token),
			},
			body: JSON.stringify({ code }),
			signal: controller.signal,
		});
		if (response.status === 401) throw authError(baseUrl, tokenEnvVar);
		if (!response.ok) {
			// HTTP errors have no SSE framing. Preserve their `detail`.
			const detail = await errorDetail(response);
			throw new MarimoError("CONNECTION", `The execute request to ${baseUrl} failed (HTTP ${response.status}): ${detail}`);
		}
		if (!response.body) throw new MarimoError("STREAM", "Execution did not complete: the server returned no stream.");
		const { stdout, stderr, unparsed, donePayload } = await parseSseStream(response.body, { signal: controller.signal });
		if (controller.signal.aborted) throw abortedError();
		if (donePayload === undefined) {
			const detail = unparsed.text.trim();
			throw new MarimoError(
				"STREAM",
				`Execution did not complete: the server ended the stream without a result.${detail.length > 0 ? `\n${detail}` : ""}`,
			);
		}
		const warnings = [];
		if (stdout.truncated) warnings.push(`stdout was truncated at ${STREAM_CAP_BYTES} bytes.`);
		if (stderr.truncated) warnings.push(`stderr was truncated at ${STREAM_CAP_BYTES} bytes.`);
		const rawOutput = donePayload?.output;
		const output = typeof rawOutput?.data === "string" && rawOutput.data.length > 0 ? rawOutput.data : "";
		return { success: donePayload?.success === true, output, stdout: stdout.text, stderr: stderr.text, warnings };
	} catch (error) {
		if (controller.signal.aborted) throw abortedError();
		if (error instanceof MarimoError) throw error;
		if (response) throw new MarimoError("STREAM", `Execution stream failed: ${error?.message ?? String(error)}`);
		throw new MarimoError("CONNECTION", `Failed to connect to the marimo server at ${baseUrl}: ${error?.message ?? String(error)}`);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		deadline.removeEventListener("abort", onDeadline);
	}
}

export {
	MarimoError,
	answersMarimo,
	assertHostAllowed,
	discoverServers,
	executeCode,
	fetchSessions,
	isLoopbackHost,
	normalizeBaseUrl,
	processAlive,
	resolveSessionId,
};
