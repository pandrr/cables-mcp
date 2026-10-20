## cables mcp server

cables mcp server as an operator. this enables communication of an llm/ai with the cables editor directly: reading and changing patches, writing op code, taking screenshots, running editor commands and more.

> **note:** the McpServer op and this readme were mostly written by an AI (Claude, by Anthropic, using Claude Code), directed, tested and reviewed by pandur.

### USE WITH CAUTION

- the ai can change, delete and save your patch and your op code. keep backups.
- the server listens on port `3000` without any authentication, and on all network interfaces. anyone who can reach that port on your machine can control the editor. only run it on a trusted network.

### how to install op

- check out this repository
- start cables standalone (min v0.11.1 or self build)
- add folder of this repository as an op dir
- you should be able to use McpServer op now, add it to your patch
- the op output `Started` shows if the server is running, `Log` shows the latest request
- the op title shows how often it was called (e.g. "called 12x"), so you can see that a client is still connected
- the op output `Stats` is an object with the number of calls per tool, the total, the last tool and when it was called, e.g. link it to `Ops.Ui.VizObject`. the counts are kept until the editor reloads
- open op code editor by pressing [e] and then you should be able to chat about this code

### add mcp server to terminal claude code

```
claude mcp add --transport http cables http://localhost:3000/mcp
```

any other mcp client that supports http transport works the same, the endpoint is `http://localhost:3000/mcp`.

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
| `get-patch-op` | one op from the patch as json: port values, uiAttribs, storage, links |
| `get-patch-errors` | ops with errors/warnings (shader errors, missing links, wrong types) and code diagnostics |
| `add-op` | add an op by its full name, optionally at a position |
| `delete-op` | delete an op and its links |
| `set-port-value` | set the value of an input port |
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
| `get-op-docs` | docs of an op: summary, description, ports, dependencies, newer versions |
| `read-op` | read op code with line numbers, or a range of lines, or only lines containing a text (also searches the op's `att_inc_*.js` includes, with file names) |
| `edit-op-text` | change op code by replacing a text, the op is saved and re-executed |
| `edit-op` | open an op in a code editor tab, so the person at the editor sees it |
| `create-op` | create a new op (only `Ops.Local.*`), optionally with code and attachments |
| `rename-op` | rename an op or move it to another namespace, its instances in the patch are replaced (standalone only) |
| `clone-op` | copy an op to a new name or a new version (e.g. `_v2`), optionally replacing it in the patch |
| `set-op-summary` | set the one line summary of an op |
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
