/**
 * Public type surface of `@apcamargo/dsh-marimo`.
 *
 * The runtime is plain ESM JavaScript; these declarations describe the plugin
 * entry, command grammar, and state helpers for type-only consumers.
 * @module @apcamargo/dsh-marimo
 */
import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
import type { Config } from "./config.js";

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		/** The pairing turns this plugin queues; the harness has no shared plugin source kind. */
		"apcamargo-dsh-marimo": { readonly kind: "apcamargo-dsh-marimo" };
	}
}

/** Cordis plugin name. */
export declare const name = "dsh-marimo";

/** Required services: commands, tools, system prompt, skills, and the state domain. */
export declare const inject: readonly ["commands", "tools", "systemPrompt", "skills", "storageDomain"];

/** Name and position of the pairing policy system-prompt section. */
export declare const POLICY_SECTION: { readonly name: "dsh-marimo:policy"; readonly order: 550 };

/** Schemastery schema for the plugin configuration; cordis validates the entry's config with it. */
export declare const Config: z<Config>;

/** Register the plugin surfaces and drain active work before closing storage. */
export declare function apply(ctx: Context, config?: Partial<Config>): Promise<void>;

/** One session's durable pairing state record. */
export interface PairingSessionRecord {
	/** Whether a pairing is currently active in this session. */
	active: boolean;
	/** Base URL of the paired marimo server, as given at connect. */
	url?: string | undefined;
	/** Absolute notebook file path resolved from the active session at connect. */
	notebookPath?: string | undefined;
	/** marimo session id resolved at connect; goes stale on browser reconnect. */
	marimoSessionId?: string | undefined;
	/** Where the target came from: `discovered` or `user-url`. */
	origin?: string | undefined;
	/** ISO timestamp when the pairing started. */
	startedAt?: string | undefined;
	/** Session title this plugin pinned at pairing time, kept across the pairing's end. */
	title?: string | undefined;
}
