<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/marimo-dark-theme.svg">
  <img alt="marimo" src="assets/marimo-light-theme.svg" width="80" height="80">
</picture>

# dsh-marimo

Share a live [marimo](https://marimo.io) notebook with your coding agent through DeepSeek Harness. The agent can start a notebook or connect to one you already have open. It can inspect data and edit cells while you watch the results update in marimo.

Run `/marimo-pair` to connect the notebook's Python kernel to your session. When you're finished, run `/end-marimo-pair` to disconnect. While paired, a button under the message composer opens the notebook in your browser.

## Install

From a git host:

```bash
dsh plugin --profile web add https://github.com/apcamargo/dsh-marimo.git
```

## Using the plugin

### `/marimo-pair [status|<url> [--file <path>|--session <id>]]`

Start a discoverable notebook with:

```bash
marimo edit notebook.py --no-token
```

Run `/marimo-pair` without a URL to discover servers. If only one is reachable, the plugin pairs with it. If several are running, choose a URL from the list and run:

```bash
/marimo-pair http://localhost:2718
```

If several notebooks are open on that server, select one by file path:

```bash
/marimo-pair http://localhost:2718 --file /path/to/notebook.py
```

If several sessions share the same file path, select the exact session ID instead:

```bash
/marimo-pair http://localhost:2718 --session <id>
```

Starting marimo with `--no-token` registers the server so `/marimo-pair` can discover it. If the notebook declares dependencies in a PEP 723 `# /// script` header, also use `--sandbox` to run it in an isolated environment with those dependencies. If `/marimo-pair` can't find a server, the command prints instructions for starting one.

Each DeepSeek Harness session maintains its own pairing, so multiple sessions can connect to the same server without affecting one another. To switch servers within a session, run `/end-marimo-pair` first, then run `/marimo-pair` with the new server.

`/marimo-pair status` checks the server and lists its open notebooks.

When you pair, the plugin gives an untitled session a temporary title based on the notebook name. It leaves existing session titles unchanged.

### `/end-marimo-pair [status|summary|done]`

```bash
/end-marimo-pair         # summarize and disconnect
/end-marimo-pair summary # same as default
/end-marimo-pair done    # disconnect without a summary
/end-marimo-pair status  # show pairing and server status
```

The summary includes what you asked for, cell changes, the notebook's current state, and any remaining notes.

## Configuration

```yaml
- id: dsh-marimo
  name: "@apcamargo/dsh-marimo"
  config:
    executeTimeoutMs: 120000   # code execution timeout
    healthTimeoutMs: 2000      # health-check timeout
    sessionsTimeoutMs: 5000    # session-list timeout
    tokenEnvVar: MARIMO_TOKEN  # token variable name
    extraRegistryDirs: []      # extra registry directories
    allowRemoteHosts: []       # allowed remote hosts
```

The plugin denies non-loopback targets by default. Add a hostname to `allowRemoteHosts` to pair a remote server.

## Troubleshooting

If `/marimo-pair` reports "No reachable marimo server was found" even though marimo is running, the server may not be registered for discovery. Marimo only registers servers started with `--no-token`. Its default token-authenticated servers don't appear in the registry, so either restart marimo with `--no-token` or pair by URL.

For a token-authenticated server, set the token variable in the DeepSeek Harness process environment. The default variable is `MARIMO_TOKEN`. You can change its name with `tokenEnvVar` in the plugin configuration. Marimo prints the token when the server starts. If DeepSeek Harness was already running, restart it after setting the variable. Then run:

```bash
/marimo-pair http://<host>:<port>
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Derived from [marimo-team/marimo-pair](https://github.com/marimo-team/marimo-pair). Copyright 2026 Marimo Team, Apache-2.0.
