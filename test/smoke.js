/**
 * Test command grammar, prompts, config, and state over mock services.
 * Schema-validating tables mirror the durable read boundary.
 *
 * @module @apcamargo/dsh-marimo/smoke
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MarimoError } from "../lib/marimo.js";
import { PAIRING_SUMMARY_PROMPT, POLICY_FALLBACK, buildConnectedPrompt, renderPairingPolicy, truncate } from "../lib/prompts.js";
import { PairingSessionRecordSchema, clearActivePairing, getSessionRecord, releasePinnedTitle, setActivePairing, updateMarimoSessionId } from "../lib/state.js";
import { resolveConfig } from "../lib/config.js";
import { boundaryError, executeEndMarimoPair, executeMarimoPair, parseEndArgs, parsePairArgs, registerCommands, tokenizeArgs } from "../lib/commands.js";
import { PAIRING_PROJECTION_KEY, PairingWireSchema, createPairingProjection, registerPairingProjection } from "../lib/projection.js";
import { resolveBaseUrl, resolveTargetSession, UNPAIRED_MESSAGE } from "../lib/tools.js";
import { mayReplaceTitle, notebookName, pairingSessionTitle, pinPairingTitle, registerTitleRelease, serverLabel, userMessageText } from "../lib/title.js";

/**
 * Storage table mock that validates every read and write with the real zod schema.
 */
function schemaValidatingTable() {
	const map = new Map();
	return {
		map,
		get(id) {
			const raw = map.get(id);
			return raw === undefined ? undefined : PairingSessionRecordSchema.parse(raw);
		},
		async put(id, value) {
			map.set(id, PairingSessionRecordSchema.parse(value));
			return PairingSessionRecordSchema.parse(value);
		},
		async update(id, transform) {
			const raw = map.get(id);
			if (raw === undefined) {
				const error = new Error(`missing key: ${id}`);
				error.code = "missing-key";
				throw error;
			}
			const next = transform(PairingSessionRecordSchema.parse(raw));
			map.set(id, PairingSessionRecordSchema.parse(next));
			return PairingSessionRecordSchema.parse(next);
		},
	};
}

function mockDomain() {
	const table = schemaValidatingTable();
	return {
		table: () => table,
		closed: false,
		async close() {
			this.closed = true;
		},
	};
}

/** Harness context mock for command registrations and effects. */
function mockCtx() {
	const registered = [];
	const effects = [];
	return {
		registered,
		effects,
		commands: {
			register(definition) {
				registered.push(definition);
				return () => {
					registered.splice(registered.indexOf(definition), 1);
				};
			},
		},
		effect(execute, label) {
			for (const disposer of execute()) {
				effects.push({ label, disposer });
			}
		},
	};
}

function commandInvocation(rawInput, overrides = {}) {
	const controller = new AbortController();
	return {
		commandId: "smoke-command-id",
		agent: { id: "session-smoke-0001", session: { header: { cwd: "/tmp" } }, followups: [], followup(message) { this.followups.push(message); } },
		rawInput,
		attachments: [],
		signal: controller.signal,
		controller,
		...overrides,
	};
}

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/** Compile a consumer against the declarations in the actual npm artifact. */
async function assertPackedTypeConsumer() {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), "marimo-public-types-"));
	try {
		const { stdout } = await execFileAsync(
			npmCommand,
			["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot, "--cache", path.join(temporaryRoot, "cache")],
			{ cwd: projectRoot, maxBuffer: 1024 * 1024 },
		);
		const report = JSON.parse(stdout)[0];
		await execFileAsync("tar", ["-xzf", path.join(temporaryRoot, report.filename), "-C", temporaryRoot]);
		await symlink(
			path.join(projectRoot, "node_modules"),
			path.join(temporaryRoot, "package", "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const consumer = path.join(temporaryRoot, "consumer.ts");
		await writeFile(
			consumer,
			[
				'import { apply, Config, inject, name, POLICY_SECTION } from "./package/lib/types/index.js";',
				'import type { PairingSessionRecord } from "./package/lib/types/index.js";',
				"const record: PairingSessionRecord = { active: false };",
				"void [apply, Config, inject, name, POLICY_SECTION, record];",
				"",
			].join("\n"),
		);
		await writeFile(path.join(temporaryRoot, "package.json"), '{ "type": "module" }\n');
		await execFileAsync(
			process.execPath,
			[
				path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
				"--noEmit",
				"--strict",
				"--module",
				"NodeNext",
				"--moduleResolution",
				"NodeNext",
				"--target",
				"ES2022",
				"--skipLibCheck",
				"false",
				consumer,
			],
			{ cwd: temporaryRoot, maxBuffer: 1024 * 1024 },
		);
	} finally {
		if (path.dirname(temporaryRoot) !== tmpdir() || !path.basename(temporaryRoot).startsWith("marimo-public-types-")) {
			throw new Error(`Refusing to remove unexpected temporary path: ${temporaryRoot}`);
		}
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function main() {
	// --- plugin shape ---------------------------------------------------------
	const plugin = await import("../lib/index.js");
	assert.equal(plugin.name, "dsh-marimo");
	assert.deepEqual(plugin.inject, ["commands", "tools", "systemPrompt", "skills", "storageDomain"]);
	assert.equal(plugin.POLICY_SECTION.name, "dsh-marimo:policy");
	assert.equal(plugin.POLICY_SECTION.order, 550);

	// --- packaging guard -------------------------------------------------------
	// Every flat lib/*.js must appear in npm's `files` include list so packaged
	// imports resolve. The lib/types/ subtree is covered by its glob entry.
	const listedFiles = new Set(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).files);
	for (const entry of readdirSync(new URL("../lib", import.meta.url))) {
		if (entry.endsWith(".js")) assert.ok(listedFiles.has(`lib/${entry}`), `lib/${entry} is missing from package.json "files"`);
	}
	assert.ok(listedFiles.has("assets/*.svg"));
	await assertPackedTypeConsumer();

	// --- config ---------------------------------------------------------------
	const config = resolveConfig({});
	assert.equal(config.executeTimeoutMs, 120000);
	assert.equal(config.healthTimeoutMs, 2000);
	assert.equal(config.sessionsTimeoutMs, 5000);
	assert.equal(config.tokenEnvVar, "MARIMO_TOKEN");
	assert.deepEqual(config.extraRegistryDirs, []);
	assert.deepEqual(config.allowRemoteHosts, []);
	assert.throws(() => resolveConfig({ executeTimeoutMs: 10 }), /expected number >= 1000/);
	assert.throws(() => resolveConfig({ healthTimeoutMs: -1 }), /expected number >= 250/);
	assert.throws(() => resolveConfig({ executeTimeoutMs: 2 ** 33 }), /expected number <= 2147483647/);
	assert.throws(() => resolveConfig({ tokenEnvVar: 42 }), /expected string/);
	const custom = resolveConfig({ executeTimeoutMs: 5000, tokenEnvVar: "MY_TOKEN", allowRemoteHosts: ["example.com"] });
	assert.equal(custom.executeTimeoutMs, 5000);
	assert.equal(custom.tokenEnvVar, "MY_TOKEN");

	// --- command grammar ------------------------------------------------------
	assert.deepEqual(parsePairArgs(""), { kind: "connect" });
	assert.deepEqual(parsePairArgs("   "), { kind: "connect" });
	assert.deepEqual(parsePairArgs("status"), { kind: "status" });
	assert.deepEqual(parsePairArgs("STATUS"), { kind: "status" });
	assert.deepEqual(parsePairArgs("http://localhost:2718"), { kind: "connect", url: "http://localhost:2718" });
	assert.deepEqual(parsePairArgs("https://127.0.0.1:3000/"), { kind: "connect", url: "https://127.0.0.1:3000/" });
	assert.equal(parsePairArgs("localhost:2718").kind, "invalid");
	assert.equal(parsePairArgs("status extra").kind, "invalid");
	assert.equal(parsePairArgs("http://a http://b").kind, "invalid");
	assert.deepEqual(parsePairArgs('"http://localhost:2718"'), { kind: "connect", url: "http://localhost:2718" });

	assert.deepEqual(parseEndArgs(""), { kind: "summary" });
	assert.deepEqual(parseEndArgs("summary"), { kind: "summary" });
	assert.deepEqual(parseEndArgs("DONE"), { kind: "done" });
	assert.deepEqual(parseEndArgs("status"), { kind: "status" });
	assert.equal(parseEndArgs("finish").kind, "invalid");

	// Tokenizer quotes and escapes.
	assert.deepEqual(tokenizeArgs('a "b c" d').map((token) => token.text), ["a", "b c", "d"]);
	assert.deepEqual(tokenizeArgs(`'it\\'s'`).map((token) => token.text), ["it's"]);

	// --- command registration -------------------------------------------------
	const ctx = mockCtx();
	const lifecycle = { signal: new AbortController().signal, inFlight: new Set() };
	registerCommands(ctx, mockDomain(), config, lifecycle);
	assert.equal(ctx.registered.length, 2);
	const pairCommand = ctx.registered.find((definition) => definition.name === "marimo-pair");
	const endCommand = ctx.registered.find((definition) => definition.name === "end-marimo-pair");
	assert.ok(pairCommand && endCommand);
	assert.ok(pairCommand.definitionId.includes("marimo-pair"));
	assert.ok(endCommand.definitionId.includes("end-marimo-pair"));
	assert.ok(pairCommand.input.hint.includes("status"));
	assert.ok(pairCommand.input.hint.includes("<url>"));
	assert.ok(endCommand.input.hint.includes("summary"));
	assert.ok(endCommand.input.hint.includes("done"));
	assert.ok(endCommand.input.hint.includes("status"));

	// --- state over the schema-validating mock -------------------------------
	const domain = mockDomain();
	const sessionId = "session-smoke-0001";
	// An update without a prior put must create the empty record and rerun the transform.
	assert.equal(getSessionRecord(domain, sessionId).active, false);
	await setActivePairing(domain, sessionId, { url: "http://localhost:2718", notebookPath: "/tmp/nb.py", marimoSessionId: "s_1", origin: "discovered", title: "marimo · nb.py" });
	const activeRecord = getSessionRecord(domain, sessionId);
	assert.equal(activeRecord.active, true);
	assert.equal(activeRecord.url, "http://localhost:2718");
	assert.equal(activeRecord.notebookPath, "/tmp/nb.py");
	assert.equal(activeRecord.marimoSessionId, "s_1");
	assert.equal(activeRecord.title, "marimo · nb.py");
	assert.ok(activeRecord.startedAt);
	// Clearing run state preserves the title pin so the next pairing can recognize it.
	await clearActivePairing(domain, sessionId);
	const doneRecord = getSessionRecord(domain, sessionId);
	assert.equal(doneRecord.active, false);
	assert.equal(doneRecord.url, undefined);
	assert.equal(doneRecord.notebookPath, undefined);
	assert.equal(doneRecord.marimoSessionId, undefined);
	assert.equal(doneRecord.origin, undefined);
	assert.equal(doneRecord.startedAt, undefined);
	assert.equal(doneRecord.title, "marimo · nb.py");
	assert.throws(() => PairingSessionRecordSchema.parse({ active: "yes" }));
	// Session-id refresh preserves the remaining run state.
	await setActivePairing(domain, sessionId, { url: "http://localhost:2718", notebookPath: "/tmp/nb.py", marimoSessionId: "s_1", origin: "discovered" });
	await updateMarimoSessionId(domain, sessionId, "s_2");
	const refreshed = getSessionRecord(domain, sessionId);
	assert.equal(refreshed.marimoSessionId, "s_2");
	assert.equal(refreshed.url, "http://localhost:2718");
	assert.equal(refreshed.notebookPath, "/tmp/nb.py");
	// Pairing without a title clears the old pin.
	assert.equal(refreshed.title, undefined);
	// Release only clears a matching title pin.
	await setActivePairing(domain, sessionId, { url: "http://localhost:2718", notebookPath: "/tmp/nb.py", marimoSessionId: "s_2", origin: "discovered", title: "marimo · nb.py" });
	await releasePinnedTitle(domain, sessionId, "not mine");
	assert.equal(getSessionRecord(domain, sessionId).title, "marimo · nb.py");
	await releasePinnedTitle(domain, sessionId, "marimo · nb.py");
	assert.equal(getSessionRecord(domain, sessionId).title, undefined);

	// --- prompts --------------------------------------------------------------
	const record = getSessionRecord(domain, sessionId);
	const policy = renderPairingPolicy(record);
	// Identical records must render byte-identical policies.
	assert.equal(policy, renderPairingPolicy({ ...record }));
	assert.ok(policy.includes("http://localhost:2718"));
	assert.ok(policy.includes("/tmp/nb.py"));
	assert.ok(policy.includes("MUST NOT modify the notebook's .py file"));
	assert.ok(policy.includes("PRIVATE, UNSTABLE agent API"));
	assert.ok(policy.includes("NEVER import it from notebook cells"));
	assert.ok(policy.includes("help(cm)"));
	assert.ok(policy.includes("Only then use"));
	assert.ok(policy.includes("Never run task-specific"));
	assert.ok(policy.includes("asyncio.run"));
	assert.ok(policy.includes("marimo-pair"));
	assert.equal(renderPairingPolicy({ active: true }), "");
	assert.ok(POLICY_FALLBACK.includes("do not edit the notebook .py file"));
	const connected = buildConnectedPrompt({ url: "http://localhost:2718", notebookPath: "/tmp/nb.py" });
	assert.ok(connected.includes("http://localhost:2718"));
	assert.ok(connected.includes("/tmp/nb.py"));
	assert.ok(connected.includes("already ran successfully"));
	assert.ok(connected.includes("marimo-pair"));
	assert.ok(connected.includes("- Drive the notebook only through `marimo_execute_code`"));
	assert.ok(!connected.includes("Dr-"));
	assert.ok(connected.includes("never edit the notebook's .py file"));
	assert.ok(PAIRING_SUMMARY_PROMPT.includes("Notebook Changes"));
	assert.equal(truncate("x".repeat(50), 40).length, 40);
	assert.equal(truncate("short", 40), "short");

	// --- session title --------------------------------------------------------
	// Derive titles from notebook names, falling back to server identity.
	assert.equal(notebookName("/tmp/nb.py"), "nb.py");
	assert.equal(notebookName("C:\\work\\nb.py"), "nb.py");
	assert.equal(notebookName("/tmp/"), "");
	assert.equal(notebookName(""), "");
	assert.equal(notebookName(undefined), "");
	assert.equal(serverLabel("http://localhost:2718"), "localhost:2718");
	assert.equal(serverLabel("http://127.0.0.1:2718/"), "127.0.0.1:2718");
	assert.equal(serverLabel("not a url"), "");
	assert.equal(serverLabel(undefined), "");
	assert.equal(pairingSessionTitle({ notebookPath: "/tmp/nb.py", url: "http://localhost:2718" }), "marimo · nb.py");
	assert.equal(pairingSessionTitle({ notebookPath: "C:\\work\\nb.py" }), "marimo · nb.py");
	assert.equal(pairingSessionTitle({ url: "http://127.0.0.1:2718/" }), "marimo notebook (127.0.0.1:2718)");
	assert.equal(pairingSessionTitle({}), "marimo notebook");
	// Replace titles only on untitled sessions or pins owned by this plugin.
	// Preserve user and automatic titles.
	assert.equal(mayReplaceTitle(undefined, undefined), true);
	assert.equal(mayReplaceTitle({ title: "x", source: { kind: "fallback" } }, undefined), false);
	assert.equal(mayReplaceTitle({ title: "x", source: { kind: "provider" } }, undefined), false);
	assert.equal(mayReplaceTitle({ title: "x", source: { kind: "user" } }, undefined), false);
	assert.equal(mayReplaceTitle({ title: "x", source: { kind: "user" } }, "x"), true);
	// Exercise the optional title service, including failures.
	{
		const renames = [];
		const snapshots = new Map();
		const session = { id: "session-title-0001" };
		const agent = { session };
		const service = {
			get(target) {
				return snapshots.get(target);
			},
			rename(target, title) {
				renames.push(title);
				const snapshot = { title, messageSeqs: [], source: { kind: "user" }, eventSeq: 0, updatedAt: 0 };
				snapshots.set(target, snapshot);
				return snapshot;
			},
		};
		const titleCtx = { get: (name) => (name === "sessionTitle" ? service : undefined) };
		// Missing title services and sessions must not block pairing.
		assert.equal(pinPairingTitle({}, agent, { title: "marimo · a.py" }), undefined);
		assert.equal(pinPairingTitle({ get: () => undefined }, agent, { title: "marimo · a.py" }), undefined);
		assert.equal(pinPairingTitle(titleCtx, {}, { title: "marimo · a.py" }), undefined);
		assert.equal(pinPairingTitle(titleCtx, agent, { title: "marimo · a.py" }), "marimo · a.py");
		assert.deepEqual(renames, ["marimo · a.py"]);
		// Re-pairing may replace the plugin's own pin.
		assert.equal(pinPairingTitle(titleCtx, agent, { ownedTitle: "marimo · a.py", title: "marimo · b.py" }), "marimo · b.py");
		assert.deepEqual(renames, ["marimo · a.py", "marimo · b.py"]);
		// Re-pinning the same title must not emit a rename event.
		assert.equal(pinPairingTitle(titleCtx, agent, { ownedTitle: "marimo · b.py", title: "marimo · b.py" }), "marimo · b.py");
		assert.deepEqual(renames, ["marimo · a.py", "marimo · b.py"]);
		snapshots.set(session, { title: "My notes", source: { kind: "user" } });
		assert.equal(pinPairingTitle(titleCtx, agent, { ownedTitle: "marimo · b.py", title: "marimo · c.py" }), undefined);
		assert.deepEqual(renames, ["marimo · a.py", "marimo · b.py"]);
		snapshots.set(session, { title: "Untitled conversation", source: { kind: "fallback" } });
		assert.equal(pinPairingTitle(titleCtx, agent, { title: "marimo · d.py" }), undefined);
		assert.deepEqual(renames, ["marimo · a.py", "marimo · b.py"]);
		// Rename errors must not block pairing.
		const failingCtx = { get: () => ({ get: () => undefined, rename() { throw new Error("not live"); } }) };
		assert.equal(pinPairingTitle(failingCtx, agent, { title: "marimo · e.py" }), undefined);
	}
	// Release the title pin on the first request after a human message.
	{
		const releaseDomain = mockDomain();
		const releaseSessionId = "session-title-0002";
		const session = { id: releaseSessionId, header: {} };
		const pairFacts = { url: "http://localhost:2718", notebookPath: "/tmp/nb.py", marimoSessionId: "s_1", origin: "discovered", title: "marimo · nb.py" };
		await setActivePairing(releaseDomain, releaseSessionId, pairFacts);
		let current = { title: "marimo · nb.py", source: { kind: "user" } };
		let refreshes = 0;
		let failRefresh = false;
		const service = {
			get() {
				return current;
			},
			async refresh() {
				refreshes += 1;
				if (failRefresh) throw new Error("provider down");
				current = { title: "Analysis notebook", source: { kind: "provider", provider: "test" } };
				return current;
			},
		};
		const listeners = new Map();
		const titleCtx = {
			get: (name) => (name === "sessionTitle" ? service : undefined),
			on(name, listener) {
				listeners.set(name, listener);
				return () => listeners.delete(name);
			},
			logger: { warn() {} },
		};
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
		const emit = (type, data) => listeners.get("session/event")(session, { type, data });
		const dispose = registerTitleRelease(titleCtx, releaseDomain);

		// Only human text messages trigger automatic naming.
		assert.equal(userMessageText({ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "  hi  " }] } }), "hi");
		assert.equal(userMessageText({ type: "user/message", data: { source: { kind: "apcamargo-dsh-marimo" }, content: [{ type: "text", text: "pair" }] } }), "");
		assert.equal(userMessageText({ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "image" }] } }), "");

		// Ignore plugin-sourced messages, including the connected turn.
		emit("user/message", { source: { kind: "apcamargo-dsh-marimo" }, content: [{ type: "text", text: "A marimo pairing just started." }] });
		emit("request/header", { header: {} });
		await flush();
		assert.equal(refreshes, 0);
		assert.equal(getSessionRecord(releaseDomain, releaseSessionId).title, "marimo · nb.py");

		emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "What does this cell do?" }] });
		emit("request/header", { header: {} });
		await flush();
		assert.equal(refreshes, 1);
		assert.equal(current.title, "Analysis notebook");
		assert.equal(getSessionRecord(releaseDomain, releaseSessionId).title, undefined);

		// Never release a user-chosen title.
		await setActivePairing(releaseDomain, releaseSessionId, pairFacts);
		current = { title: "My notes", source: { kind: "user" } };
		emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "next" }] });
		emit("request/header", { header: {} });
		await flush();
		assert.equal(refreshes, 1);
		// On provider failure, keep the title and allow one attempt per pairing.
		await setActivePairing(releaseDomain, releaseSessionId, pairFacts);
		current = { title: "marimo · nb.py", source: { kind: "user" } };
		failRefresh = true;
		emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "one" }] });
		emit("request/header", { header: {} });
		await flush();
		assert.equal(refreshes, 2);
		assert.equal(getSessionRecord(releaseDomain, releaseSessionId).title, "marimo · nb.py");
		emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "two" }] });
		emit("request/header", { header: {} });
		await flush();
		assert.equal(refreshes, 2);
		// Re-pairing with a new startedAt permits one fresh attempt.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await setActivePairing(releaseDomain, releaseSessionId, pairFacts);
		failRefresh = false;
		emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "three" }] });
		emit("request/header", { header: {} });
		await flush();
		assert.equal(refreshes, 3);
		assert.equal(getSessionRecord(releaseDomain, releaseSessionId).title, undefined);

		// Disposal removes both listeners. Missing title services or event hooks
		// return no-op disposers.
		dispose();
		assert.equal(listeners.size, 0);
		assert.equal(typeof registerTitleRelease({}, releaseDomain), "function");
		assert.equal(typeof registerTitleRelease({ get: () => undefined }, releaseDomain), "function");
	}

	// --- tool target resolution ----------------------------------------------
	const sessions = [
		{ id: "s_a", path: "/tmp/a.py", filename: "/tmp/a.py" },
		{ id: "s_b", path: "/tmp/b.py", filename: "/tmp/b.py" },
	];
	assert.deepEqual(resolveTargetSession(sessions, { session: "s_b" }), { id: "s_b" });
	assert.deepEqual(resolveTargetSession(sessions, { file: "/tmp/a.py" }), { id: "s_a" });
	assert.throws(() => resolveTargetSession(sessions, { session: "s_a", file: "/tmp/b.py" }), /mutually exclusive/);
	// Match file against either path or filename.
	assert.deepEqual(resolveTargetSession([{ id: "s_c", filename: "/tmp/c.py" }], { file: "/tmp/c.py" }), { id: "s_c" });
	assert.throws(() => resolveTargetSession(sessions, { file: "/tmp/none.py" }), /No active session matches/);
	// Resolve paired paths and report refreshed session ids.
	assert.deepEqual(resolveTargetSession(sessions, { pairedNotebookPath: "/tmp/b.py", pairedSessionId: "s_old" }), { id: "s_b", refreshedSessionId: "s_b" });
	assert.deepEqual(resolveTargetSession(sessions, { pairedNotebookPath: "/tmp/b.py", pairedSessionId: "s_b" }), { id: "s_b" });
	// Refuse to guess a different notebook when the paired notebook disappears.
	assert.throws(() => resolveTargetSession([{ id: "s_only" }], { pairedNotebookPath: "/tmp/gone.py", pairedSessionId: "s_stale" }), /no active session/);
	// A stored session id is never allowed to replace the paired notebook with another one.
	for (const mismatchedSessions of [
		[{ id: "stored", path: "/tmp/other.py" }],
		[{ id: "other", path: "/tmp/other.py" }],
	]) {
		assert.throws(
			() => resolveTargetSession(mismatchedSessions, {
				pairedNotebookPath:`/tmp/paired.py`, pairedSessionId: mismatchedSessions[0].id === "stored" ? "stored" : "stale",
			}),
			(error) => error instanceof MarimoError && error.code === "CONNECTION" && /paired notebook|paired session/i.test(error.message),
		);
	}
	// Use a stored session id only while it remains in the current map.
	assert.deepEqual(resolveTargetSession(sessions, { pairedSessionId: "s_a" }), { id: "s_a" });
	assert.throws(() => resolveTargetSession(sessions, { pairedSessionId: "s_gone" }), /no longer active/);
	// Fresh resolution must not guess between sessions.
	assert.throws(() => resolveTargetSession(sessions, {}), /Multiple sessions/);
	assert.deepEqual(resolveTargetSession([{ id: "s_only" }], {}), { id: "s_only" });
	assert.throws(() => resolveTargetSession([], {}), /No active sessions/);

	// --- base-url resolution and host policy ----------------------------------
	assert.deepEqual(resolveBaseUrl({ url: "http://localhost:2718/" }, undefined, config), { baseUrl: "http://localhost:2718", paired: false });
	assert.deepEqual(resolveBaseUrl({}, { url: "http://localhost:2718" }, config), { baseUrl: "http://localhost:2718", paired: true });
	assert.throws(() => resolveBaseUrl({}, undefined, config), (error) => error.message === UNPAIRED_MESSAGE);
	assert.throws(() => resolveBaseUrl({ url: "http://user:pass@example.com" }, undefined, config), /denied by default/i);

	// --- command flows with no server ----------------------------------------
	const flowDomain = mockDomain();
	// Unpaired status checks must not touch the network.
	const statusResult = await executeMarimoPair(ctx, flowDomain, config, commandInvocation("status"), lifecycle.signal);
	assert.equal(statusResult.kind, "success");
	assert.ok(statusResult.text.includes("no pairing active"));
	// Empty discovery returns guidance without state changes and queues an error turn.
	process.env.XDG_STATE_HOME = "/tmp/does-not-exist-marimo-smoke";
	try {
		const discoverInvocation = commandInvocation("");
		const discoverResult = await executeMarimoPair(ctx, flowDomain, config, discoverInvocation, lifecycle.signal);
		assert.equal(discoverResult.kind, "error");
		assert.ok(discoverResult.text.includes("--no-token"));
		// Explain why token servers are invisible to discovery and how to pair
		// by URL with the token variable.
		assert.ok(discoverResult.text.includes("does not register"));
		assert.ok(discoverResult.text.includes("MARIMO_TOKEN"));
		assert.ok(discoverResult.text.includes("/marimo-pair http://<host>:<port>"));
		assert.equal(getSessionRecord(flowDomain, sessionId).active, false);
		// The queued turn asks the model for help instead of rerunning the human command.
		assert.equal(discoverInvocation.agent.followups.length, 1);
		const failureTurn = discoverInvocation.agent.followups[0].content[0].text;
		assert.ok(failureTurn.includes("No reachable marimo server was found"));
		assert.ok(failureTurn.includes("human command"));
	} finally {
		delete process.env.XDG_STATE_HOME;
	}
	// Invalid grammar shows a composer error and queues no turn.
	const invalidInvocation = commandInvocation("nonsense");
	const invalidResult = await executeMarimoPair(ctx, flowDomain, config, invalidInvocation, lifecycle.signal);
	assert.equal(invalidResult.kind, "error");
	assert.equal(invalidInvocation.agent.followups.length, 0);
	const endNoPairing = await executeEndMarimoPair(ctx, flowDomain, config, commandInvocation(""), lifecycle.signal);
	assert.equal(endNoPairing.kind, "error");
	assert.ok(endNoPairing.text.includes("/marimo-pair"));
	// A pre-cancelled invocation must return an error without state writes.
	const cancelled = commandInvocation("status", {});
	cancelled.controller.abort();
	const cancelledResult = await executeMarimoPair(ctx, domain, config, cancelled, lifecycle.signal);
	assert.equal(cancelledResult.kind, "error");

	// --- boundary error translation ------------------------------------------
	const aborted = new AbortController();
	aborted.abort();
	assert.equal(boundaryError(new Error("boom"), aborted.signal).text, "Pairing cancelled.");
	assert.equal(boundaryError(new Error("boom"), new AbortController().signal).text, "boom");

	// --- pairing projection: fold over command lifecycle records --------------
	{
		const flowDomain = mockDomain();
		const unit = createPairingProjection(flowDomain);
		assert.equal(unit.key, PAIRING_PROJECTION_KEY);
		const state0 = unit.init({ id: "session-proj-0001" }, 0);
		assert.deepEqual(state0, { sessionId: "session-proj-0001", pending: [] });
		// Ignore unrelated events by returning the same state reference.
		assert.equal(unit.apply(state0, { type: "assistant/message" }), state0);
		assert.equal(unit.apply(state0, undefined), state0);
		// Mirror session log envelopes with command records under event.data.
		// Only this plugin's command/run events track lifecycle ids.
		const state1 = unit.apply(state0, { type: "command/run", data: { commandId: "c1", name: "marimo-pair", source: { kind: "user" } } });
		assert.deepEqual(state1.pending, ["c1"]);
		assert.equal(unit.apply(state1, { type: "command/run", data: { commandId: "c2", name: "some-other-command", source: { kind: "user" } } }), state1);
		assert.equal(unit.apply(state1, { type: "command/run", data: { commandId: "c3", kind: "success" } }), state1);
		// Ignore unknown command/done ids. Completing a tracked id returns a new
		// state reference.
		assert.equal(unit.apply(state1, { type: "command/done", data: { commandId: "c9", kind: "success" } }), state1);
		const state2 = unit.apply(state1, { type: "command/done", data: { commandId: "c1", kind: "error" } });
		assert.deepEqual(state2.pending, []);
		// Before a write, return a memoized inactive wire view.
		const empty = unit.wire.view(state2);
		assert.deepEqual(empty, { active: false });
		assert.equal(unit.wire.view(state2), empty);
		assert.ok(PairingWireSchema.parse(empty));

		// Lifecycle order is run fold, handler write, done fold.
		// The wire view stays unpaired until the done fold supplies a new state reference.
		const stateA = unit.apply(state2, { type: "command/run", data: { commandId: "c2", name: "marimo-pair", source: { kind: "user" } } });
		assert.equal(unit.wire.view(stateA), empty);
		await setActivePairing(flowDomain, "session-proj-0001", {
			url: "http://localhost:2718",
			notebookPath: "notebook.py",
			marimoSessionId: "m1",
			origin: "discovered",
		});
		const stateB = unit.apply(stateA, { type: "command/done", data: { commandId: "c2", kind: "success" } });
		const paired = unit.wire.view(stateB);
		assert.deepEqual(paired, { active: true, url: "http://localhost:2718" });
		assert.ok(PairingWireSchema.parse(paired));
		// A failed command writes no state, so its done event keeps the same wire value.
		const stateC = unit.apply(stateB, { type: "command/run", data: { commandId: "c3", name: "end-marimo-pair", source: { kind: "user" } } });
		const stateD = unit.apply(stateC, { type: "command/done", data: { commandId: "c3", kind: "error" } });
		assert.equal(unit.wire.view(stateD), paired);
		// Unpairing must publish a fresh inactive object, not a stale one.
		const stateE = unit.apply(stateD, { type: "command/run", data: { commandId: "c4", name: "end-marimo-pair", source: { kind: "user" } } });
		await clearActivePairing(flowDomain, "session-proj-0001");
		const stateF = unit.apply(stateE, { type: "command/done", data: { commandId: "c4", kind: "success" } });
		const cleared = unit.wire.view(stateF);
		assert.deepEqual(cleared, { active: false });
		assert.notEqual(cleared, empty);
		// Memoize wire views independently per session.
		const otherState = unit.init({ id: "session-proj-0002" }, 0);
		assert.deepEqual(unit.wire.view(otherState), { active: false });
		assert.equal(unit.wire.view(otherState), unit.wire.view(otherState));
		// Drop non-http(s) URLs before exposing records to the client's window.open.
		await flowDomain.table().put("session-proj-0001", { active: true, url: "javascript:alert(1)" });
		assert.deepEqual(unit.wire.view(stateF), { active: true });
	}

	// --- projection registration ----------------------------------------------
	{
		const flowDomain = mockDomain();
		// Without a registry, return a no-op disposer so the plugin still loads.
		await registerPairingProjection({}, flowDomain)();
		const registered = [];
		const registry = {
			register(definition) {
				registered.push(definition);
				return () => {
					registered.pop();
				};
			},
		};
		const ctx = { get: (name) => (name === "sessionProjections" ? registry : undefined) };
		const disposer = registerPairingProjection(ctx, flowDomain);
		assert.equal(registered.length, 1);
		assert.equal(registered[0].key, PAIRING_PROJECTION_KEY);
		assert.equal(registered[0].stateVersion, 3);
		await disposer();
		assert.equal(registered.length, 0);
		// The registry can return a callable thenable instead of a plain disposer.
		// The composite effect's sync-generator yield treats it as the disposer,
		// so calling it must unregister.
		const thenableReleased = [];
		const thenable = Object.assign(() => thenableReleased.push("released"), {
			then() {},
			catch() {},
			finally() {},
			[Symbol.toStringTag]: "Promise",
		});
		const thenableCtx = { get: () => ({ register: () => thenable }) };
		const thenableDisposer = registerPairingProjection(thenableCtx, flowDomain);
		thenableDisposer();
		assert.deepEqual(thenableReleased, ["released"]);
		// Pass non-callable results through unchanged so the composite effect
		// fails loudly with cordis "Invalid effect".
		const bogus = { not: "callable" };
		const bogusCtx = { get: () => ({ register: () => bogus }) };
		assert.equal(registerPairingProjection(bogusCtx, flowDomain), bogus);
	}

	// Unload reverses effect disposal, unregistering commands.
	for (const effect of [...ctx.effects].reverse()) {
		await effect.disposer?.();
	}
	assert.equal(ctx.registered.length, 0);

	console.log("smoke: all assertions passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
