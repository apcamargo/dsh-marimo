/**
 * Test the full plugin flow with harness-shaped mocks and a fake marimo server.
 * Exercise pairing, policy rendering, tool targeting, and teardown through
 * real command and tool handlers.
 *
 * @module @apcamargo/dsh-marimo/e2e
 */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfig } from "../lib/config.js";
import { PairingSessionRecordSchema } from "../lib/state.js";
import { apply, inject, name } from "../lib/index.js";

function sse(event, payload) {
	return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function createFakeMarimo({ executeBehavior = "success", sessions = { s_e2e: { filename: "/tmp/e2e-nb.py", path: "/tmp/e2e-nb.py" } }, sessionStatus = 200, onSessions } = {}) {
	const seen = { executeBodies: [], executeSessionIds: [] };
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (req.url === "/health") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end('{"status":"healthy"}');
				return;
			}
			if (req.url === "/api/sessions") {
				if (onSessions) onSessions(req, res);
				else {
					res.writeHead(sessionStatus, { "content-type": "application/json" });
					res.end(JSON.stringify(sessionStatus === 200 ? sessions : { detail: "unauthorized" }));
				}
				return;
			}
			if (req.url === "/api/kernel/execute" && req.method === "POST") {
				const parsed = JSON.parse(body);
				seen.executeBodies.push(parsed);
				seen.executeSessionIds.push(req.headers["marimo-session-id"]);
				if (req.headers["marimo-session-id"] === "no-such-session") {
					res.writeHead(500, { "content-type": "application/json" });
					res.end('{"detail":"Invalid session id: no-such-session"}');
					return;
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				if (executeBehavior === "hang") {
					// Keep the response pending so the lifetime signal must abort it.
					return;
				}
				res.write(sse("stdout", { data: `ran: ${parsed.code}\n` }));
				res.write(sse("done", { success: true, output: { mimetype: "text/plain", data: "out" } }));
				res.end();
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end('{"detail":"not found"}');
		});
	});
	return { server, seen };
}

async function closeFakeMarimo(fake) {
	fake.server.closeAllConnections();
	await new Promise((resolve) => fake.server.close(resolve));
}

function bounded(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Bounded wait expired after ${ms} ms.`)), ms)),
	]);
}

/** Mock the harness seams used by `apply()`. */
function mockCtx() {
	const state = {
		registeredCommands: [],
		registeredTools: [],
		sections: [],
		skills: [],
		effects: [],
		domainOpened: [],
		domainClosed: [],
		registeredProjections: [],
		teardownOrder: [],
		titleRenames: [],
		titleRefreshes: [],
		listeners: new Map(),
	};
	const table = new Map();
	const titles = new Map();
	// Mock the optional title service. Rename pins a user title, and refresh
	// replaces it with a provider title.
	const sessionTitle = {
		get(session) {
			return titles.get(session);
		},
		rename(session, title) {
			state.titleRenames.push(title);
			const snapshot = { title, messageSeqs: [], source: { kind: "user" }, eventSeq: 0, updatedAt: 0 };
			titles.set(session, snapshot);
			return snapshot;
		},
		async refresh(session) {
			state.titleRefreshes.push(session.id);
			const snapshot = { title: "Automatic title", messageSeqs: [], source: { kind: "provider", provider: "test" }, eventSeq: 1, updatedAt: 1 };
			titles.set(session, snapshot);
			return snapshot;
		},
	};
	const sharedTable = {
		get(id) {
			const raw = table.get(id);
			return raw === undefined ? undefined : PairingSessionRecordSchema.parse(raw);
		},
		async put(id, value) {
			table.set(id, PairingSessionRecordSchema.parse(value));
			return PairingSessionRecordSchema.parse(value);
		},
		async update(id, transform) {
			const raw = table.get(id);
			if (raw === undefined) {
				const error = new Error(`missing key: ${id}`);
				error.code = "missing-key";
				throw error;
			}
			const next = transform(PairingSessionRecordSchema.parse(raw));
			table.set(id, PairingSessionRecordSchema.parse(next));
			return PairingSessionRecordSchema.parse(next);
		},
	};
	const ctx = {
		state,
		table,
		commands: {
			register(definition) {
				state.registeredCommands.push(definition);
				return () => {
					state.registeredCommands.splice(state.registeredCommands.indexOf(definition), 1);
				};
			},
		},
		tools: {
			register(definition) {
				state.registeredTools.push(definition);
				return () => {
					state.registeredTools.splice(state.registeredTools.indexOf(definition), 1);
				};
			},
		},
		systemPrompt: {
			section(section) {
				state.sections.push(section);
				return () => {
					state.sections.splice(state.sections.indexOf(section), 1);
				};
			},
		},
		skills: {
			register(skill) {
				state.skills.push(skill);
				return () => {
					state.skills.splice(state.skills.indexOf(skill), 1);
				};
			},
		},
		get(name) {
			if (name === "sessionTitle") return sessionTitle;
			if (name !== "sessionProjections") return undefined;
			return {
				register(definition) {
					state.registeredProjections.push(definition);
					return () => {
						state.registeredProjections.splice(state.registeredProjections.indexOf(definition), 1);
						state.teardownOrder.push("projection");
					};
				},
			};
		},
		on(name, listener) {
			state.listeners.set(name, listener);
			return () => state.listeners.delete(name);
		},
		storageDomain: {
			open(spec) {
				state.domainOpened.push(spec.name);
				return {
					name: spec.name,
					table: () => sharedTable,
					close: async () => {
						state.domainClosed.push(spec.name);
						state.teardownOrder.push("domain");
					},
				};
			},
		},
		effect(execute, label) {
			for (const disposer of execute()) {
				state.effects.push({ label, disposer });
			}
		},
	};
	return ctx;
}

function makeAgent(id) {
	return {
		id,
		session: { id, header: { cwd: "/tmp" } },
		followups: [],
		followup(message) {
			this.followups.push(message);
		},
	};
}

function seedPairing(ctx, agent, { url, notebookPath, marimoSessionId }) {
	ctx.table.set(
		agent.id,
		PairingSessionRecordSchema.parse({
			active: true,
			url,
			notebookPath,
			marimoSessionId,
		}),
	);
}

async function main() {
	const AGENT = makeAgent("session-e2e-0001");
	const stateHome = await mkdtemp(path.join(tmpdir(), "marimo-pair-e2e-"));
	try {
		const fake = createFakeMarimo({});
		await new Promise((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${fake.server.address().port}`;
		const registryDir = path.join(stateHome, "marimo", "servers");
		await mkdir(registryDir, { recursive: true });
		await writeFile(
			path.join(registryDir, `127.0.0.1_${fake.server.address().port}.json`),
			JSON.stringify({ server_id: `127.0.0.1:${fake.server.address().port}`, pid: process.pid, host: "127.0.0.1", port: fake.server.address().port, base_url: "", started_at: "2026-01-01T00:00:00Z", version: "0.25.1" }),
		);
		process.env.XDG_STATE_HOME = stateHome;

		// --- apply registers every surface ------------------------------------
		const ctx = mockCtx();
		assert.equal(name, "dsh-marimo");
		assert.deepEqual(inject, ["commands", "tools", "systemPrompt", "skills", "storageDomain"]);
		await apply(ctx, {});
		assert.deepEqual(ctx.state.domainOpened, ["dsh_marimo"]);
		assert.equal(ctx.state.registeredCommands.length, 2);
		assert.equal(ctx.state.registeredTools.length, 3);
		assert.equal(ctx.state.registeredProjections.length, 1);
		// The projection key is the host/client contract subscribed to by client.js.
		assert.equal(ctx.state.registeredProjections[0].key, "dsh-marimo:pairing");
		assert.equal(ctx.state.sections.length, 1);
		assert.equal(ctx.state.skills.length, 1);
		const section = ctx.state.sections[0];
		assert.equal(section.name, "dsh-marimo:policy");
		assert.equal(section.order, 550);
		assert.equal(section.interpolate, false);
		const skill = ctx.state.skills[0];
		assert.equal(skill.name, "marimo-pair");
		assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: false });
		assert.ok(skill.content.includes("Required first kernel command"));
		assert.ok(skill.content.includes("StaleCellError"));
		assert.ok(skill.content.includes("Rich Representations"));
		assert.equal(section.text({ agent: AGENT }), "");
		assert.equal(section.text({}), "");

		const pairCommand = ctx.state.registeredCommands.find((definition) => definition.name === "marimo-pair");
		const endCommand = ctx.state.registeredCommands.find((definition) => definition.name === "end-marimo-pair");
		const runPair = (rawInput, agent = AGENT, signal = new AbortController().signal) => pairCommand.handler({ commandId: "e2e-cmd", agent, rawInput, attachments: [], signal });
		const runEnd = (rawInput, agent = AGENT, signal = new AbortController().signal) => endCommand.handler({ commandId: "e2e-cmd", agent, rawInput, attachments: [], signal });

		// --- pairing failure leaves state untouched ----------------------------
		const deadResult = await runPair("http://127.0.0.1:59997");
		assert.equal(deadResult.kind, "error");
		assert.ok(/No marimo answered/.test(deadResult.text));
		assert.equal(ctx.table.get(AGENT.id), undefined);
		// Queue a failure turn in case the user misses the lifecycle row.
		// The model should help, not retry the human command.
		assert.equal(AGENT.followups.length, 1);
		assert.ok(AGENT.followups[0].content[0].text.includes("No marimo answered"));
		assert.ok(AGENT.followups[0].content[0].text.includes("human command"));

		// --- the full pairing flow --------------------------------------------
		const started = await runPair("");
		assert.equal(started.kind, "success", `expected success, got: ${JSON.stringify(started)}`);
		assert.ok(started.text.includes("Pairing started"));
		// Pairing must run the kernel inspection command.
		assert.ok(fake.seen.executeBodies.some((body) => body.code.includes("help(cm)")));
		const record = ctx.table.get(AGENT.id);
		assert.equal(record.active, true);
		assert.equal(record.url, url);
		assert.equal(record.notebookPath, "/tmp/e2e-nb.py");
		assert.equal(record.marimoSessionId, "s_e2e");
		// Pair through the optional title service and record the pin for later re-pairing.
		assert.deepEqual(ctx.state.titleRenames, ["marimo · e2e-nb.py"]);
		assert.equal(record.title, "marimo · e2e-nb.py");
		// Queue the connected turn after the failure turn with facts and a skill pointer.
		assert.equal(AGENT.followups.length, 2);
		assert.ok(AGENT.followups[1].content[0].text.includes(url));
		assert.ok(AGENT.followups[1].content[0].text.includes("marimo-pair"));
		// Only paired sessions receive the policy section.
		const policy = section.text({ agent: AGENT });
		assert.ok(policy.includes(url));
		assert.ok(policy.includes("/tmp/e2e-nb.py"));
		assert.ok(policy.includes("MUST NOT modify the notebook's .py file"));
		assert.equal(section.text({ agent: makeAgent("session-other") }), "");

		const again = await runPair("");
		assert.equal(again.kind, "error");
		assert.ok(/Already pairing/.test(again.text));
		assert.ok(/end-marimo-pair/.test(again.text));
		const byUrl = await runPair(url);
		assert.equal(byUrl.kind, "error");
		// Usage errors stay in the composer and add no conversation turn.
		assert.equal(AGENT.followups.length, 2);

		// --- tools against the paired state -----------------------------------
		const executeTool = ctx.state.registeredTools.find((definition) => definition.name === "marimo_execute_code");
		assert.ok(executeTool);
		const value = await executeTool.execute({ code: "print(df.head())" }, {
			agent: AGENT,
			signal: new AbortController().signal,
		});
		assert.equal(value.success, true);
		assert.equal(value.sessionId, "s_e2e");
		assert.ok(value.stdout.includes("ran: print(df.head())"));
		assert.equal(value.output, "out");
		const rendered = executeTool.output.render({}, value);
		assert.ok(rendered[0].text.includes("never edit the notebook .py"));
		assert.ok(fake.seen.executeBodies.some((body) => body.code === "print(df.head())"));

		// Refresh stale stored session ids from the current session map.
		ctx.table.set(AGENT.id, PairingSessionRecordSchema.parse({ ...record, marimoSessionId: "s_stale" }));
		const refreshed = await executeTool.execute({ code: "1" }, { agent: AGENT, signal: new AbortController().signal });
		assert.equal(refreshed.sessionId, "s_e2e");
		assert.ok(refreshed.warnings.some((warning) => /stale/.test(warning)));
		assert.equal(ctx.table.get(AGENT.id).marimoSessionId, "s_e2e");

		// Without pairing or a URL, return an actionable pairing error.
		const other = makeAgent("session-e2e-0002");
		await assert.rejects(
			executeTool.execute({ code: "1" }, { agent: other, signal: new AbortController().signal }),
			(error) => /Ask the user to run \/marimo-pair/.test(error.message),
		);

		// --- ending the pairing ------------------------------------------------
		const summary = await runEnd("summary");
		assert.equal(summary.kind, "success");
		assert.equal(AGENT.followups.length, 3);
		assert.ok(AGENT.followups[2].content[0].text.includes("Notebook Changes"));
		const doneRecord = ctx.table.get(AGENT.id);
		assert.equal(doneRecord.active, false);
		assert.equal(doneRecord.url, undefined);
		assert.equal(doneRecord.marimoSessionId, undefined);
		// Keep the title pin after ending so the next pairing can recognize it.
		assert.equal(doneRecord.title, "marimo · e2e-nb.py");
		assert.equal(section.text({ agent: AGENT }), "");

		const endAgain = await runEnd("");
		assert.equal(endAgain.kind, "error");
		assert.ok(endAgain.text.includes("/marimo-pair"));

		const live = await runPair("");
		assert.equal(live.kind, "success");
		// Re-pairing must recognize its own pin without renaming again.
		assert.deepEqual(ctx.state.titleRenames, ["marimo · e2e-nb.py"]);
		// Release the pin into automatic naming on the first request after a human message.
		const emit = (type, data) => ctx.state.listeners.get("session/event")(AGENT.session, { type, data });
		emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "Summarize the notebook" }] });
		emit("request/header", { header: {} });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(ctx.state.titleRefreshes, [AGENT.id]);
		assert.equal(ctx.table.get(AGENT.id).title, undefined);
		const status = await runEnd("status");
		assert.equal(status.kind, "success");
		assert.ok(status.text.includes("[healthy]"));
		assert.ok(status.text.includes("s_e2e"));
		const done = await runEnd("done");
		assert.equal(done.kind, "success");

		// Never replace a harness-assigned automatic title on later pairings.
		const afterAutomatic = await runPair("");
		assert.equal(afterAutomatic.kind, "success");
		assert.deepEqual(ctx.state.titleRenames, ["marimo · e2e-nb.py"]);
		assert.equal(ctx.table.get(AGENT.id).title, undefined);
		const doneAgain = await runEnd("done");
		assert.equal(doneAgain.kind, "success");

		// --- select one notebook through the public command grammar -------------
		const multi = createFakeMarimo({ sessions: { a: { path: "/tmp/a.py" }, b: { path: "/tmp/b.py" } } });
		await new Promise((resolve) => multi.server.listen(0, "127.0.0.1", resolve));
		const multiUrl = `http://127.0.0.1:${multi.server.address().port}`;
		const multiAgent = makeAgent("session-e2e-multi-file");
		const ambiguousFile = await runPair(multiUrl, multiAgent);
		assert.equal(ambiguousFile.kind, "error");
		assert.equal(ctx.table.get(multiAgent.id), undefined);
		const selectedFile = await runPair(`${multiUrl} --file /tmp/b.py`, multiAgent);
		assert.equal(selectedFile.kind, "success");
		assert.deepEqual(
			{
				notebookPath: ctx.table.get(multiAgent.id)?.notebookPath,
				marimoSessionId: ctx.table.get(multiAgent.id)?.marimoSessionId,
			},
			{ notebookPath: "/tmp/b.py", marimoSessionId: "b" },
		);
		assert.equal(multi.seen.executeBodies.length, 1);
		assert.deepEqual(multi.seen.executeSessionIds, ["b"]);
		await closeFakeMarimo(multi);

		// --- select an exact session when a file is duplicated ------------------
		const duplicate = createFakeMarimo({ sessions: { first: { path: "/tmp/shared.py" }, second: { path: "/tmp/shared.py" } } });
		await new Promise((resolve) => duplicate.server.listen(0, "127.0.0.1", resolve));
		const duplicateUrl = `http://127.0.0.1:${duplicate.server.address().port}`;
		const duplicateAgent = makeAgent("session-e2e-multi-session");
		const ambiguousSession = await runPair(`${duplicateUrl} --file /tmp/shared.py`, duplicateAgent);
		assert.equal(ambiguousSession.kind, "error");
		assert.equal(ctx.table.get(duplicateAgent.id), undefined);
		const selectedSession = await runPair(`${duplicateUrl} --session second`, duplicateAgent);
		assert.equal(selectedSession.kind, "success");
		assert.equal(ctx.table.get(duplicateAgent.id)?.marimoSessionId, "second");
		assert.equal(duplicate.seen.executeBodies.length, 1);
		assert.deepEqual(duplicate.seen.executeSessionIds, ["second"]);
		await closeFakeMarimo(duplicate);

		// --- filename-only pairing retains identity and title -------------------
		const filenameOnly = createFakeMarimo({ sessions: { only: { filename: "/tmp/filename-only.py" } } });
		await new Promise((resolve) => filenameOnly.server.listen(0, "127.0.0.1", resolve));
		const filenameUrl = `http://127.0.0.1:${filenameOnly.server.address().port}`;
		const filenameAgent = makeAgent("session-e2e-filename-only");
		const renamesBefore = ctx.state.titleRenames.length;
		const filenameResult = await runPair(filenameUrl, filenameAgent);
		assert.equal(filenameResult.kind, "success");
		assert.equal(ctx.table.get(filenameAgent.id)?.notebookPath, "/tmp/filename-only.py");
		assert.deepEqual(ctx.state.titleRenames.slice(renamesBefore), ["marimo · filename-only.py"]);
		assert.equal(filenameOnly.seen.executeBodies.length, 1);
		await closeFakeMarimo(filenameOnly);

		// --- ambiguous and unknown sessions cannot be silently refreshed -------
		const duplicateRefresh = createFakeMarimo({ sessions: { first: { path: "/tmp/paired.py" }, second: { path: "/tmp/paired.py" } } });
		await new Promise((resolve) => duplicateRefresh.server.listen(0, "127.0.0.1", resolve));
		const duplicateRefreshUrl = `http://127.0.0.1:${duplicateRefresh.server.address().port}`;
		for (const [suffix, runStatus] of [["pair", runPair], ["end", runEnd]]) {
			const agent = makeAgent(`session-e2e-duplicate-refresh-${suffix}`);
			seedPairing(ctx, agent, { url: duplicateRefreshUrl, notebookPath: "/tmp/paired.py", marimoSessionId: "stale" });
			await runStatus("status", agent);
			assert.equal(ctx.table.get(agent.id)?.marimoSessionId, "stale");
		}
		await closeFakeMarimo(duplicateRefresh);

		const unknownRefresh = createFakeMarimo({ sessions: { other: { filename: "/tmp/other.py" }, expected: { filename: "/tmp/expected.py" } } });
		await new Promise((resolve) => unknownRefresh.server.listen(0, "127.0.0.1", resolve));
		const unknownRefreshUrl = `http://127.0.0.1:${unknownRefresh.server.address().port}`;
		for (const [suffix, runStatus] of [["pair", runPair], ["end", runEnd]]) {
			const agent = makeAgent(`session-e2e-unknown-refresh-${suffix}`);
			seedPairing(ctx, agent, { url: unknownRefreshUrl, notebookPath: undefined, marimoSessionId: "stale" });
			await runStatus("status", agent);
			assert.equal(ctx.table.get(agent.id)?.marimoSessionId, "stale");
		}
		await closeFakeMarimo(unknownRefresh);

		// --- status preserves meaningful authentication and policy failures ----
		const unauthorized = createFakeMarimo({ sessionStatus: 401 });
		await new Promise((resolve) => unauthorized.server.listen(0, "127.0.0.1", resolve));
		const unauthorizedUrl = `http://127.0.0.1:${unauthorized.server.address().port}`;
		for (const [suffix, runStatus] of [["pair", runPair], ["end", runEnd]]) {
			const agent = makeAgent(`session-e2e-auth-status-${suffix}`);
			seedPairing(ctx, agent, { url: unauthorizedUrl, notebookPath: "/tmp/paired.py", marimoSessionId: "stored" });
			const result = await runStatus("status", agent);
			assert.equal(result.kind, "error");
			assert.match(result.text, /MARIMO_TOKEN/);
		}
		await closeFakeMarimo(unauthorized);

		for (const [suffix, runStatus] of [["pair", runPair], ["end", runEnd]]) {
			const agent = makeAgent(`session-e2e-denied-status-${suffix}`);
			seedPairing(ctx, agent, { url: "http://example.com", notebookPath: "/tmp/paired.py", marimoSessionId: "stored" });
			const result = await runStatus("status", agent);
			assert.equal(result.kind, "error");
			assert.match(result.text, /denied by default/);
			assert.match(result.text, /allowRemoteHosts/);
		}

		// --- status cancellation reaches the caller -----------------------------
		for (const [suffix, runStatus] of [["pair", runPair], ["end", runEnd]]) {
			let requestSeen;
			const seen = new Promise((resolve) => {
				requestSeen = resolve;
			});
			const stalled = createFakeMarimo({
				onSessions: () => {
					requestSeen();
				},
			});
			await new Promise((resolve) => stalled.server.listen(0, "127.0.0.1", resolve));
			const stalledUrl = `http://127.0.0.1:${stalled.server.address().port}`;
			const agent = makeAgent(`session-e2e-cancel-status-${suffix}`);
			seedPairing(ctx, agent, { url: stalledUrl, notebookPath: "/tmp/paired.py", marimoSessionId: "stored" });
			const controller = new AbortController();
			const pendingStatus = runStatus("status", agent, controller.signal);
			await seen;
			controller.abort();
			const result = await bounded(pendingStatus, 1000);
			assert.equal(result.kind, "error");
			assert.equal(result.text, "Pairing cancelled.");
			await closeFakeMarimo(stalled);
		}

		// --- teardown ordering -------------------------------------------------
		for (const effect of [...ctx.state.effects].reverse()) {
			await effect.disposer?.();
		}
		assert.deepEqual(ctx.state.domainClosed, ["dsh_marimo"]);
		assert.equal(ctx.state.registeredCommands.length, 0);
		assert.equal(ctx.state.registeredTools.length, 0);
		assert.equal(ctx.state.sections.length, 0);
		assert.equal(ctx.state.skills.length, 0);
		assert.equal(ctx.state.registeredProjections.length, 0);
		// Unregister title listeners before closing the domain so no event can
		// read closed storage.
		assert.equal(ctx.state.listeners.size, 0);
		// Release the projection before closing the domain so wire views never read closed storage.
		assert.deepEqual(ctx.state.teardownOrder, ["projection", "domain"]);

		// --- unload mid-tool: the lifetime signal aborts the call --------------
		// With no pairing, call the tool by explicit URL against a hung server.
		// Only the plugin lifetime signal can settle the call.
		const hangCtx = mockCtx();
		const hang = createFakeMarimo({ executeBehavior: "hang" });
		await new Promise((resolve) => hang.server.listen(0, "127.0.0.1", resolve));
		await apply(hangCtx, resolveConfig({}));
		const hangTool = hangCtx.state.registeredTools.find((definition) => definition.name === "marimo_execute_code");
		const hangAgent = makeAgent("session-e2e-0003");
		const pending = hangTool.execute({ code: "1", url }, { agent: hangAgent, signal: new AbortController().signal });
		const disposition = { settled: false };
		pending.then(
			() => {
				disposition.settled = true;
			},
			() => {
				disposition.settled = true;
			},
		);
		// Unload aborts pending tools, drains them, then closes the domain.
		for (const effect of [...hangCtx.state.effects].reverse()) {
			await effect.disposer?.();
		}
		assert.equal(disposition.settled, true);
		assert.deepEqual(hangCtx.state.domainClosed, ["dsh_marimo"]);
		assert.equal(hangCtx.state.registeredTools.length, 0);
		await closeFakeMarimo(hang);
		await closeFakeMarimo(fake);
	} finally {
		delete process.env.XDG_STATE_HOME;
		await rm(stateHome, { recursive: true, force: true });
	}
	console.log("e2e: all assertions passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
