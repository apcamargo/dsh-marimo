/**
 * Plugin configuration.
 * @module @apcamargo/dsh-marimo/config
 */

import Schema from "@deepseek-ai/schemastery";

/** Node clamps larger timers to 1 ms, so deadlines must fit its timer range. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * @typedef {object} Config
 * @property {number} executeTimeoutMs - time limit for one `marimo_execute_code` call.
 * @property {number} healthTimeoutMs - time limit for one `/health` probe.
 * @property {number} sessionsTimeoutMs - time limit for one `/api/sessions` request.
 * @property {string} tokenEnvVar - environment variable carrying the marimo token.
 * @property {string[]} extraRegistryDirs - extra marimo server-registry directories to scan.
 * @property {string[]} allowRemoteHosts - non-loopback hosts the tools may target. Loopback is always allowed.
 */
export const Config = Schema.object({
	executeTimeoutMs: Schema.natural()
		.min(1000)
		.max(MAX_TIMEOUT_MS)
		.default(120000)
		.description("Time limit for one marimo_execute_code call, including the kernel's whole reply stream."),
	healthTimeoutMs: Schema.natural()
		.min(250)
		.max(MAX_TIMEOUT_MS)
		.default(2000)
		.description("Time limit for one /health probe during discovery and connect."),
	sessionsTimeoutMs: Schema.natural()
		.min(250)
		.max(MAX_TIMEOUT_MS)
		.default(5000)
		.description("Time limit for one /api/sessions request."),
	tokenEnvVar: Schema.string()
		.default("MARIMO_TOKEN")
		.description("Environment variable read at call time for the marimo token. Never a tool argument."),
	extraRegistryDirs: Schema.array(Schema.string())
		.default([])
		.description("Extra marimo server-registry directories to scan during discovery, in addition to the platform default."),
	allowRemoteHosts: Schema.array(Schema.string())
		.default([])
		.description("Non-loopback hostnames the tools may target. They are denied by default. Loopback is always allowed."),
});

/**
 * @param {Config} config
 * @returns {Config} the validated configuration with defaults applied.
 */
export function resolveConfig(config) {
	return Config(config ?? {});
}
