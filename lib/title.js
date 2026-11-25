/**
 * Pin an untitled session to the notebook name, then return it to automatic
 * naming after the first human message. Never replace an existing user or
 * automatic title. The optional `sessionTitle` service may be absent.
 *
 * `rename` creates a user-source pin that would otherwise suppress automatic
 * naming. Calling `refresh()` after the first message releases that pin. The
 * stored title marker prevents later pairings from overwriting a new title.
 *
 * @module @apcamargo/dsh-marimo/title
 */

import { getSessionRecord, releasePinnedTitle } from "./state.js";

const TITLE_PREFIX = "marimo · ";

const UNNAMED_TITLE = "marimo notebook";

/**
 * Extract the file name using either POSIX or Windows path separators.
 * @param {unknown} notebookPath - the notebook path reported by marimo, if known.
 * @returns {string} the file name, or "" when there is none.
 */
function notebookName(notebookPath) {
	if (typeof notebookPath !== "string") return "";
	const parts = notebookPath.split(/[\\/]/);
	return parts.at(-1) ?? "";
}

/**
 * `host:port` label for a marimo base URL.
 * @param {unknown} url - normalized base URL, if known.
 * @returns {string} the label, or "" for a missing or unparsable URL.
 */
function serverLabel(url) {
	if (typeof url !== "string" || url.length === 0) return "";
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

/**
 * The title one pairing sets: it says this is a marimo session and names the
 * notebook. An unnamed notebook (marimo has not saved one yet) falls back to
 * the server identity, so the title still distinguishes the session.
 * @param {{ notebookPath?: string, url?: string }} target - pairing facts.
 * @returns {string} the title to pin.
 */
function pairingSessionTitle(target = {}) {
	const name = notebookName(target.notebookPath);
	if (name.length > 0) return `${TITLE_PREFIX}${name}`;
	const host = serverLabel(target.url);
	return host.length > 0 ? `${UNNAMED_TITLE} (${host})` : UNNAMED_TITLE;
}

/**
 * Allow titles only on untitled sessions or over this plugin's own pin.
 * @param {{ title: string, source?: { kind?: string } } | undefined} current - snapshot, if any.
 * @param {string | undefined} ownedTitle - title this plugin pinned last time.
 * @returns {boolean} true when a pairing may set its own title.
 */
function mayReplaceTitle(current, ownedTitle) {
	if (current === undefined) return true;
	if (current.source?.kind !== "user") return false;
	return typeof ownedTitle === "string" && current.title === ownedTitle;
}

/**
 * Pin a title without letting service failures break pairing.
 * @param {object} ctx - host context carrying the optional `sessionTitle` service.
 * @param {{ session?: object }} agent - live agent whose session is titled.
 * @param {{ ownedTitle?: string, title: string }} input - the previous pin and the new title.
 * @returns {string | undefined} the new plugin-owned title, if one was allowed and set.
 */
function pinPairingTitle(ctx, agent, input) {
	const service = ctx.get?.("sessionTitle");
	if (service === undefined || service === null) return undefined;
	const session = agent?.session;
	if (session === undefined || session === null) return undefined;
	let current;
	try {
		current = service.get(session);
	} catch {
		return undefined;
	}
	if (!mayReplaceTitle(current, input.ownedTitle)) return undefined;
	// Skip an identical pin to avoid a redundant rename event.
	const alreadyPinned = current?.source?.kind === "user" && current.title === input.title;
	if (!alreadyPinned) {
		try {
			service.rename(session, input.title);
		} catch {
			return undefined;
		}
	}
	return input.title;
}

/**
 * Extract text only from human messages eligible for automatic naming.
 * @param {object | undefined} event - the appended session event.
 * @returns {string} the joined message text, or "".
 */
function userMessageText(event) {
	if (event?.type !== "user/message" || event.data?.source?.kind !== "user") return "";
	const content = Array.isArray(event.data.content) ? event.data.content : [];
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * After the first human message, refresh the next request's title if it still
 * matches this plugin's pin. Make one refresh attempt per pairing; failures
 * keep the marimo title rather than retrying on every turn.
 * @param {object} ctx - host context carrying the optional session-title service and the event seam.
 * @param {object} domain - opened marimo_pair domain (synchronous reads).
 * @returns {() => void} disposer for both listeners.
 */
function registerTitleRelease(ctx, domain) {
	if (typeof ctx.on !== "function") return () => {};
	const awaiting = new Set();
	const attempted = new Map();
	// The service is resolved per event, not at apply time: a profile layer can
	// load before it, and the pin is written much later by a command anyway.
	const titleService = () => {
		const service = ctx.get?.("sessionTitle");
		if (service === undefined || service === null) return undefined;
		if (typeof service.get !== "function" || typeof service.refresh !== "function") return undefined;
		return service;
	};
	const release = (session) => {
		const service = titleService();
		if (service === undefined) return;
		const record = getSessionRecord(domain, session.id);
		const ownedTitle = record.title;
		if (ownedTitle === undefined) return;
		// The user may have renamed the session in the meantime; only a title
		// that is still exactly this plugin's pin may be released.
		if (service.get(session)?.title !== ownedTitle) return;
		const key = record.startedAt ?? "";
		if (attempted.get(session.id) === key) return;
		attempted.set(session.id, key);
		Promise.resolve()
			.then(() => service.refresh(session))
			.then((snapshot) => {
				if (snapshot === undefined || snapshot.title === ownedTitle) return undefined;
				return releasePinnedTitle(domain, session.id, ownedTitle);
			})
			.catch((error) => {
				ctx.logger?.warn?.(`marimo-pair: automatic session title failed: ${error instanceof Error ? error.message : String(error)}`);
			});
	};
	const offEvent = ctx.on("session/event", (session, event) => {
		try {
			if (event?.type === "user/message") {
				if (userMessageText(event).length === 0) return;
				const service = titleService();
				if (service === undefined) return;
				const record = getSessionRecord(domain, session.id);
				if (record.title === undefined) return;
				if (service.get(session)?.title !== record.title) return;
				awaiting.add(session.id);
				return;
			}
			if (event?.type !== "request/header") return;
			if (!awaiting.delete(session.id)) return;
			release(session);
		} catch {
			// Post-commit listener: a failed title check must not disturb the event.
		}
	});
	const offDisposed = ctx.on("session/disposed", (session) => {
		awaiting.delete(session.id);
		attempted.delete(session.id);
	});
	return () => {
		if (typeof offEvent === "function") offEvent();
		if (typeof offDisposed === "function") offDisposed();
	};
}

export {
	mayReplaceTitle,
	notebookName,
	pairingSessionTitle,
	pinPairingTitle,
	registerTitleRelease,
	serverLabel,
	userMessageText,
};
