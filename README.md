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
- the op output `Started` shows if the server is running, `Log` shows the latest requests
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
| `save-patch` | save the patch (like ctrl+s) |
| `set-patch-name` | rename the patch |
| `upload-file` | upload a file into the patch's asset folder, from a url or base64 content |

### patch editor view

| tool | |
|---|---|
| `patch-view` | report, scroll and zoom the patch field, or fit it to all/some ops |
| `patch-field-screenshot` | screenshot of the patch field (ops and links) |
| `focus-op` | center an op and open its param panel, so you can see what the ai is talking about |
| `select-op` | select ops, like clicking them |
| `move-op` | move an op in the patch field |
| `tidy-up-ops` | arrange the selected ops in rows following their links (undoable) |

### rendering

| tool | |
|---|---|
| `screenshot` | screenshot of the rendering canvas |
| `set-canvas-size` | set the size of the rendering canvas |

### op code

| tool | |
|---|---|
| `search-ops` | search all available ops by name and summary |
| `list-op-docs` | list all documented ops |
| `get-op-docs` | docs of an op: summary, description, ports, dependencies, newer versions |
| `read-op` | read op code with line numbers, or a range of lines, or only lines containing a text |
| `edit-op-text` | change op code by replacing a text, the op is saved and re-executed |
| `edit-op` | open an op in the code editor and change it |
| `create-op` | create a new op, optionally with code and attachments |
| `list-op-attachments` | list the attachment files of an op |
| `read-op-attachment` | read an attachment |
| `write-op-attachment` | write or create an attachment |
| `write-opened-resources` | write a file that is opened in the code editor |

### editor

| tool | |
|---|---|
| `list-commands` | list editor commands (the same as the command palette) |
| `run-command` | run an editor command, e.g. "Reload Editor" |
| `get-console-logs` | read the editor console, including webgl warnings (needs `--remote-debugging-port=9222`) |
| `get-jobs` | what the editor and the patch are currently loading, to find stuck loading |
| `debug-glop` | temporary debugging tool for the patch field |

### good to know

- editing an op's code re-executes it: all instances of the op are recreated and get new op ids, so get them again afterwards.
- only one op can be opened in the code editor at a time.
- the McpServer op itself can be edited through mcp, the server restarts after the change.
