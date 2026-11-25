/**
 * Durable per-session pairing records in `dsh_marimo.sessions`.
 *
 * Plugins cannot add custom session event types, so pairing state lives in
 * storage-domain tables rather than session logs. Storage domain names must
 * use the contract's snake_case format.
 *
 * @module @apcamargo/dsh-marimo/state
 */

import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

/** One session's durable pairing state. */
const PairingSessionRecordSchema = z.object({
	/** Whether a pairing is currently active in this session. */
	active: z.boolean(),
	/** Base URL of the paired marimo server, as given at connect. */
	url: z.string().optional(),
	/** Absolute notebook file path resolved from the active session at connect. */
	notebookPath: z.string().optional(),
	/** marimo session id resolved at connect; goes stale on browser reconnect. */
	marimoSessionId: z.string().optional(),
	/** Where the target came from: `discovered` or `user-url`. */
	origin: z.string().optional(),
	/** ISO timestamp when the pairing started. */
	startedAt: z.string().optional(),
	/** Title pinned by this plugin, kept to distinguish it from later user titles. */
	title: z.string().optional(),
});

/** Validate the domain and table definitions before opening storage. */
const MARIMO_PAIR_DOMAIN_SPEC = defineDomain({
	name: "dsh_marimo",
	version: 1,
	tables: {
		sessions: domainTable(PairingSessionRecordSchema),
	},
});

const EMPTY_RECORD = Object.freeze({ active: false });

/**
 * Open the marimo_pair domain. The caller owns the handle and closes it on
 * teardown (typically as its own effect disposer).
 * @param ctx - context carrying the `storageDomain` facility.
 * @returns the opened domain handle.
 */
async function openMarimoPairDomain(ctx) {
	return ctx.storageDomain.open(MARIMO_PAIR_DOMAIN_SPEC);
}

/**
 * Read a record synchronously, defaulting to an empty record before the first write.
 * @param domain - opened storage domain.
 * @param sessionId - session id the record belongs to.
 */
function getSessionRecord(domain, sessionId) {
	return domain.table("sessions").get(sessionId) ?? EMPTY_RECORD;
}

/**
 * Serialize record updates on the domain's write chain. Initialize a missing
 * record, then rerun the transform against the latest committed state.
 */
async function updateSessionRecord(domain, sessionId, transform) {
	const table = domain.table("sessions");
	try {
		return await table.update(sessionId, transform);
	} catch (error) {
		if (error?.code !== "missing-key") throw error;
		await table.put(sessionId, { ...EMPTY_RECORD });
		return table.update(sessionId, transform);
	}
}

/**
 * Store an active pairing. An omitted title clears the previous plugin pin.
 * @returns resolution after durability.
 */
function setActivePairing(domain, sessionId, target) {
	return updateSessionRecord(domain, sessionId, (current) => {
		const next = {
			...current,
			active: true,
			url: target.url,
			notebookPath: target.notebookPath,
			marimoSessionId: target.marimoSessionId,
			origin: target.origin,
			startedAt: new Date().toISOString(),
		};
		if (target.title === undefined) delete next.title;
		else next.title = target.title;
		return next;
	});
}

/**
 * Drop all run-state fields but keep the pinned-title marker for the next pairing.
 * @returns resolution after durability.
 */
function clearActivePairing(domain, sessionId) {
	return updateSessionRecord(domain, sessionId, (current) =>
		current.title === undefined ? { ...EMPTY_RECORD } : { ...EMPTY_RECORD, title: current.title },
	);
}

/**
 * Refresh the stored marimo session id when it changed underneath us (marimo
 * renames sessions on browser reconnect). Run-state fields are preserved.
 * @returns resolution after durability.
 */
function updateMarimoSessionId(domain, sessionId, marimoSessionId) {
	return updateSessionRecord(domain, sessionId, (current) => ({
		...current,
		marimoSessionId,
	}));
}

/**
 * Clear title ownership only if it still matches this pairing's pin.
 * @returns resolution after durability.
 */
function releasePinnedTitle(domain, sessionId, pinnedTitle) {
	return updateSessionRecord(domain, sessionId, (current) => {
		if (current.title !== pinnedTitle) return current;
		const { title, ...rest } = current;
		return rest;
	});
}

export {
	PairingSessionRecordSchema,
	openMarimoPairDomain,
	getSessionRecord,
	setActivePairing,
	clearActivePairing,
	updateMarimoSessionId,
	releasePinnedTitle,
};
