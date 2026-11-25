/** Validated marimo pairing configuration after defaults are applied. */
export interface Config {
	/** Time limit for one execution call, including its full response stream. */
	executeTimeoutMs: number;
	/** Time limit for one server health check. */
	healthTimeoutMs: number;
	/** Time limit for one active-session list request. */
	sessionsTimeoutMs: number;
	/** Name of the environment variable containing the marimo token. */
	tokenEnvVar: string;
	/** Additional marimo server-registry directories to scan. */
	extraRegistryDirs: string[];
	/** Non-loopback hostnames that may receive code or authentication tokens. */
	allowRemoteHosts: string[];
}
