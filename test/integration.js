/**
 * Test `lib/marimo.js` against a fake server using live-verified responses.
 * Also test registry discovery under a temporary `XDG_STATE_HOME`.
 *
 * @module @apcamargo/dsh-marimo/integration
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
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
} from "../lib/marimo.js";

/** Return one LF-terminated SSE event frame. */
function sse(event, payload) {
	return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bounded(promise, ms) {
	return Promise.race([
		promise,
		delay(ms).then(() => {
			throw new Error(`Bounded wait expired after ${ms} ms.`);
		}),
	]);
}

/**
 * Fake marimo server. `executeBehavior` selects the response scenario:
 * success | failure | no-done | crlf | unterminated | huge | hang | stream-hang.
 * `sessionsBehavior` can hold a partial JSON response open with `partial-hang`.
 */
function createFakeMarimo({ healthy = true, sessions = {}, token = null, executeBehavior = "success", sessionsBehavior = "success" } = {}) {
	const seen = { authHeaders: [], executeBodies: [] };
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			seen.authHeaders.push(req.headers["authorization"] ?? null);
			if (req.url === "/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(healthy ? '{"status":"healthy"}' : '{"status":"down"}');
				return;
			}
			if (req.url === "/api/sessions") {
				if (token && req.headers["authorization"] !== `Bearer ${token}`) {
					res.writeHead(401, { "content-type": "application/json" });
					res.end('{"detail":"unauthorized"}');
					return;
				}
				if (sessionsBehavior === "partial-hang") {
					res.writeHead(200, { "content-type": "application/json" });
					res.write('{"stale":{"path":"/tmp/paired.py"}');
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(sessions));
				return;
			}
			if (req.url === "/api/kernel/execute" && req.method === "POST") {
				if (token && req.headers["authorization"] !== `Bearer ${token}`) {
					res.writeHead(401, { "content-type": "application/json" });
					res.end('{"detail":"unauthorized"}');
					return;
				}
				const parsed = JSON.parse(body);
				seen.executeBodies.push(parsed);
				if (req.headers["marimo-session-id"] === "no-such-session") {
					// Live marimo returns an HTTP error body here, not a stream.
					res.writeHead(500, { "content-type": "application/json" });
					res.end('{"detail":"Invalid session id: no-such-session"}');
					return;
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				switch (executeBehavior) {
					case "success": {
						res.write(sse("stdout", { data: `ran: ${parsed.code}\n` }));
						res.write(sse("done", { success: true, output: { mimetype: "text/plain", data: "out" } }));
						res.end();
						return;
					}
					case "failure": {
						res.write(sse("stderr", { data: "line 1\n    def broken(:\nSyntaxError: invalid syntax\n" }));
						res.write(sse("done", { success: false, output: { mimetype: "text/plain", data: "" } }));
						res.end();
						return;
					}
					case "no-done": {
						res.write(sse("stdout", { data: "partial\n" }));
						res.end();
						return;
					}
					case "crlf": {
						res.write(`event: stdout\r\ndata: {"data": "crlf out\\n"}\r\n\r\n`);
						res.write(`event: done\r\ndata: ${JSON.stringify({ success: true, output: { mimetype: "text/plain", data: "" } })}\r\n\r\n`);
						res.end();
						return;
					}
					case "unterminated": {
						// The final data line can omit its newline, like an error body.
						res.write(sse("stdout", { data: "early\n" }));
						res.write(`event: done\ndata: ${JSON.stringify({ success: true, output: { mimetype: "text/plain", data: "tail out" } })}`);
						res.end();
						return;
					}
					case "huge": {
						res.write(sse("stdout", { data: "x".repeat(300 * 1024) }));
						res.write(sse("done", { success: true, output: { mimetype: "text/plain", data: "" } }));
						res.end();
						return;
					}
					case "hang": {
						// Keep the response pending so the caller's deadline must fire.
						return;
					}
					case "stream-hang": {
						// Exercise cancellation after an SSE event has reached the client.
						res.write(sse("stdout", { data: "started\n" }));
						return;
					}
					default: {
						res.end();
					}
				}
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end('{"detail":"not found"}');
		});
	});
	return { server, seen };
}

/** Registry entry in marimo's on-disk format. */
function registryEntry(serverId, pid, host, port, version = "0.25.1") {
	return {
		server_id: serverId,
		pid,
		host,
		port,
		base_url: "",
		started_at: "2026-10-08T22:50:42.553356+00:00",
		version,
	};
}

/** Return a pid that has exited. */
function deadPid() {
	return new Promise((resolve) => {
		const child = spawn("true");
		child.on("close", () => resolve(child.pid));
	});
}

async function main() {
	// --- pure helpers ---------------------------------------------------------
	assert.deepEqual(normalizeBaseUrl("http://localhost:2718/"), "http://localhost:2718");
	assert.deepEqual(normalizeBaseUrl("http://user:pass@example.com:2718"), "http://example.com:2718");
	assert.throws(() => normalizeBaseUrl("ftp://example.com"), (error) => error instanceof MarimoError && error.code === "DENIED");
	assert.throws(() => normalizeBaseUrl("not a url"), (error) => error instanceof MarimoError && error.code === "CONNECTION");
	assert.equal(isLoopbackHost("localhost"), true);
	assert.equal(isLoopbackHost("127.0.0.1"), true);
	assert.equal(isLoopbackHost("::1"), true);
	assert.equal(isLoopbackHost("example.com"), false);
	assertHostAllowed("http://localhost:2718", []);
	assertHostAllowed("http://example.com", ["example.com", "other.com"]);
	assert.throws(() => assertHostAllowed("http://example.com", []), (error) => error instanceof MarimoError && error.code === "DENIED");
	assertHostAllowed("http://EXAMPLE.com", ["example.com"]);
	// Return codes: 0 alive, 1 exited, 2 cannot check.
	assert.equal(processAlive(process.pid), 0);
	assert.equal(processAlive("abc"), 2);
	assert.equal(processAlive(0), 2);
	const gonePid = await deadPid();
	assert.equal(processAlive(gonePid), 1);

	// --- fake server ----------------------------------------------------------
	const base = { sessions: { s_v3lz54: { filename: "/tmp/nb.py", path: "/tmp/nb.py" } } };

	{
		const fake = createFakeMarimo({ ...base });
		await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${fake.server.address().port}`;

		assert.equal(await answersMarimo(url, { timeoutMs: 2000 }), true);
		assert.equal(await answersMarimo("http://127.0.0.1:1", { timeoutMs: 300 }), false);

		// /api/sessions: normalized, empty, and multiple sessions.
		const one = await fetchSessions(url, { timeoutMs: 5000 });
		assert.deepEqual(one.sessions, [{ id: "s_v3lz54", path: "/tmp/nb.py", filename: "/tmp/nb.py" }]);
		const empty = createFakeMarimo({ sessions: {} });
		await new Promise((resolve) => empty.server.listen(0, "127.0.0.1", resolve));
		assert.deepEqual((await fetchSessions(`http://127.0.0.1:${empty.server.address().port}`, {})).sessions, []);
		const many = createFakeMarimo({ sessions: { s_a: { path: "/tmp/a.py" }, s_b: { filename: "/tmp/b.py" } } });
		await new Promise((resolve) => many.server.listen(0, "127.0.0.1", resolve));
		const manySessions = (await fetchSessions(`http://127.0.0.1:${many.server.address().port}`, {})).sessions;
		assert.equal(manySessions.length, 2);
		assert.equal(manySessions[0].filename, undefined);

		// Session resolution must not guess on a miss.
		assert.equal(resolveSessionId(one.sessions, {}), "s_v3lz54");
		assert.equal(resolveSessionId(one.sessions, { session: "s_v3lz54" }), "s_v3lz54");
		assert.equal(resolveSessionId(one.sessions, { file: "/tmp/nb.py" }), "s_v3lz54");
		assert.throws(() => resolveSessionId(one.sessions, { session: "no-such-session", file: "/tmp/nb.py" }), /mutually exclusive/);
		assert.throws(() => resolveSessionId(one.sessions, { session: "s_other" }), /No active session matches/);
		assert.throws(() => resolveSessionId(one.sessions, { file: "/tmp/none.py" }), /No active session matches/);
		assert.throws(() => resolveSessionId(manySessions, {}), /Multiple sessions/);
		assert.equal(resolveSessionId(manySessions, { file: "/tmp/a.py" }), "s_a");
		assert.throws(() => resolveSessionId([], {}), /No active sessions/);

		const ok = await executeCode(url, "print(1+1)", { session: "s_v3lz54", timeoutMs: 5000 });
		assert.equal(ok.success, true);
		assert.ok(ok.stdout.includes("ran: print(1+1)"));
		assert.equal(ok.output, "out");
		assert.deepEqual(ok.warnings, []);
		// Send exactly the code body and session-id header.
		assert.deepEqual(fake.seen.executeBodies[0], { code: "print(1+1)" });

		// execute: kernel failure returns an error result instead of throwing.
		const failed = createFakeMarimo({ sessions: base.sessions, executeBehavior: "failure" });
		await new Promise((resolve) => failed.server.listen(0, "127.0.0.1", resolve));
		const failedUrl = `http://127.0.0.1:${failed.server.address().port}`;
		const bad = await executeCode(failedUrl, "def broken(:", { session: "s_v3lz54", timeoutMs: 5000 });
		assert.equal(bad.success, false);
		assert.ok(bad.stderr.includes("SyntaxError"));

		// execute: a missing done event throws STREAM.
		const noDone = createFakeMarimo({ sessions: base.sessions, executeBehavior: "no-done" });
		await new Promise((resolve) => noDone.server.listen(0, "127.0.0.1", resolve));
		await assert.rejects(
			executeCode(`http://127.0.0.1:${noDone.server.address().port}`, "1", { session: "s_v3lz54", timeoutMs: 5000 }),
			(error) => error instanceof MarimoError && error.code === "STREAM" && /did not complete/.test(error.message),
		);

		// execute: parse CRLF framing and unterminated final lines.
		const crlf = createFakeMarimo({ sessions: base.sessions, executeBehavior: "crlf" });
		await new Promise((resolve) => crlf.server.listen(0, "127.0.0.1", resolve));
		const crlfResult = await executeCode(`http://127.0.0.1:${crlf.server.address().port}`, "1", { session: "s_v3lz54", timeoutMs: 5000 });
		assert.equal(crlfResult.success, true);
		assert.ok(crlfResult.stdout.includes("crlf out"));
		const unterminated = createFakeMarimo({ sessions: base.sessions, executeBehavior: "unterminated" });
		await new Promise((resolve) => unterminated.server.listen(0, "127.0.0.1", resolve));
		const tailResult = await executeCode(`http://127.0.0.1:${unterminated.server.address().port}`, "1", { session: "s_v3lz54", timeoutMs: 5000 });
		assert.equal(tailResult.success, true);
		assert.equal(tailResult.output, "tail out");

		// execute: surface HTTP-500 error details.
		await assert.rejects(
			executeCode(url, "1", { session: "no-such-session", timeoutMs: 5000 }),
			(error) => error instanceof MarimoError && error.code === "CONNECTION" && /Invalid session id: no-such-session/.test(error.message),
		);

		// execute: truncate capped output with a marker.
		const huge = createFakeMarimo({ sessions: base.sessions, executeBehavior: "huge" });
		await new Promise((resolve) => huge.server.listen(0, "127.0.0.1", resolve));
		const hugeResult = await executeCode(`http://127.0.0.1:${huge.server.address().port}`, "1", { session: "s_v3lz54", timeoutMs: 5000 });
		assert.equal(hugeResult.success, true);
		assert.ok(hugeResult.stdout.length <= 256 * 1024 + 64);
		assert.ok(hugeResult.warnings.some((warning) => /truncated/.test(warning)));

		// execute: a hung server hits the caller's deadline.
		const hang = createFakeMarimo({ sessions: base.sessions, executeBehavior: "hang" });
		await new Promise((resolve) => hang.server.listen(0, "127.0.0.1", resolve));
		await assert.rejects(
			executeCode(`http://127.0.0.1:${hang.server.address().port}`, "1", { session: "s_v3lz54", timeoutMs: 250 }),
			(error) => error instanceof MarimoError && error.code === "STREAM" && /deadline/.test(error.message),
		);

		// execute: aborting rejects the call.
		const controller = new AbortController();
		const pending = executeCode(`http://127.0.0.1:${hang.server.address().port}`, "1", {
			session: "s_v3lz54",
			timeoutMs: 30000,
			signal: controller.signal,
		});
		controller.abort();
		await assert.rejects(pending, (error) => error instanceof MarimoError && error.code === "STREAM" && /cancelled/.test(error.message));

		// Deadlines and caller cancellation continue after streamed SSE output begins.
		const streamDeadline = createFakeMarimo({ sessions: base.sessions, executeBehavior: "stream-hang" });
		await new Promise((resolve) => streamDeadline.server.listen(0, "127.0.0.1", resolve));
		const deadlinePending = executeCode(`http://127.0.0.1:${streamDeadline.server.address().port}`, "1", { session: "s_v3lz54", timeoutMs: 300 });
		await delay(100);
		await assert.rejects(
			bounded(deadlinePending, 700),
			(error) => error instanceof MarimoError && error.code === "STREAM" && /deadline/.test(error.message),
		);

		const streamAbort = createFakeMarimo({ sessions: base.sessions, executeBehavior: "stream-hang" });
		await new Promise((resolve) => streamAbort.server.listen(0, "127.0.0.1", resolve));
		const streamController = new AbortController();
		const streamPending = executeCode(`http://127.0.0.1:${streamAbort.server.address().port}`, "1", {
			session: "s_v3lz54",
			timeoutMs: 5000,
			signal: streamController.signal,
		});
		await delay(100);
		streamController.abort();
		await assert.rejects(
			bounded(streamPending, 700),
			(error) => error instanceof MarimoError && error.code === "STREAM" && /cancelled/.test(error.message),
		);

		// Caller cancellation also covers a partial sessions JSON response.
		const partialSessions = createFakeMarimo({ sessions: base.sessions, sessionsBehavior: "partial-hang" });
		await new Promise((resolve) => partialSessions.server.listen(0, "127.0.0.1", resolve));
		const sessionsController = new AbortController();
		const sessionsPending = fetchSessions(`http://127.0.0.1:${partialSessions.server.address().port}`, {
			timeoutMs: 5000,
			signal: sessionsController.signal,
		});
		await delay(100);
		sessionsController.abort();
		await assert.rejects(
			bounded(sessionsPending, 700),
			(error) => error instanceof MarimoError && error.code === "CONNECTION" && /cancelled/.test(error.message),
		);

		for (const extra of [empty, many, failed, noDone, crlf, unterminated, huge, hang, streamDeadline, streamAbort, partialSessions]) {
			await new Promise((resolve) => extra.server.close(resolve));
		}
		await new Promise((resolve) => fake.server.close(resolve));
	}

	// --- auth -----------------------------------------------------------------
	{
		const fake = createFakeMarimo({ ...base, token: "sekrit" });
		await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${fake.server.address().port}`;
		await assert.rejects(
			fetchSessions(url, { timeoutMs: 5000 }),
			(error) => error instanceof MarimoError && error.code === "AUTH" && /MARIMO_TOKEN/.test(error.message),
		);
		await assert.rejects(
			executeCode(url, "1", { session: "s_v3lz54", timeoutMs: 5000 }),
			(error) => error instanceof MarimoError && error.code === "AUTH" && /MARIMO_TOKEN/.test(error.message),
		);
		// Custom token variable names replace the default in errors.
		await assert.rejects(
			fetchSessions(url, { timeoutMs: 5000, tokenEnvVar: "MY_TOKEN" }),
			(error) => error instanceof MarimoError && error.code === "AUTH" && /MY_TOKEN/.test(error.message) && !/MARIMO_TOKEN/.test(error.message),
		);
		const ok = await fetchSessions(url, { token: "sekrit", timeoutMs: 5000 });
		assert.equal(ok.sessions.length, 1);
		await executeCode(url, "1", { token: "sekrit", session: "s_v3lz54", timeoutMs: 5000 });
		// Send bearer auth to sessions and execute, never to /health.
		assert.equal(fake.seen.authHeaders.filter((header) => header === "Bearer sekrit").length >= 2, true);
		await new Promise((resolve) => fake.server.close(resolve));
	}

	// --- discovery over a temporary XDG_STATE_HOME -----------------------------
	const stateHome = await mkdtemp(path.join(tmpdir(), "marimo-pair-registry-"));
	try {
		const fake = createFakeMarimo({ ...base });
		await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
		const port = fake.server.address().port;
		const registryDir = path.join(stateHome, "marimo", "servers");
		await mkdir(registryDir, { recursive: true });
		await writeFile(path.join(registryDir, `127.0.0.1_${port}.json`), JSON.stringify(registryEntry(`127.0.0.1:${port}`, process.pid, "127.0.0.1", port)));
		// Exited process on a closed port.
		const gone = await deadPid();
		await writeFile(path.join(registryDir, "127.0.0.1_59999.json"), JSON.stringify(registryEntry("127.0.0.1:59999", gone, "127.0.0.1", 59999)));
		// A pid that cannot be checked.
		await writeFile(path.join(registryDir, "127.0.0.1_59998.json"), JSON.stringify(registryEntry("127.0.0.1:59998", "not-a-pid", "127.0.0.1", 59998)));

		process.env.XDG_STATE_HOME = stateHome;
		try {
			const { servers, unreachable } = await discoverServers({ healthTimeoutMs: 2000 });
			assert.equal(servers.length, 1);
			assert.equal(servers[0].url, `http://127.0.0.1:${port}`);
			assert.equal(servers[0].serverId, `127.0.0.1:${port}`);
			assert.equal(servers[0].version, "0.25.1");
			assert.equal(unreachable.length, 2);
			// Dead pids report ESRCH. Uncheckable pids must not look dead.
			const goneEntry = unreachable.find((entry) => entry.serverId === "127.0.0.1:59999");
			assert.ok(/PID/.test(goneEntry.reason));
			const uncertainEntry = unreachable.find((entry) => entry.serverId === "127.0.0.1:59998");
			assert.ok(/cannot be checked/.test(uncertainEntry.reason));
		} finally {
			delete process.env.XDG_STATE_HOME;
		}

		// Extra registries augment the platform default.
		// An empty default registry isolates this test.
		const emptyHome = await mkdtemp(path.join(tmpdir(), "marimo-pair-empty-"));
		const extraDir = await mkdtemp(path.join(tmpdir(), "marimo-pair-extra-"));
		try {
			await mkdir(path.join(extraDir, "marimo", "servers"), { recursive: true });
			await writeFile(path.join(extraDir, "marimo", "servers", `localhost_${port}.json`), JSON.stringify(registryEntry(`localhost:${port}`, process.pid, "localhost", port)));
			await writeFile(path.join(extraDir, "marimo", "servers", `127.0.0.1_${port}.json`), JSON.stringify(registryEntry(`127.0.0.1:${port}`, process.pid, "127.0.0.1", port)));
			process.env.XDG_STATE_HOME = emptyHome;
			const { servers } = await discoverServers({ healthTimeoutMs: 2000, extraRegistryDirs: [path.join(extraDir, "marimo", "servers")] });
			assert.ok(servers.some((server) => server.url === `http://127.0.0.1:${port}`));
			assert.ok(servers.some((server) => server.url === `http://localhost:${port}`));
		} finally {
			delete process.env.XDG_STATE_HOME;
			await rm(emptyHome, { recursive: true, force: true });
			await rm(extraDir, { recursive: true, force: true });
		}

		// Unhealthy responses fail discovery.
		// Remove the live entry to isolate this case.
		await rm(path.join(registryDir, `127.0.0.1_${port}.json`));
		const unhealthy = createFakeMarimo({ sessions: base.sessions, healthy: false });
		await new Promise((resolve) => unhealthy.server.listen(0, "127.0.0.1", resolve));
		const unhealthyPort = unhealthy.server.address().port;
		await writeFile(path.join(registryDir, `127.0.0.1_${unhealthyPort}.json`), JSON.stringify(registryEntry(`127.0.0.1:${unhealthyPort}`, process.pid, "127.0.0.1", unhealthyPort)));
		process.env.XDG_STATE_HOME = stateHome;
		try {
			const { servers, unreachable } = await discoverServers({ healthTimeoutMs: 2000 });
			assert.equal(servers.length, 0);
			assert.ok(unreachable.some((entry) => entry.serverId === `127.0.0.1:${unhealthyPort}` && /running/.test(entry.reason)));
		} finally {
			delete process.env.XDG_STATE_HOME;
		}
		await new Promise((resolve) => unhealthy.server.close(resolve));
		await new Promise((resolve) => fake.server.close(resolve));
	} finally {
		await rm(stateHome, { recursive: true, force: true });
	}

	console.log("integration: all assertions passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
