## cables mcp server

cables mcp server as an operator. this enables communication of an llm/ai with the cables editor directly: reading and changing patches, writing op code, taking screenshots, running editor commands and more.

### USE WITH CAUTION

- the ai can change, delete and save your patch and your op code. keep backups.
- the server listens on port `3000` without any authentication, and on all network interfaces. anyone who can reach that port on your machine can control the editor. only run it on a trusted network.

### installation

the McpServer op is included in the [cables standalone](https://cables.gl/standalone), there is nothing to install. all you need to do is set up your client (the ai tool that should talk to the editor), see [setup](#setup).

- add the McpServer op to your patch, the server starts with it
- the op output `Started` shows if the server is running, `Log` shows the latest request
- the op title shows how often it was called (e.g. "called 12x"), so you can see that a client is still connected
- the op output `Stats` is an object with the number of calls per tool, the total, the last tool and when it was called, e.g. link it to `Ops.Ui.VizObject`. the counts are kept until the editor reloads
- open op code editor by pressing [e] and then you should be able to chat about this code

this repository is the source of the op. to work on the op itself or to use a newer version than the one in your standalone, add the folder of this repository as an op dir in a self built standalone.

### setup

the mcp server is not a separate program: it runs inside the editor, as the McpServer op, and listens on `http://localhost:3000/mcp` (streamable http transport, no authentication). so a client can only use it if it can open a http connection to that address, and the editor has to be running with the op in the patch.

there are two kinds of clients:

- **local clients** run on your machine (or a vm/container that can reach it) and connect from there: terminal agents (claude code, codex cli, gemini cli), editors and ide extensions (cursor, vs code, windsurf, cline, zed) and the desktop apps that can talk to local servers. these work.
- **cloud clients** make the connection from the provider's servers, not from your computer: the chat websites and their "connectors" (chatgpt, claude.ai web), and the remote mcp tool of the openai and anthropic apis. `localhost` means the provider's machine there, so these can **not** reach the editor.

setup of the common local clients (config formats change between versions, check the docs of your client if one does not work):

| client | setup |
|---|---|
| claude code | run on cli: `claude mcp add --transport http cables http://localhost:3000/mcp` (add `--scope project` to write a `.mcp.json` into the project) |
| codex cli | in `~/.codex/config.toml`: `[mcp_servers.cables]` with `url = "http://localhost:3000/mcp"` (older versions only support stdio servers and need the bridge below) |
| gemini cli | in `~/.gemini/settings.json`: `"mcpServers": { "cables": { "httpUrl": "http://localhost:3000/mcp" } }` |
| cursor | in `.cursor/mcp.json` or `~/.cursor/mcp.json`: `"mcpServers": { "cables": { "url": "http://localhost:3000/mcp" } }` |
| vs code (copilot) | in `.vscode/mcp.json`: `"servers": { "cables": { "type": "http", "url": "http://localhost:3000/mcp" } }` |
| any other client with http support | url `http://localhost:3000/mcp`, transport "http" / "streamable http" |
| clients with stdio only (e.g. `claude_desktop_config.json` of claude desktop) | use a bridge: `"cables": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--allow-http"] }` |

if the client runs somewhere else than the editor (a vm, a container, another machine), `localhost` is that other machine. forward the port, e.g. `ssh -N -L 3000:localhost:3000 user@editor-host`, or use the address of the editor machine, but remember that the server has no authentication (see above).

#### openai (chatgpt, responses api) and the local requirement

chatgpt (apps/connectors, developer mode) and the remote mcp tool of the openai responses api are called **by openai's servers**. they need a public https url and cannot reach `http://localhost:3000`. this is why with openai products you have to use a local client instead: **codex cli** (or the codex ide extension), or any other local agent that supports mcp. these run on your machine, so they reach the editor directly.

the native chat apps (chatgpt, claude.ai in the browser) therefore do not work, even when the desktop app is installed on the same machine, as long as the mcp connection is made by the provider's cloud. a desktop app only works if it has its own local mcp support (config file or "add local server"), then it behaves like the clients in the table above.

exposing the editor through a public tunnel (ngrok, cloudflared) would make cloud clients work technically, but the server has **no authentication and can run code in your editor**: anyone who finds the url controls your patch and your op code. do not do it without putting authentication in front of it.

### reading console logs

`get-console-logs` reads the editor console through the chrome devtools protocol. for that cables standalone has to be started with remote debugging enabled:

```
npm run start -- --remote-debugging-port=9222
```

the McpServer op connects to `localhost:9222` itself, so `get-console-logs` works without any further setup. without the debug port it returns nothing.

electron only opens the debug port on `127.0.0.1` of the machine it runs on. to use it from somewhere else (e.g. an ai agent running in a vm), forward it with a reverse ssh tunnel, started on the machine running cables standalone:

```
ssh -N -R 9222:localhost:9222 user@vm-host
```

the port is then available as `localhost:9222` on the other machine, e.g. `curl http://localhost:9222/json/version` shows the browser and `/json` the open pages. the tunnel runs until it is stopped (ctrl+c).

anyone who can reach the debug port has full control over the editor (it can run any code), so never expose it on a network.

## what the ai can do

ops in the patch are identified by their op id, ports by their name. use `get-patch-overview` or `cables://patch.json` to find them.

### resources

| uri | |
|---|---|
| `mcpfile:///{name}` | files currently opened in the code editor |
| `cables://patch.json` | read-only structure and data of the current patch |
| `cables://op/{opname}` | read-only source code of an op |
| `cables://opdoc/{opname}` | documentation of an op as json |

some clients don't expose resources to the ai, so they can also be used with the tools `list-resources` and `read-resource`.

### patch

| tool | |
|---|---|
| `get-patch-overview` | compact overview: one line per op with id, name, title, subpatch and links, optionally with changed port values |
| `get-unreleased-op-ids` | compact JSON list of current-patch op instance ids whose documented ops are unreleased |
| `get-patch-op` | one op from the patch as json: port values, uiAttribs, storage, links |
| `get-port-values` | current runtime values of all input and output ports of an op, including linked ports, to check what flows through a link |
| `get-patch-errors` | ops with errors/warnings (shader errors, missing links, wrong types) and code diagnostics |
| `add-op` | add an op by its full name, optionally at a position |
| `delete-op` | delete an op and its links |
| `set-port-value` | set the value of an input port |
| `batch-add-ops` | add several ops in one call with port values, comments and the links between them (names are checked first) |
| `batch-set-port-values` | set several input port values in one call, failures are listed |
| `batch-link-ports` | link several ports in one call, failures are listed |
| `copy-paste-ops` | copy and paste ops like ctrl+c / ctrl+v, links between the copied ops are kept |
| `set-op-stacked` | stack or unstack ops inside a loop area that allows stacking |
| `trigger-port` | trigger a trigger port directly |
| `link-ports` | link an output port to an input port |
| `unlink-ports` | remove a link |
| `set-op-comment` | set the comment of an op |
| `set-op-enabled` | enable or disable ops, like pressing "d" |
| `save-patch` | save the patch (like ctrl+s) |
| `set-patch-name` | rename the patch |
| `upload-file` | upload a file into the patch's asset folder, from a url or base64 content |
| `clear-patch` | delete all ops except the McpServer op and the ops linked to it (e.g. its logger) |
| `upgrade-ops` | replace ops with the newest version of their op, like "Upgrade selected ops", or all outdated ops with `all` |
| `downgrade-ops` | replace ops with the previous version of their op, like "Downgrade selected op" |

### patches from cables.gl

| tool | |
|---|---|
| `load-patch-json` | download a public patch by id, short id or url and add its ops to the current subpatch, like pasting them |
| `load-example-patch` | the same with the example patch of an op, by op name (falls back to the example of an older version) |
| `upload-patch` | upload the current patch json (ops and ui, no op code or assets) to cables.gl as a new private patch, or overwrite one with `projectId`; `server` picks another server, e.g. `https://dev.cables.gl` |
| `upload-patch-assets` | upload files from the patch directory as assets of a patch on cables.gl, use it after `upload-patch` (which does not upload assets) |
| `add-patch-to-patchlist` | add a patch on cables.gl to a patchlist there |

file ports pointing at `/assets/...` are rewritten to load from `https://devsandbox.cables.gl/assets/...`. ops that are not available locally (e.g. user or patch ops) are left out and reported. `clear` deletes all ops first, like `clear-patch`.

`upload-patch` needs a cables.gl api key, entered in the standalone preferences ("cables.gl API key"). unsaved changes are saved first. it fails when the patch uses `Ops.Local` ops, they do not exist on the server. only the patch is uploaded: ops that the server does not have (new or changed team/user ops) have to be published there separately.

### patch editor view

| tool | |
|---|---|
| `patch-view` | report, scroll and zoom the patch field, or fit it to all/some ops |
| `patch-field-screenshot` | screenshot of the patch field (ops and links) |
| `focus-op` | center an op and open its param panel, so you can see what the ai is talking about |
| `select-op` | select ops, like clicking them |
| `bookmark-op` | bookmark an op or remove its bookmark (stored with the patch) |
| `move-op` | move an op in the patch field |
| `batch-move-ops` | move several ops in one call, one undo step |
| `check-layout` | check the layout as text: overlapping ops and comments, links going up, links running behind ops |
| `tidy-up-ops` | arrange the selected ops in rows following their links (undoable) |
| `timeline-screenshot` | screenshot of the timeline panel |

### timeline and keyframes

| tool | |
|---|---|
| `timeline` | play/pause the timeline, set its time, or report time and play state |
| `set-port-animated` | make a number input port animated or not animated (undoable) |
| `get-anim` | keyframes (time, value, easing), loop mode, length and current value of an animated port |
| `set-keyframes` | add or change keyframes with easings, optionally clear first and set the loop mode (undoable) |
| `delete-keyframes` | delete keyframes by their time (undoable) |

an animation can be reused: animate the `Value` port of `Ops.TimeLine.Anim` and link its `Anim` output to several `Ops.TimeLine.AnimGetValue` ops.

### rendering

| tool | |
|---|---|
| `screenshot` | screenshot of the rendering canvas |
| `set-canvas-size` | set the size of the rendering canvas |
| `inspect-element-port` | the html element in an object port: canvas, image, video and image bitmaps as png, other elements as tag, style, rect and html |

### op code

| tool | |
|---|---|
| `search-ops` | search all available ops by name and summary |
| `list-op-docs` | list all documented ops |
| `get-op-summary-doc` | short docs of an op: summary, description and ports, one per line |
| `get-full-op-docs` | all docs of an op as json: ports layout, libs/dependencies, ids, newer versions |
| `read-op` | read op code with line numbers, or a range of lines, or only lines containing a text (also searches the op's `att_inc_*.js` includes, with file names) |
| `edit-op-text` | change op code by replacing a text, the op is saved and re-executed |
| `edit-op` | open an op in a code editor tab, so the person at the editor sees it |
| `create-op` | create a new op (only `Ops.Local.*`), optionally with code and attachments |
| `rename-op` | rename an op or move it to another namespace, its instances in the patch are replaced (standalone only) |
| `clone-op` | copy an op to a new name or a new version (e.g. `_v2`), optionally replacing it in the patch |
| `set-op-summary` | set the one line summary of an op |
| `add-op-changelog` | add an entry to the changelog of an op |
| `list-op-attachments` | list the attachment files of an op |
| `read-op-attachment` | read an attachment |
| `write-op-attachment` | write or create an attachment |
| `delete-op-attachment` | delete an attachment |
| `write-opened-resources` | write a file that is opened in the code editor |
| `list-op-dependencies` | dependencies of an op and the dependency types the platform supports |
| `add-op-dependency` | add a dependency: url, local file, npm package, corelib or op |
| `remove-op-dependency` | remove a dependency |
| `read-op-dependency` | read a local dependency file, e.g. `./lib.js` |
| `write-op-dependency` | write a local dependency file and add it to the dependencies |

### editor

| tool | |
|---|---|
| `list-commands` | list editor commands (the same as the command palette) |
| `run-command` | run an editor command, e.g. "Reload Editor" |
| `get-console-logs` | read the editor console, including webgl warnings (needs `--remote-debugging-port=9222`) |
| `get-jobs` | what the editor and the patch are currently loading, to find stuck loading |
| `get-build-info` | when the running ui and core were built and from which commit, to check a change is live |
| `reload-editor` | reload the editor page, optionally saving or discarding unsaved changes |
| `perf-profiler-read` | per frame durations and counts of the patch's perf profiler |
| `patch-profiler-read` | the most expensive ops of the running patch, like the Patch Profiler tab |
| `ui-profiler-start` / `ui-profiler-read` | measure the editor's own ui code |
| `debug-glop` | temporary debugging tool for the patch field |

### good to know

- editing an op's code re-executes it: all instances of the op are recreated and get new op ids, so get them again afterwards.
- only one op can be opened in the code editor at a time.
- never run "Create new patch" through `run-command`: the new patch has no McpServer op, so the connection is gone.
- changes to the standalone's main process (e.g. its api) need an app restart, "Reload Editor" is not enough.
- the McpServer op itself can be edited through mcp, the server restarts after the change. until it is listening again (a few seconds) requests fail, and a broken change stops the server, so it can not be fixed through mcp anymore.

### code structure

the op code is split into include attachments (`att_inc_*.js`), they are put in front of the op code in alphabetical order. each include has the helpers and the tools of one area, its `register...Tools(server)` function defines the tools and is called by `buildMcpServer`:

| file | |
|---|---|
| `Ops.Mcp.McpServer.js` | ports, shared helpers, call stats, resources and the remaining tools (ports, links, ops, saving, uploading, commands, op docs, profilers, build info, reload), `buildMcpServer`, the http server |
| `att_inc_anim.js` | timeline, animated ports, keyframes and easings |
| `att_inc_batch.js` | the batch tools: adding, linking, moving ops and setting port values in one call |
| `att_inc_console.js` | `get-console-logs`: the editor console via the devtools protocol |
| `att_inc_opfiles.js` | reading, editing, creating, renaming and cloning op code, attachments and dependencies |
| `att_inc_patchinfo.js` | patch errors, the patch overview, a single patch op |
| `att_inc_patchjson.js` | loading patches from cables.gl, upgrading/downgrading ops, clearing the patch |
| `att_inc_patchview.js` | scrolling/zooming the patch field, focusing, selecting, bookmarking and moving ops |
| `att_inc_screenshots.js` | screenshots of the canvas, the patch field and the timeline, inspecting element ports |
| `att_inc_tidyup.js` | `tidy-up-ops` and its layout |

`buildMcpServer` wraps `server.tool` and `server.registerResource` before anything is registered, so every tool and resource is counted in `Stats` under its name without code in the tools themselves.

an include must not use constants of the main op code at the top level, only inside functions. the `register...Tools` functions run while the server is built, so constants they use in tool descriptions or schemas have to be declared before `buildMcpServer()` is called, or in an include.

changing includes and main code at once is not possible with single edits: write new functions to an include first (a function declared twice is fine, the one in the main code wins), then remove them from the main code. a constant declared twice is a syntax error.



 **note:** the McpServer op and this readme were mostly written by an AI (Claude, by Anthropic, using Claude Code), directed, tested and reviewed by pandur.
