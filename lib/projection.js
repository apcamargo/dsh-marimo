/**
 * Mirror durable pairing state to the client as `{ active, url? }`. Storage is
 * authoritative; this unit does not append custom session events.
 *
 * Folding `command/run` and `command/done` refreshes the view after a pairing
 * command settles. Memoized values suppress updates when storage is unchanged.
 *
 * @module @apcamargo/dsh-marimo/projection
 */

import { z } from "zod";

/** Wire payload schema: what the notebook button needs, nothing more. */
export const PairingWireSchema = z.object({
	/** Whether a pairing is currently active in this session. */
	active: z.boolean(),
	/** Base URL of the paired marimo server; omitted while unpaired. */
	url: z.string().optional(),
});

/** Internal fold state: plain JSON, checkpointable per the unit contract. */
const ProjectionStateSchema = z.object({
	/** The session this cell projects (captured at init from the header). */
	sessionId: z.string(),
	/** `commandId`s of pairing commands seen running but not yet settled. */
	pending: z.array(z.string()),
});

/** The projection key this unit owns, namespaced to the package. */
export const PAIRING_PROJECTION_KEY = "dsh-marimo:pairing";

/** The human commands whose settlement can change the durable pairing state. */
const PAIR_COMMAND_NAMES = new Set(["marimo-pair", "end-marimo-pair"]);

/** The session events whose payloads carry this plugin's command records. */
const PAIR_EVENTS = new Set(["command/run", "command/done"]);

/**
 * Build the projection unit. Reuse each session's wire object until its stored
 * pairing changes, as required for object-valued views. Command records live
 * under `event.data`.
 *
 * @param domain - opened marimo_pair domain handle (synchronous reads).
 * @returns the projection definition for `ctx.sessionProjections.register`.
 */
export function createPairingProjection(domain) {
	/** Per-session memo of the last computed wire value and its signature. */
	const memoBySession = new Map();
	return {
		key: PAIRING_PROJECTION_KEY,
		stateSchema: ProjectionStateSchema,
		stateVersion: 3,
		init(header) {
			return { sessionId: header.id, pending: [] };
		},
		apply(state, event) {
			if (event === undefined || event === null || !PAIR_EVENTS.has(event.type)) return state;
			const payload = event.data;
			if (event.type === "command/run") {
				if (!PAIR_COMMAND_NAMES.has(payload?.name)) return state;
				return { ...state, pending: state.pending.concat(payload.commandId) };
			}
			// Settling a pending id changes the state reference and refreshes
			// the view from the record written by the handler.
			if (!state.pending.includes(payload?.commandId)) return state;
			return {
				...state,
				pending: state.pending.filter((id) => id !== payload.commandId),
			};
		},
		wire: {
			viewSchema: PairingWireSchema,
			view(state) {
				let record;
				try {
					record = domain.table("sessions").get(state.sessionId);
				} catch {
					record = undefined;
				}
				const value = { active: record?.active === true };
				// Keep malformed or non-http(s) URLs away from window.open.
				if (value.active && typeof record.url === "string" && /^https?:\/\//i.test(record.url)) {
					value.url = record.url;
				}
				const signature = JSON.stringify(value);
				const previous = memoBySession.get(state.sessionId);
				if (previous !== undefined && previous.signature === signature) {
					return previous.value;
				}
				memoBySession.set(state.sessionId, { signature, value });
				return value;
			},
		},
	};
}

/**
 * Register when the profile has `ctx.sessionProjections`; otherwise do nothing.
 * Resolve the registry at apply time and return its disposer unchanged.
 * @param ctx - host context; the registry is optional and read with `ctx.get`.
 * @param domain - opened marimo_pair domain handle.
 * @returns the registration disposer, or a no-op when the registry is absent.
 */
export function registerPairingProjection(ctx, domain) {
	const registry = ctx.get?.("sessionProjections");
	if (registry === undefined || registry === null) return () => {};
	return registry.register(createPairingProjection(domain));
}
