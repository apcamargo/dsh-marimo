/**
 * Prompts for active pairings, connection results, and handoffs.
 *
 * The policy uses only fields fixed at pair time. Avoid clocks and liveness
 * probes so unchanged pairings produce identical text and preserve caching.
 *
 * @module @apcamargo/dsh-marimo/prompts
 */

function truncate(text, max = 40) {
	const value = String(text ?? "");
	return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * Render a short pairing policy. The skill carries the full reference.
 * @param {{ url?: string, notebookPath?: string, origin?: string, startedAt?: string }} record
 * @returns {string} the policy text, or "" for a record without connection facts.
 */
function renderPairingPolicy(record) {
	if (!record?.url) return "";
	const notebook = record.notebookPath ? truncate(record.notebookPath, 60) : "unknown notebook";
	return `# Marimo pairing active

You are pair-programming with the user on a live marimo notebook server at ${record.url} (notebook: ${notebook}).

marimo is a reactive Python runtime: cells are connected by the variables they define and reference, and running a cell re-executes its dependents in dataflow order. The active runtime holds the kernel namespace, cell state, and dataflow graph. The notebook (.py file) is the artifact the kernel writes from that state. The user interacts with the same runtime through the notebook UI.

**WARNING. The active runtime is the source of truth.** During this session you MUST NOT modify the notebook's .py file. File edits WILL NOT reach the active kernel or the user, and the kernel may overwrite them on save. Reading disk is fine, but prefer the cell code from the notebook state. All durable changes go through \`marimo._code_mode\` (\`cm\`), which you submit via the \`marimo_execute_code\` tool.

\`marimo._code_mode\` is a PRIVATE, UNSTABLE agent API. Its leading underscore marks it as private. NEVER import it from notebook cells, library code, or anything the user would run. Import it only from the scratchpad through \`marimo_execute_code\`.

**Required first command for each kernel, including read-only tasks:**
1. Run \`import marimo._code_mode as cm; help(cm)\` via \`marimo_execute_code\` once.
2. Wait for successful output.
3. Only then use \`cm.get_context()\` or another \`cm\` API in a later call.
Never run task-specific \`cm\` code before the inspection command succeeds.

\`marimo_execute_code\` evaluates Python in the kernel's scratchpad, a temporary namespace with a shallow copy of the kernel globals. Notebook variables are available by name. New top-level bindings and rebindings disappear after each call. In-place mutations of notebook-owned objects persist. Use top-level \`async with cm.get_context() as ctx:\` directly. Do not wrap it in \`asyncio.run(...)\`. Queue mutation methods inside the context synchronously and do not await them. marimo applies queued changes when the context exits cleanly and discards them if it raises. Later code in the same scratchpad call reads fresh state via \`ctx.globals[...]\`, not the copied name.

marimo keeps the notebook a DAG. Do not create cycles, redefine public names across cells, or use wildcard imports. Each public name has one owning cell. Private \`_prefixed\` names are cell-scoped. \`create_cell\`/\`edit_cell\` change structure only. Queue \`ctx.run_cell(...)\` to execute. Read a cell from \`ctx.cells[...]\` before \`edit_cell\`, and submit the full replacement. Reuse the notebook's existing names and imports. Deleting a cell is destructive. Query \`ctx.graph.descendants(cid)\` first.

Load the \`marimo-pair\` skill for the full reference: the \`cm\` API recipes, gotchas, widget and visualization patterns, and notebook improvements.`;
}

/** Keep the file-edit prohibition when the pairing state cannot be read. */
const POLICY_FALLBACK = "marimo pairing is active but its policy text is unavailable, so do not edit the notebook .py file directly.";

/**
 * The connected turn queued when `/marimo-pair` succeeds: the model starts its
 * next request already knowing the connection and that the inspection ran.
 * @param {{ url: string, notebookPath?: string }} target
 * @returns {string}
 */
function buildConnectedPrompt(target) {
	const notebook = target.notebookPath ? `\n- Notebook: ${target.notebookPath}` : "";
	return `A marimo pairing session just started.

- Server: ${target.url}${notebook}
- The required first command (\`import marimo._code_mode as cm; help(cm)\` via \`marimo_execute_code\`) already ran successfully during connect. Do not repeat it.
- Load the \`marimo-pair\` skill now for the full pairing rules before doing notebook work.
- Drive the notebook only through \`marimo_execute_code\` (scratchpad + \`cm\`) and never edit the notebook's .py file.`;
}

/**
 * Ask the agent to explain a command failure and help fix it without retrying
 * the human-only command.
 * @param {string} command - the failing human command, without the slash.
 * @param {string} reason - the failure text the command outcome carries.
 * @returns {string}
 */
function buildPairingFailurePrompt(command, reason) {
	return `The /${command} command just failed, so the requested pairing action did not happen.

Failure:
${reason}

Explain to the user what happened and what to do next. You may use \`marimo_discover_servers\` or \`marimo_list_sessions\` to inspect what the plugin sees. Do not retry /${command} yourself because it is a human command.

For a marimo-side fix, recommend starting it with \`marimo edit notebook.py --no-token\` and opening the notebook in the browser. A token-authenticated server can instead be paired by URL after setting the token variable in the harness environment. If an existing pairing is blocking the connection, tell the user to run /end-marimo-pair first.`;
}

/**
 * The handoff turn queued by `/end-marimo-pair summary`: a structured record
 * of what was done to the notebook, usable after the session leaves the state.
 */
const PAIRING_SUMMARY_PROMPT = `We are leaving the marimo pairing session and returning to ordinary work.
Create a structured handoff of the pairing that happened in this session.

Required sections (in order):

## Pairing Scope
- The notebook server and notebook file that were paired
- What the session set out to do

## Notebook Changes
For EACH change made through \`cm\`:
- The cell (id/name) and what it now does
- Whether it was run, errored, or left queued

## Notebook State
- Key variables now defined and their owning cells
- Anything left un-run, errored, or intentionally queued

## Notes & Follow-ups
- Gotchas hit (StaleCellError, multiply-defined names, cached modules, ...)
- Anything the user should know on the next open of the notebook

Preserve exact cell ids, names, and error messages where available.`;

export { PAIRING_SUMMARY_PROMPT, POLICY_FALLBACK, buildConnectedPrompt, buildPairingFailurePrompt, renderPairingPolicy, truncate };
