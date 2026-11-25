# Driving a live marimo notebook

marimo is a reactive Python runtime for building reproducible Python programs
(marimo notebooks). Cells are connected by the variables they define and
reference. Running a cell re-executes dependents in dataflow order. The active
runtime holds the kernel namespace, cell state, and dataflow graph. The
notebook (`.py` file) is the artifact the kernel writes from that state while a
session is running.

A user interacts with the same runtime via a notebook UI with cells, outputs,
and widgets.

**WARNING. The active runtime is the source of truth.** During a session, you
MUST NOT modify the associated `.py` file. File edits WILL NOT reach the active
kernel or user, and the kernel may overwrite them on save. Reading disk is
fine, but prefer the current cell code from the notebook state. Use
`marimo._code_mode` (`cm`) for notebook changes. This applies to every file
tool, even for small changes — use `ctx.edit_cell(...)` instead.

## The tools

- `marimo_execute_code` — evaluate Python in the live kernel's scratchpad.
  Arguments: `code` (required), plus optional `url`, `file`, and `session`
  overrides. Defaults to the server paired by `/marimo-pair`.
- `marimo_discover_servers` — list running marimo servers from the local
  server registry. Read-only.
- `marimo_list_sessions` — list the active sessions (open notebooks) on the
  paired server or a given `url`.

Commands: `/marimo-pair` pairs this session with a server; `/end-marimo-pair`
leaves the pairing. Ask the user to run them — they are human commands.

## Required first kernel command

Start every code-mode session with this dedicated command:

```
marimo_execute_code code="import marimo._code_mode as cm; help(cm)"
```

Follow this order for each kernel, including read-only tasks:

1. Run the inspection command once.
2. Wait for successful output.
3. Then use `cm.get_context()` or another `cm` API in a later call.

Do not run task-specific `cm` code before the inspection command succeeds.

`marimo._code_mode` is a PRIVATE, UNSTABLE agent API (note the leading
underscore). It exists for tools like these to drive a live kernel from the
scratchpad. Its own docstring says so: internal, agent-only, no versioning
guarantees — may change or be removed without notice. DO NOT import it from
notebook cells, library code, or anything a user would run. Treat every
`import marimo._code_mode as cm` as scratchpad-only.

## Connecting to a notebook

`/marimo-pair` discovers a running server, probes it, resolves the active
session, runs the required inspection command, and pairs this session with it.
Once paired, `marimo_execute_code` targets the paired server automatically.

If no server is running and the user wants a notebook, start marimo yourself
(see "Starting marimo" below) and ask the user to open the notebook UI, then
run `/marimo-pair` again. `marimo_discover_servers` reports live servers;
`marimo_list_sessions` shows the notebooks open on one.

## Scratchpad Scope

`marimo_execute_code` evaluates Python in marimo's scratchpad: a temporary
namespace with a shallow copy of the kernel globals. Notebook variables are
available by name, but new top-level bindings and rebindings are discarded
after each call. In-place mutations to notebook-owned objects can persist
because those names still reference live objects.

Each call reports stdout and stderr from the scratchpad, plus console output
from notebook cells it causes to run, including reactive descendants.

### Ordinary Python

Use ordinary Python in the scratchpad to inspect variables, sample data, test
transformations, probe APIs, check imports, and read widget state.

```python
print(df.head())

x = 10
print(x)
```

Here `df` comes from notebook globals, while `x` is a scratchpad-local binding.
`x` exists for this call only and WILL NOT be added to notebook globals.

### Persist with `cm`

Top-level scratchpad assignments and rebindings are temporary. To persist
work, including new variables, you MUST submit changes through
`marimo._code_mode` (`cm`).

Open a code-mode context to queue notebook changes:

```python
import marimo._code_mode as cm

async with cm.get_context() as ctx:
    cid = ctx.create_cell("x = df.head()")
    ctx.run_cell(cid)
```

The scratchpad supports top-level async code. Use `async with` directly;
wrapping it in `asyncio.run(...)` is unnecessary and can conflict with the
kernel's event loop.

After this block exits and the new cell runs, `x` is notebook state. Later
scratchpad calls can read `x` by name. Code later in the same scratchpad call
should read `ctx.globals["x"]`, because the scratchpad namespace was copied
before the cell ran.

Inside the context, queued mutation methods are synchronous. Call them
directly; do not `await` them. Each call queues an operation for marimo to
apply when the context exits normally. If the block raises, the queue is
discarded.

On clean exit, marimo applies packages, validates and applies structural cell
changes, runs queued cells, then may run dependents. Validation is only
structural since queued cell runs can still error. `create_cell` and
`edit_cell` change notebook structure only. Use `run_cell` to execute.

`create_cell` currently defaults to `hide_code=True`, which collapses the code
editor in the UI. Pass `hide_code=False` if the user wants created cells to be
visible without manually expanding them. `create_cell` also accepts
`before`/`after` (position), `name`, `column`, `expand_output`, and `disabled`.

For read-only work, `cm.get_context()` also works outside the context manager:
`ctx = cm.get_context()` then read `ctx.cells`, `ctx.graph`, or
`ctx.globals`.

### Two guards marimo enforces by default

- `edit_cell` raises `StaleCellError` if you overwrite a cell whose code has
  changed since you last read it. Re-read the current body from
  `ctx.cells[...]` and retry. Never set `skip_staleness_check=True` to
  overwrite blindly — only when the user explicitly wants prior content
  discarded.
- A dry-run compile check runs when the context exits: syntax errors,
  multiply-defined names, and cycles are caught *before* any graph mutation is
  applied. It is cheap and should almost never be disabled. Only set
  `skip_validation=True` when you intentionally need to insert code that would
  fail validation (e.g. incomplete stubs the user plans to fix by hand).

## Marimo Rules

marimo imposes a small contract on notebook code so it can keep the notebook as
a directed acyclic graph (DAG):

- **No cycles** - cells cannot depend on each other in a cycle.
- **No public redefinitions across cells** - each name has one owning cell.
- **No wildcard imports** - `import *` prevents static analysis of definitions.

These rules keep the kernel, UI, and saved artifact consistent.

When `cm` submits a cell body, marimo parses its top-level definitions and
references. Public names enter the graph. Names that start with `_` are local
to their cell and unavailable to other cells. If a `cm` edit violates the
contract, marimo rejects the structural change and returns the validation
error.

## The Notebook's Shape

A notebook is an ordered collection of cells. `ctx.cells` is the document view
and `ctx.graph` is the dataflow view.

```python
for cell in ctx.cells:
    cell  # .id, .code, .name, .config, .status, .errors

ctx.cells["setup"]         # by name
ctx.cells[0]               # by position
list(ctx.cells.keys())     # all IDs, in notebook order
```

Cell IDs are opaque strings which can be queried from the notebook or captured
from `cm` return values:

```python
cid = ctx.create_cell("df = pd.read_csv('data.csv')")
print(cid)   # e.g. 'Hbol'
```

Alternatively, cells can be assigned and referenced by `name`. The graph can be
used to understand its role in the dataflow.

```python
for cid, impl in ctx.graph.cells.items():
    impl  # .defs, .refs   (sets of public names)

ctx.graph.descendants(cid)   # cells that re-run when this one changes
ctx.graph.ancestors(cid)     # cells this one depends on
```

In marimo, deletes are *destructive* so it can be useful to query the
descendants prior to deleting to understand its impact.

## Writing Notebook Changes

The graph contract keeps marimo able to run and save the notebook. Passing
those checks alone does not guarantee a useful artifact. Committed cells should
still be readable, rerunnable, and editable.

Make durable edits that reuse the notebook's existing names, imports,
dependencies, and UI model. Don't be lazy. Avoid one-off workarounds that pass
`cm` validation but leave a brittle notebook.

### Cell Bodies

- **Submit cell contents** - `create_cell` and `edit_cell` take cell contents,
  not saved-file `@app.cell` wrappers.
- **Read before replacing** - another editor may change a cell between
  scratchpad calls. Before `edit_cell`, read the current body from
  `ctx.cells[...]` and submit the full replacement. marimo enforces this with
  `StaleCellError` (see above).
- **Reuse notebook imports** - if `np` already exists, use it or edit the
  owning import cell. DO NOT add `import numpy as _np` just to bypass the
  graph.
- **Define each public name once** - a public name has one owning cell.
  Reassigning it in another cell fails with `Multiply-defined names`; edit the
  owning cell or give the result a new name.
- **Run cells deliberately** - `create_cell` and `edit_cell` change structure
  only. Queue `ctx.run_cell(...)` when the cell should execute.

### Cell Boundaries

A cell is also a rerun boundary. Put expensive or reusable computation
upstream of presentation so UI edits stay cheap. Keep cheap,
presentation-specific work with the view when that is easier to read.

Use `mo.vstack` and `mo.hstack` only when the composition is part of the UI.
Narrative often reads better in an adjacent markdown cell.

### Prefer `cm`-Managed Changes

Use `cm` APIs when they exist. Avoid direct file edits, shell package commands,
and scratchpad-only state for changes that should persist.

- **Do not edit the `.py` artifact** - do not use any file tool on the notebook
  file during a live session. Use `ctx.edit_cell(...)` even for small changes.
- **Manage packages through `cm`** - use `ctx.packages.add()` or
  `ctx.packages.remove()` instead of direct `uv` or `pip`; confirm non-obvious
  dependency changes.
- **Avoid transient paths** - persisted cells should not depend on `/tmp/...`
  unless the work is intentionally transient.
- **Delete deliberately** - deleting a cell removes globals it defines. Reuse
  empty cells when convenient and delete cells left empty after edits.

### UI and Widgets

Inspect the object before changing it. Different UI objects update through
different paths.

- **Set `mo.ui.*` through `cm`** - use `ctx.set_ui_value(element, value)` inside
  `cm.get_context()`.
- **Set anywidget traitlets directly** - synced traitlets are Python
  attributes, for example `widget.value = 5`.

## Starting marimo

Only servers started with `--no-token` register in the local server registry
and are auto-discoverable. If a server has a token, set the `MARIMO_TOKEN`
environment variable in the harness process before pairing by URL.

```sh
marimo edit notebook.py --no-token [--sandbox]
```

Start marimo in edit mode without `--headless` unless the user asks for a
headless server. The notebook UI must be open in a browser before marimo has
an active session for `marimo_execute_code` to target. If running headless,
give the user the local URL and wait for them to open it before executing code.

How you invoke `marimo` depends on context — find the right way to run it.

### Where the registry lives

A registering server writes one JSON file per instance and removes it on clean
shutdown: `$XDG_STATE_HOME/marimo/servers` (default
`~/.local/state/marimo/servers`) on Linux and macOS,
`%USERPROFILE%\.marimo\servers` on Windows. Discovery reads the current
platform's directory; cross-OS (WSL) registry discovery is out of scope.

### Notebooks with PEP 723 metadata require `--sandbox`

Before picking a runner, check the notebook file for a PEP 723 header:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "polars",
# ]
# ///
```

If the block is present, the notebook was authored as a self-contained
sandboxed script and **SHOULD be opened with `--sandbox`**. Without the flag
marimo runs in the ambient environment and silently ignores the inline
dependencies. Imports will fail or, worse, resolve to a different version than
the author pinned.

`--sandbox` works regardless of project context: inside a uv project, `uv run
marimo edit notebook.py --no-token --sandbox` still creates the isolated env
from the PEP 723 block rather than the project's `.venv`.

### Inside a Python project

If there's a `pyproject.toml` in the workspace or a parent directory, check
that marimo is actually in the dependencies before using the project's runner.
Look for `marimo` in `[project.dependencies]`,
`[project.optional-dependencies]` or `[dependency-groups]` (dev deps),
`[tool.pixi.dependencies]`, or the project's `.venv`.

```sh
# uv-managed project
uv run marimo edit notebook.py --no-token
# pixi-managed project
pixi run marimo edit notebook.py --no-token
```

If marimo is in a named dependency group (not the default), specify it:
`uv run --group notebooks marimo edit notebook.py --no-token`. Skip
`--sandbox` here — the project already manages dependencies. If
`pyproject.toml` exists but marimo is **not** in the deps, treat this as
"outside a project" (below).

### Outside a Python project

Prefer `--sandbox`. Sandbox mode creates an isolated environment for the
notebook and writes dependencies into the script itself as inline PEP 723
metadata — so the notebook stays self-contained and reproducible.

```sh
# With uv available (preferred)
uvx marimo@latest edit notebook.py --no-token --sandbox

# With marimo installed globally
marimo edit notebook.py --no-token --sandbox
```

### Global marimo install

If marimo is installed globally, check the version — code mode shipped in
v0.21.1. If the installed version is older, prompt the user to upgrade before
proceeding.

### Nothing found

If no project marimo, no `uv`/`uvx`, and no global `marimo` on PATH, tell the
user to install `uv` (<https://docs.astral.sh/uv/getting-started/installation/>).

## Troubleshooting

Use this reference when the tools cannot reach the intended marimo session,
cannot select a session, or fail because code was passed incorrectly.

### Targeting

- The paired `url` is passed unchanged by the tools; `null` means no address
  was reachable.
- With one open notebook, the tools resolve its session.
- The `file` argument resolves the current session on every call and is stable
  across browser reconnects.
- The `session` argument targets an exact active session ID and goes stale on
  reconnect.
- The selectors are mutually exclusive; the tools reject both together.
  Preserve supplied values; never guess.

### Auth

For token-authenticated servers, set `MARIMO_TOKEN` in the harness process
environment (the plugin reads it at call time; it is never a tool argument and
never attached to `/health`). On macOS, a Finder-launched Desktop app only
inherits it via `launchctl setenv MARIMO_TOKEN ...` (or by launching from a
shell that exports it); restart the harness after setting it. A 401 means the
server requires the token.

### Common errors

- **`[]` from `marimo_discover_servers`** - nothing is registered. Only
  servers started with `--no-token` register; otherwise ask the user for the
  URL, or start marimo with the project's normal tooling.
- **No active sessions on the server** - open the notebook in the browser.
- **No active session matches `file`** - check the exact path against the
  listing the error prints.
- **Multiple sessions on the server** - several notebooks are open; pass the
  `file` path or `session` id shown in the listing.
- **Failed to connect** - check the URL, token, and whether the server is
  still running.
- **Execution did not complete** - the server ended the stream without a
  result. With `file`, retry the same call so it resolves the current session.
  With `session`, the id is probably stale after a page refresh; retry without
  it.
- **Under WSL, 127.0.0.1 is the distro's own loopback, not the Windows host's**
  - run `marimo_discover_servers` and use the URL it reports; restart marimo on
  the host with `--host 0.0.0.0` if needed.
- **SyntaxError** - the submitted Python was malformed; resubmit corrected
  code.
- **ImportError** - diagnose in the notebook kernel. Install packages through
  `cm` when needed.

## Gotchas

### Private variables are cell-scoped

Variables with a `_` prefix are **private to the cell that defines them** in
marimo. They cannot be referenced from other cells — you'll get a `NameError`.

This matters when building notebooks programmatically. A common mistake:

```python
# Cell A
_df = pd.DataFrame(results)   # _df is private to this cell

# Cell B — FAILS
mo.ui.table(_df)               # NameError: name '_df' is not defined
```

**Fix:** Either merge both into one cell, or use a non-private name (`df`).

### Redefining a public name across cells

Each public name has one owning cell. Defining it again in another cell fails
with `Multiply-defined names`. This is easy to hit when building a notebook
incrementally — a second cell reassigns `df`, `results`, `data`, etc.

```python
# Cell A
df = pd.read_csv("data.csv")

# Cell B — FAILS: df already defined in Cell A
df = df.dropna()               # Multiply-defined names: df
```

**Fix — pick one:**

- **Edit the owning cell** if the step belongs there (`ctx.edit_cell`).
- **Use a new name** when later cells need the result (`clean = df.dropna()`).

`ctx.graph.cells[cid].defs` shows what a cell already owns.

### Duplicate public imports across cells

The same single-definition rule applies to imports: a public name (like `pd`)
can only be defined in one cell. If two cells both `import pandas as pd`, you
get a `Multiply-defined names` error at validation.

**Fix:** Reuse the existing import — reference `pd` directly, or edit the
owning cell (`ctx.edit_cell`) if the import belongs there instead. If several
cells each need their own copy, consolidate them into the setup cell or a
shared import-only cell (see "Setup cell" below).

### Delete + create of the same names

When deleting a cell and creating a replacement that defines the same
variables, the compile check can see the old definitions still present and
reject the new cell. Prefer `edit_cell` over delete+create.

### `inspect.getsource()` on methods is indented

`inspect.getsource()` on a class method preserves the original indentation.
Passing this to `ast.parse()` fails with `IndentationError`.

```python
# FAILS
src = inspect.getsource(SomeClass.some_method)
tree = ast.parse(src)  # IndentationError: unexpected indent

# FIX
import textwrap
src = textwrap.dedent(inspect.getsource(SomeClass.some_method))
tree = ast.parse(src)
```

### Cached module availability

Some libraries cache optional-dependency availability at import time.
Installing a package mid-session via `ctx.packages.add()` won't update those
caches. The user may need to restart the kernel — but try known workarounds
first.

#### Polars + pyarrow

`df.to_pandas()` fails with `ModuleNotFoundError: pa.Table requires 'pyarrow'`.

**Workaround** — if this error occurs after installing pyarrow mid-session,
run the following via `marimo_execute_code` (scratchpad), NOT in a cell. The
patch mutates the cached module object in the running kernel, so it doesn't
need to persist in the notebook.

```python
import pyarrow as _pa
import polars.dataframe.frame as _frame_mod
_frame_mod.pa = _pa
```

Then re-run the failing cell.

## Notebook Improvements

When the user asks to improve, optimize, or clean up their notebook, scan the
current cells for these opportunities. Use your judgment — don't over-apply,
and if you're unsure whether a change is worthwhile, ask the user.

### Cell names

Low priority unless the user asks. `setup` and cells defining
functions/classes are auto-named by marimo. Beyond that, naming is optional.
Note that naming markdown cells clutters the UI by showing the cell header
that's normally hidden.

### Review dataflow names

Review names after the cells work and their dependencies are visible.

- Keep values consumed by later cells public.
- Inline small one-use bindings.
- Move dense procedural work into a function.
- Use a private top-level binding when it makes one cell easier to read.

Many private names can mean that a useful stage is hidden or that a cell is
doing too much. Treat this as a prompt to inspect, not a rule.

### Setup cell

A setup cell is named `"setup"` and is guaranteed to run before all other
cells. It's the place for module imports. Consolidating imports here keeps the
notebook clean and ensures every cell can rely on those modules being
available.

**The setup cell cannot reference other cells' variables.** It runs first, so
it must be self-contained: imports, constants, and definitions that depend only
on each other. Reading a name defined elsewhere (e.g. `df`, a UI element) fails
with `The setup cell cannot have references`.

**Keep the setup cell import-only if you can.** marimo skips re-running
descendants when an edited cell contains *only* import statements — this
applies to any import-only cell, but it matters most for `setup`, since every
other cell depends on it: if the setup cell also holds constants or other
non-import definitions, editing it re-runs the *entire* notebook. If you need
setup-time constants too, put them in their own cell downstream of `setup`
rather than mixing them in.

First check if the notebook already has a cell named `"setup"`. If not, create
one and hoist scattered imports into it. `name="setup"` auto-positions the
cell first — no `before`/`after` needed:

```python
cid = ctx.create_cell('''import polars as pl
import marimo as mo
import anywidget
import traitlets''', name="setup")
ctx.run_cell(cid)
```

If a setup cell already exists, `create_cell(name="setup")` raises
`ValueError`; use `ctx.edit_cell("setup", code=...)` and
`ctx.run_cell("setup")` instead.

### Lift reusable functions into their own cells

When a cell contains a single function or class that doesn't reference
variables from other cells, marimo treats it specially — it can be written as a
standalone definition and reused outside the notebook. These functions can use
modules from the setup cell.

Look for functions that **could belong in a library**: data loading,
transforms, parsers, domain logic, custom widgets. If someone might reasonably
`import` it from another module, it's a good candidate to lift into its own
cell.

Don't lift everything — notebook-specific wiring (UI layout, display logic,
cell-level orchestration) should stay where it is. Use `_prefix` for
cell-internal helpers that aren't meant to be reused.

```python
# before: useful logic buried in a larger cell
objects = pl.read_csv("https://example.com/objects.csv")
artists = pl.read_csv("https://example.com/artists.csv")

def top_counts(df, col, n=5):
    return df.group_by(col).len().sort("len", descending=True).head(n)

result = top_counts(objects.join(artists, on="id"), "category")
```

```python
# after: top_counts is general-purpose — give it its own cell

# cell 1
def top_counts(df, col, n=5):
    return df.group_by(col).len().sort("len", descending=True).head(n)
```

```python
# cell 2
result = top_counts(df, "category")
```

### `mo.persistent_cache`

`@mo.persistent_cache` caches a function's result to disk so it isn't
recomputed on subsequent runs. The cache persists across kernel restarts.

```python
@mo.persistent_cache
def load_data():
    objects = pl.read_csv("https://example.com/objects.csv")
    artists = pl.read_csv("https://example.com/artists.csv")
    return objects.join(artists, on="id", how="left")

df = load_data()
```

Good candidates: data loading, ETL, expensive computation that rarely changes.
Don't over-optimize — if you're unsure, suggest it to the user rather than
applying it.

## Rich Representations

Custom visual encodings for data that go beyond standard charts and tables.

### Guiding principles

**Visualization matters.** Helping users build custom visual representations is
one of the highest-impact things the agent can do. A bespoke encoding tailored
to the task — labeling, batch review, comparing variants — lets users *see*
their data in ways that tables and numbers never will. marimo is an environment
where users create their own views, not just consume library charts. Help them
imagine what's possible, then build it.

**Use modern web APIs.** Models may default to older browser patterns; prefer
modern HTML, CSS, and JavaScript that are supported in current browsers. Avoid
build steps unless the task clearly needs them.

**Prefer compact output.** marimo clips cell output at ~610px and scrolls.
Avoid hitting that limit; if you need more space, manage your own scrolling
inside a fixed-height container.

**Keep it thin, make it compose.** A widget is a thin layer over data, not an
application. One clear purpose, few traitlets, small `_esm`. Build small pieces
that compose in the notebook — combine with other cells, UI elements, and
views. Don't over-engineer.

### Decision tree

| Need | Approach |
|------|----------|
| Custom output or interaction | **anywidget** — flexible enough to grow from display-only to interactive |
| Tiny static HTML representation | `_display_()` or `mo.Html` |
| Built-in control used as-is (slider, dropdown) | `mo.ui.*` |

For custom representations, prefer anywidget unless the output is clearly a
small static one-off.

### anywidget

[anywidget](https://anywidget.dev) bridges Python and JavaScript via
traitlets. `.tag(sync=True)` makes a traitlet bidirectional — Python sets a
value → JS sees it; JS calls `model.set()` + `model.save_changes()` → Python
sees it. `_css` is optional global CSS.

**marimo does not render traditional Jupyter widgets.** Libraries like
jscatter, ipyvolume, etc. often have a top-level object whose default
representation is a Jupyter widget
(`application/vnd.jupyter.widget-view+json`). marimo cannot display these — you
need to find the underlying **anywidget** instance, which marimo *does*
support.

Common pattern: look for a `.widget` attribute on the library object:

```python
# jscatter example — Scatter is not renderable, but .widget is an anywidget
scatter = jscatter.Scatter(data=df, x="x", y="y")
scatter.widget  # <-- use this in the cell output
```

When unsure, check in the scratchpad:

```python
import anywidget
obj = scatter.widget  # or whatever accessor the library provides
print(isinstance(obj, anywidget.AnyWidget))  # True = marimo can render it
```

#### `_esm` lifecycle

**Render only** (most widgets):

```js
function render({ model, el }) { /* ... */ }
export default { render };
```

**Initialize + render** (shared state across views, one-time setup):

```js
export default () => {
  return {
    initialize({ model }) {
      // Once per widget instance — timers, connections, shared handlers
      return () => { /* cleanup */ };
    },
    render({ model, el }) {
      // Once per view — display in 3 cells = 3 renders
      return () => { /* cleanup DOM listeners */ };
    }
  };
};
```

- `model.on()` is auto-cleaned when a view is removed
- DOM `addEventListener` is **not** — clean up with `AbortController`

#### Timer example (initialize + render)

`initialize` owns one interval; each `render` view displays it.

```python
import anywidget
import traitlets

_TIMER_ESM = """
export default () => {
  return {
    initialize({ model }) {
      const id = setInterval(() => {
        if (model.get("running")) {
          model.set("seconds", model.get("seconds") + 1);
          model.save_changes();
        }
      }, 1000);
      return () => clearInterval(id);
    },
    render({ model, el }) {
      const controller = new AbortController();
      const { signal } = controller;

      const span = document.createElement("span");
      span.style.cssText = "font: 24px monospace;";

      const btn = document.createElement("button");
      btn.style.cssText = "margin-left: 8px; cursor: pointer;";

      function update() {
        const s = model.get("seconds");
        const mm = String(Math.floor(s / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        span.textContent = `${mm}:${ss}`;
        btn.textContent = model.get("running") ? "⏸" : "▶";
      }

      model.on("change:seconds", update);
      model.on("change:running", update);

      btn.addEventListener("click", () => {
        model.set("running", !model.get("running"));
        model.save_changes();
      }, { signal });

      update();
      el.append(span, btn);
      return () => controller.abort();
    }
  };
};
"""

class Timer(anywidget.AnyWidget):
    seconds = traitlets.Int(0).tag(sync=True)
    running = traitlets.Bool(True).tag(sync=True)
    _esm = _TIMER_ESM
```

#### Composing with the notebook

Widgets become reactive notebook citizens when you bridge a traitlet to
`mo.state`. This is a two-cell pattern — create the widget and wire up the
observer in one cell, read the value in another:

```python
# Cell 1 — widget + observer
timer = Timer()

get_seconds, set_seconds = mo.state(timer.seconds)
timer.observe(lambda _: set_seconds(timer.seconds), names=["seconds"])

timer  # display the widget
```

```python
# Cell 2 — reacts to changes
seconds = get_seconds()
mo.md(f"Timer is at **{seconds}s** — {'running' if seconds > 0 else 'stopped'}")
```

The common pattern is `mo.state(widget.trait)` for the initial value,
`.observe()` on the specific trait name, and reading with the getter in a
downstream cell.

#### CDN dependencies

Import JS libraries from [esm.sh](https://esm.sh) — no build step:

```js
import * as d3 from "https://esm.sh/d3@7";
import { tableFromIPC } from "https://esm.sh/@uwdata/flechette@2";
```

#### DataFrames and binary data

**Prefer reducing data on the Python side.** Aggregate, filter, sample — send
the widget only what it needs. Most widgets should receive a small,
pre-processed payload via simple traitlets (lists, dicts). This keeps the
widget simple and avoids extra dependencies.

**For large tabular data (>2k rows)** where the widget genuinely needs
row-level access, send Arrow IPC bytes instead of JSON. This adds complexity
and dependencies, so only reach for it when the data volume justifies it.

**Python — serialize:**

```python
# Polars (native, no pyarrow needed)
_ipc = df.write_ipc(None).getvalue()

# Any __arrow_c_stream__ source (pandas, narwhals, pyarrow, etc.)
import io, pyarrow as pa, pyarrow.feather as feather

def to_arrow_ipc(data) -> bytes:
    table = pa.RecordBatchReader.from_stream(data).read_all()
    sink = io.BytesIO()
    feather.write_feather(table, sink, compression="uncompressed")
    return sink.getvalue()
```

**JS — deserialize with `@uwdata/flechette`:**

```js
import { tableFromIPC } from "https://esm.sh/@uwdata/flechette@2";
const table = tableFromIPC(new Uint8Array(model.get("_ipc").buffer));
// table.numRows, table.numCols, table.get(i), table.getChild("col_name")
```

Use `traitlets.Any().tag(sync=True)` for the IPC bytes traitlet.

### Reactive anywidgets in marimo

When an anywidget trait (selection, value, zoom, etc.) should drive a
downstream marimo cell, use `mo.state()` + `.observe()` on the **specific
trait**. This is the preferred pattern:

```python
# In the cell that creates the widget:
get_selection, set_selection = mo.state(widget.selection)
widget.observe(
    lambda _: set_selection(widget.selection),
    names=["selection"],
)

# In a downstream cell — re-executes when selection changes:
selection = get_selection()
```

Initialize `mo.state()` with the widget's current trait value — not a hardcoded
default. Read the trait directly off the widget in the lambda. Do **not** use
`change["new"]` or `allow_self_loops=True`.

Two strategies for reactive anywidgets. Choose one per widget — don't mix them:

| Strategy | Reactivity | Best for |
|----------|-----------|----------|
| `mo.state` + `.observe()` | Specific traits you pick | Precision — only named traits trigger downstream cells |
| `mo.ui.anywidget(widget)` | All synced traits as one `.value` dict | Convenience — observe everything at once |

### Programmatic widget control (scratchpad)

Read widget state or set UI controls from the scratchpad — no clicking:

```python
print(timer.seconds)    # read
timer.seconds = 0       # set — frontend updates automatically
```

`mo.ui.*` elements need `ctx.set_ui_value(...)` from code mode; anywidgets use
direct assignment.

### `_display_()` protocol

Any object with a `_display_()` method renders richly in marimo. Return
anything marimo can render — `mo.Html`, `mo.md()`, a chart, a string.

Precedence: `_display_()` > built-in formatters > `_mime_()` > IPython
`_repr_*_()` methods.

```python
from dataclasses import dataclass
import marimo as mo

@dataclass
class ColorSwatch:
    colors: list[str]

    def _display_(self):
        divs = "".join(
            f'<div style="width:40px;height:40px;background:{c};border-radius:4px;"></div>'
            for c in self.colors
        )
        return mo.Html(f'<div style="display:flex;gap:8px;">{divs}</div>')
```

For inline `<script>` tags, use `document.currentScript.previousElementSibling`
to scope to the element — never hardcode IDs (breaks with multiple instances).

### Minimize CLS (Cumulative Layout Shift)

Use `min-height` or `aspect-ratio` on the outer container so the widget
reserves space before content loads or when toggling between states.
