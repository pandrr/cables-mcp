const McpServer = op.require("@modelcontextprotocol/sdk/server/mcp.js");
const StreamableHTTPServerTransport = op.require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const http = op.require("node:http");
const { z } = op.require("zod");

const
    outStarted = op.outBoolNum("Started", false),
    outData = op.outObject("Last Request Data"),
    outLog = op.outString("Log","");

let currentServer = null;
buildMcpServer();


function urlName(name)
{
    return name.replace(/ /g, "_");
}

function findOpenTab(urlSafeName)
{
    for (let i = 0; i < gui.mainTabs.tabs.length; i++)
    {
        const tab = gui.mainTabs.tabs[i];
        if (tab.editor && urlName(tab.editor.options.name) === urlSafeName) return tab;
    }
    return null;
}

function listOpenTabResources()
{
    const resources = [];
    for (let i = 0; i < gui.mainTabs.tabs.length; i++)
    {
        const tab = gui.mainTabs.tabs[i];
        if (tab.editor)
            resources.push({
                "uri": "mcpfile:///" + urlName(tab.editor.options.name),
                "name": tab.editor.options.name,
                "title": tab.editor.options.title,
                "mimeType": "text/plain"
            });
    }
    return resources;
}

function getOpSource(opname)
{
    return new Promise((resolve, reject) =>
    {
        const opDoc = gui.opDocs.getOpDocByName(opname);
        if (!opDoc)
        {
            reject(new Error("no op found with name " + opname));
            return;
        }

        CABLESUILOADER.talkerAPI.send("getOpCode", { "opname": opDoc.id, "projectId": gui.patchId }, (err, rslt) =>
        {
            if (err) reject(new Error(err));
            else resolve(rslt.code);
        });
    });
}

// the documentation of an op as a plain object, null if there is none
function getOpDocData(objName)
{
    const opDoc = gui.opDocs.getOpDocByName(objName);
    if (!opDoc) return null;

    return {
        "name": opDoc.name,
        "id": opDoc.id,
        "summary": opDoc.summary,
        "content": opDoc.content,
        "description": opDoc.description,
        "version": opDoc.version,
        "oldVersion": opDoc.oldVersion,
        "hidden": opDoc.hidden,
        "authorName": opDoc.authorName,
        "exampleProjectId": opDoc.exampleProjectId,
        "libs": opDoc.libs,
        "coreLibs": opDoc.coreLibs,
        "dependencies": opDoc.dependencies,
        "ports": opDoc.docs ? opDoc.docs.ports : undefined,
        "layout": opDoc.layout
    };
}

// resolves any uri this server hands out (mcpfile:///, cables://op/, cables://opdoc/ or cables://patch.json) to { mimeType, text }
async function readResourceContent(uri)
{
    if (uri.startsWith("mcpfile:///"))
    {
        const tab = findOpenTab(uri.replace("mcpfile:///", ""));
        if (!tab) throw new Error("no opened file matches uri " + uri);
        return { "mimeType": "text/plain", "text": tab.editor.getContent() };
    }
    if (uri.startsWith("cables://op/"))
    {
        const code = await getOpSource(uri.replace("cables://op/", ""));
        return { "mimeType": "application/javascript", "text": code };
    }
    if (uri.startsWith("cables://opdoc/"))
    {
        const objName = uri.replace("cables://opdoc/", "");
        const doc = getOpDocData(objName);
        if (!doc) throw new Error("no op docs found for " + objName);
        return { "mimeType": "application/json", "text": JSON.stringify(doc, null, 1) };
    }
    if (uri === "cables://patch.json") return { "mimeType": "application/json", "text": JSON.stringify(op.patch.serialize()) };
    throw new Error("unsupported uri " + uri);
}

outLog.changeAlways = true;

function logMcp(_log)
{
    const time = new Date().toTimeString().substring(0, 8);
    outLog.set(time + " " + _log);
}

// the log port starts with this line instead of "", relinking after an op reload copies the current value to the logger
logMcp("mcp server loading");

// readable name of an op for the log, e.g. "Rectangle" instead of its id
function opLabel(opId)
{
    const o = CABLES.patch.getOpById(opId);
    return o ? o.getTitle() : "unknown op " + opId;
}

// every tool/resource result goes through here, so the op's "Last Request Data" output shows it
function respond(data)
{
    outData.setRef({ "data": data });
    return data;
}

function respondText(text)
{
    return respond({ "content": [{ "type": "text", "text": text }] });
}

function respondError(text)
{
    return respond({ "content": [{ "type": "text", "text": text }], "isError": true });
}

function uriLabel(uri)
{
    return String(uri).replace("mcpfile:///", "").replace("cables://opdoc/", "").replace("cables://op/", "");
}

// sets a port value the same way the param panel does: undoable, synced and marked unsaved
function setPortValueUndoable(opId, portName, value)
{
    const apply = (v) =>
    {
        const o = CABLES.patch.getOpById(opId);
        if (!o) return;
        const p = o.getPort(portName);
        if (!p) return;
        p.set(v);
        gui.emitEvent("portValueEdited", o, p, v);
        gui.savedState.setUnSaved("mcpSetPortValue", o.getSubPatch());
        if (gui.patchView.isCurrentOp(o)) o.refreshParams();
    };

    const oldValue = CABLES.patch.getOpById(opId).getPort(portName).get();
    apply(value);

    if (oldValue !== value)
        CABLES.UI.undo.add({
            "title": "Value change " + portName,
            "context": { "portname": portName },
            "undo": () => { apply(oldValue); },
            "redo": () => { apply(value); }
        });
}

// adds an op via the patch view (loads op dependencies, current subpatch) and registers undo/redo
function addOpUndoable(objName, uiAttribs)
{
    return new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(() => { reject(new Error("timed out, no such op?")); }, 10000);

        gui.patchView.addOp(objName, {
            "uiAttribs": uiAttribs,
            "onOpAdd": (newOp) =>
            {
                clearTimeout(timeout);
                const opId = newOp.id;
                const attribs = JSON.parse(JSON.stringify(newOp.uiAttribs));

                CABLES.UI.undo.add({
                    "title": "Add op " + objName,
                    "undo": () => { CABLES.patch.deleteOp(opId); },
                    "redo": () => { CABLES.patch.addOp(objName, attribs, opId); }
                });

                resolve(newOp);
            }
        });
    });
}

// returns the current content of the rendering canvas as base64 png (without data: prefix),
// optionally downscaled to maxWidth to keep the image small
function captureCanvas(maxWidth)
{
    const canvas = CABLES.patch.cgl.canvas;
    if (!canvas) throw new Error("no rendering canvas found at CABLES.patch.cgl.canvas");

    let source = canvas;
    if (maxWidth && canvas.width > maxWidth)
    {
        source = document.createElement("canvas");
        source.width = Math.round(maxWidth);
        source.height = Math.max(1, Math.round(canvas.height * maxWidth / canvas.width));
        source.getContext("2d").drawImage(canvas, 0, 0, source.width, source.height);
    }

    return source.toDataURL("image/png").split(",")[1];
}

// waits for the end of the next rendered frame so the canvas holds a complete image;
// falls back to capturing right away if no frame arrives (e.g. patch is paused)
function grabScreenshot(maxWidth)
{
    return new Promise((resolve, reject) =>
    {
        const cgl = CABLES.patch.cgl;
        let done = false;
        let listener = null;
        let timeout = null;

        const finish = () =>
        {
            if (done) return;
            done = true;
            clearTimeout(timeout);

            // capture synchronously, still inside the frame; removing the listener while
            // emitEvent is iterating could skip other listeners, so do that afterwards
            try { resolve(captureCanvas(maxWidth)); }
            catch (e) { reject(e); }

            if (listener) setTimeout(() => { cgl.off(listener); }, 0);
        };

        listener = cgl.on("endframe", finish);
        timeout = setTimeout(finish, 1000);
    });
}

// saves the current patch to disk/server, the same way the editor's own save
// (ctrl+s / save button) does. force=true skips the guest/unsaved-changes
// warning dialogs, since there is no user around to click through them.
function savePatch()
{
    return new Promise((resolve) =>
    {
        gui.patchView.store.saveCurrentProject(() =>
        {
            resolve();
        }, true);
    });
}

// collects ui errors (op.uiAttribs.uierrors, set via setUiError in core_extend_op.js) of all ops,
// plus editor diagnostics of ports (e.g. shader compile errors with line numbers).
// level: 0 hint, 1 warning, 2 error
function getPatchErrors(minLevel, opId)
{
    const result = [];
    const ops = CABLES.patch.ops;

    for (let i = 0; i < ops.length; i++)
    {
        const o = ops[i];
        if (opId && o.id != opId) continue;

        const errors = [];
        const uiErrors = o.uiAttribs.uierrors || [];
        for (let j = 0; j < uiErrors.length; j++)
            if (uiErrors[j].level >= minLevel)
                errors.push({ "id": uiErrors[j].id, "level": uiErrors[j].level, "txt": uiErrors[j].txt });

        // diagnostics can be stale after an error was fixed, only trust them while the op still has an error
        const diagnostics = [];
        const ports = uiErrors.length ? o.portsIn.concat(o.portsOut) : [];
        for (let j = 0; j < ports.length; j++)
        {
            const diags = ports[j].uiAttribs.editorDiagnostics;
            if (!diags || !diags.length) continue;

            // diagnostics line numbers refer to the port's value (e.g. the final generated shader code)
            const codeLines = typeof ports[j].get() == "string" ? ports[j].get().split("\n") : [];
            for (let k = 0; k < diags.length; k++)
            {
                const d = { "port": ports[j].name, "line": diags[k].line, "message": diags[k].message };
                if (diags[k].line > 0 && codeLines[diags[k].line - 1] !== undefined) d.code = codeLines[diags[k].line - 1].trim();
                diagnostics.push(d);
            }
        }

        if (!errors.length && !diagnostics.length) continue;

        const entry = { "opId": o.id, "objName": o.objName, "title": o.getTitle(), "errors": errors };
        if (o.uiAttribs.subPatch && o.uiAttribs.subPatch != "0") entry.subPatch = o.uiAttribs.subPatch;
        if (diagnostics.length) entry.diagnostics = diagnostics;
        result.push(entry);
    }
    return result;
}

const s = new CABLES.UI.OpSearch();
s.buildList();

gui.mainTabs.on("onTabRemoved", () => { if (currentServer && currentServer.isConnected()) currentServer.sendResourceListChanged(); });
gui.mainTabs.on("onTabAdded", () => { if (currentServer && currentServer.isConnected()) currentServer.sendResourceListChanged(); });

function buildMcpServer()
{
    const server = new McpServer.McpServer({ "name": "cables standalone mcp server", "version": "1.0.0" });
    currentServer = server;

    // real MCP resources, for clients that browse/read via resources/list + resources/read
    server.registerResource(
        "open-tab",
        new McpServer.ResourceTemplate("mcpfile:///{name}", { "list": () => ({ "resources": listOpenTabResources() }) }),
        { "description": "a file currently opened in the cables code editor" },
        async (uri) =>
        {
            logMcp("read file " + uriLabel(uri.href));
            const content = await readResourceContent(uri.href);
            return respond({ "contents": [{ "uri": uri.href, ...content }] });
        }
    );

    server.registerResource(
        "patch json",
        new McpServer.ResourceTemplate("cables://patch.json", { "list": undefined }),
        { "description": "read-only structure and data of the current patch" },
        async (uri) =>
        {
            logMcp("read patch.json");
            const content = op.patch.serialize();
            return respond({ "contents": [{ "uri": uri.href, ...content }] });
        }
    );

    server.registerResource(
        "op-source",
        new McpServer.ResourceTemplate("cables://op/{opname}", { "list": undefined }),
        { "description": "read-only source code of a cables op; get op names from search-ops" },
        async (uri) =>
        {
            logMcp("read op source " + uriLabel(uri.href));
            const content = await readResourceContent(uri.href);
            return respond({ "contents": [{ "uri": uri.href, ...content }] });
        }
    );

    server.registerResource(
        "op-docs",
        new McpServer.ResourceTemplate("cables://opdoc/{objName}", { "list": undefined }),
        { "description": "documentation of a cables op as json (summary, description, port docs, ports layout); get op names from search-ops or list-op-docs" },
        async (uri) =>
        {
            logMcp("read op docs " + uriLabel(uri.href));
            const content = await readResourceContent(uri.href);
            return respond({ "contents": [{ "uri": uri.href, ...content }] });
        }
    );

    // thin tool wrappers around the same resources, so agentic tool-only MCP clients
    // (e.g. Claude Code, which does not always auto-expose resources/list+read as tools)
    // can still browse and read them without relying on client-side resource support
    server.tool(
        "list-resources",
        "list readable resources: files currently opened in the cables editor",
        { },
        () =>
        {
            logMcp("list open files");
            return respond({ "content": listOpenTabResources().map((r) => ({ "type": "resource_link", ...r })) });
        }
    );

    server.tool(
        "read-resource",
        "read a resource by uri (mcpfile:///<name>, cables://op/<opname>, cables://opdoc/<opname>, or cables://patch.json)",
        { "uri": z.string() },
        async ({ uri }) =>
        {
            logMcp("read " + uriLabel(uri));
            const content = await readResourceContent(uri);
            return respondText(content.text);
        }
    );

    server.tool(
        "edit-op",
        "open an op to edit and change it",
        { "opname": z.string() },
        (opts) =>
        {
            logMcp("edit op " + opts.opname);
            gui.serverOps.edit(opts.opname, false, null, true);
            return respond({ "content": [] });
        }
    );

    server.tool(
        "search-ops",
        "search through a list of all available ops; read cables://op/<name> to see an op's source",
        { "str": z.string() },
        (str) =>
        {
            logMcp("search ops \"" + str.str + "\"");
            s.search(str.str);
            const data = { "content": [] };
            for (let i = 0; i < s.list.length; i++)
            {
                if (s.list[i].score > 0)
                {
                    data.content.push({
                        "type": "resource_link",
                        "uri": "cables://op/" + s.list[i].name,
                        "name": s.list[i].name,
                        "description": s.list[i].summary
                    });
                }
            }

            return respond(data);
        }
    );

    server.tool(
        "write-opened-resources",
        "change/write content of an opened file",
        { "uri": z.string(), "text": z.string() },
        ({ uri, text }) =>
        {
            logMcp("write file " + uriLabel(uri));
            const tab = findOpenTab(uri.replace("mcpfile:///", ""));
            if (tab)
            {
                tab.editor.setContent(text);
                tab.editor.save();
            }

            return respondText(tab ? "content updated" : "no opened file matches uri " + uri);
        }
    );

    server.tool(
        "set-port-value",
        "set the value of a port on an op in the current patch; identify the op by its id and the port by its name (see get-patch / cables://patch.json for op ids and port names)",
        { "opId": z.string(), "portName": z.string(), "value": z.any() },
        ({ opId, portName, value }) =>
        {
            logMcp("set " + opLabel(opId) + "." + portName + " = " + String(JSON.stringify(value)).substring(0, 60));

            const targetOp = op.patch.getOpById(opId);
            if (!targetOp) return respondText("no op found with id " + opId);

            const port = targetOp.getPort(portName);
            if (!port) return respondText("no port named \"" + portName + "\" on op " + opId);

            setPortValueUndoable(opId, portName, value);

            return respondText("set " + opId + "." + portName + " = " + JSON.stringify(value));
        }
    );

    server.tool(
        "trigger-port",
        "trigger/execute a trigger-type port on an op directly, without needing anything connected to it; identify the op by its id and the port by its name (see cables://patch.json for op ids and port names). fails if the port is not a trigger port.",
        { "opId": z.string(), "portName": z.string() },
        ({ opId, portName }) =>
        {
            logMcp("trigger " + opLabel(opId) + "." + portName);

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp) return respondError("no op found with id " + opId);

            const port = targetOp.getPort(portName);
            if (!port) return respondError("no port named \"" + portName + "\" on op " + opId);

            if (port.getType() !== CABLES.Port.TYPE_TRIGGER) return respondError("port \"" + portName + "\" on op " + opId + " is not a trigger port");

            // .trigger() only forwards along the port's own links, which is a no-op for a
            // port that has nothing wired to it. _onTriggered() is what the cables editor's
            // own UI calls when clicking a trigger button (params_listener.js) - it fires the
            // op's onTriggered handler directly, regardless of whether anything is linked.
            port._onTriggered();


            return respondText("triggered " + opId + "." + portName);
        }
    );

    server.tool(
        "link-ports",
        "connect (link) an output port of one op to an input port of another op in the current patch; identify ops by id and ports by name (see cables://patch.json for op ids and port names)",
        { "opId1": z.string(), "portName1": z.string(), "opId2": z.string(), "portName2": z.string() },
        ({ opId1, portName1, opId2, portName2 }) =>
        {
            logMcp("link " + opLabel(opId1) + "." + portName1 + " -> " + opLabel(opId2) + "." + portName2);

            const op1 = CABLES.patch.getOpById(opId1);
            if (!op1) return respondError("no op found with id " + opId1);

            const op2 = CABLES.patch.getOpById(opId2);
            if (!op2) return respondError("no op found with id " + opId2);

            if (!op1.getPort(portName1)) return respondError("no port named \"" + portName1 + "\" on op " + opId1);

            if (!op2.getPort(portName2)) return respondError("no port named \"" + portName2 + "\" on op " + opId2);

            const link = CABLES.patch.link(op1, portName1, op2, portName2);

            if (!link) return respondError("could not link " + opId1 + "." + portName1 + " -> " + opId2 + "." + portName2 + " (incompatible ports?)");
            return respondText("linked " + opId1 + "." + portName1 + " -> " + opId2 + "." + portName2);
        }
    );

    server.tool(
        "unlink-ports",
        "remove an existing link between two ports (the inverse of link-ports); identify ops by id and ports by name. fails if no such link exists.",
        { "opId1": z.string(), "portName1": z.string(), "opId2": z.string(), "portName2": z.string() },
        ({ opId1, portName1, opId2, portName2 }) =>
        {
            logMcp("unlink " + opLabel(opId1) + "." + portName1 + " -> " + opLabel(opId2) + "." + portName2);

            const op1 = CABLES.patch.getOpById(opId1);
            const op2 = CABLES.patch.getOpById(opId2);
            if (!op1 || !op2) return respondError("no op found with id " + (!op1 ? opId1 : opId2));

            const port1 = op1.getPort(portName1);
            const port2 = op2.getPort(portName2);
            if (!port1 || !port2) return respondError("no port named \"" + (!port1 ? portName1 : portName2) + "\" on op " + (!port1 ? opId1 : opId2));

            const existing = port1.links.find((l) => l.getOtherPort(port1) === port2);
            if (!existing) return respondError("no link found between " + opId1 + "." + portName1 + " and " + opId2 + "." + portName2);

            existing.remove();

            return respondText("unlinked " + opId1 + "." + portName1 + " -> " + opId2 + "." + portName2);
        }
    );

    server.tool(
        "move-op",
        "reposition an existing op in the patch editor view (does not affect rendering, purely cosmetic layout); identify the op by its id and give its new x/y editor coordinates",
        { "opId": z.string(), "x": z.number(), "y": z.number() },
        ({ opId, x, y }) =>
        {
            logMcp("move " + opLabel(opId) + " to " + x + "," + y);

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp) return respondError("no op found with id " + opId);

            const old = targetOp.uiAttribs.translate || { "x": 0, "y": 0 };
            const oldX = old.x, oldY = old.y;
            const moveTo = (px, py) => { gui.patchView.patchRenderer.patchAPI.setOpUiAttribs(opId, "translate", { "x": px, "y": py }); };

            moveTo(x, y);
            CABLES.UI.undo.add({
                "title": "Move op",
                "undo": () => { moveTo(oldX, oldY); },
                "redo": () => { moveTo(x, y); }
            });

            return respondText("moved " + opId + " to " + x + "," + y);
        }
    );

    server.tool(
        "focus-op",
        "scroll/zoom the patch editor view to center on an op and open its param panel, so the person looking at the editor can see it. does not affect rendering.",
        { "opId": z.string() },
        ({ opId }) =>
        {
            logMcp("focus " + opLabel(opId));

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp) return respondError("no op found with id " + opId);

            if (!CABLES.UI || !gui.patchView || !gui.patchView.patchRenderer || !gui.patchView.patchRenderer.focusOp) return respondError("no patch editor UI available to focus on");

            gui.patchView.patchRenderer.focusOp(opId);

            return respondText("focused " + opId + " (" + targetOp.objName + ") in the patch editor");
        }
    );

    server.tool(
        "add-op",
        "add a new op to the current patch by its full op name (objName), e.g. Ops.Anim.Timer_v2; get valid names from search-ops. returns the new op's id (use it with link-ports / set-port-value) and its port names. optional x/y place it in the patch editor view.",
        { "objName": z.string(), "x": z.number().optional(), "y": z.number().optional() },
        async ({ objName, x, y }) =>
        {
            logMcp("add op " + objName);

            const uiAttribs = {};
            if (x !== undefined || y !== undefined) uiAttribs.translate = { "x": x || 0, "y": y || 0 };

            let newOp;
            try
            {
                newOp = await addOpUndoable(objName, uiAttribs);
            }
            catch (e)
            {
                return respondError("could not add op \"" + objName + "\": " + e.message);
            }

            if (!newOp) return respondError("could not add op \"" + objName + "\" (no such op? see search-ops)");

            const portsIn = newOp.portsIn.map((p) => p.name);
            const portsOut = newOp.portsOut.map((p) => p.name);

            return respondText("added " + objName + " with id " + newOp.id + "; portsIn: [" + portsIn.join(", ") + "]; portsOut: [" + portsOut.join(", ") + "]");
        }
    );

    server.tool(
        "delete-op",
        "delete an op from the current patch by its id (see cables://patch.json for op ids); this also removes any links connected to it",
        { "opId": z.string() },
        ({ opId }) =>
        {
            logMcp("delete " + opLabel(opId));

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp) return respondError("no op found with id " + opId);

            const objName = targetOp.objName;

            CABLES.patch.deleteOp(opId);
            const stillThere = !!CABLES.patch.getOpById(opId);

            if (stillThere) return respondError("could not delete op " + opId);
            return respondText("deleted " + objName + " (" + opId + ")");
        }
    );

    server.tool(
        "get-patch-errors",
        "check the current patch for errors: lists ops that show ui errors/warnings (e.g. shader compile errors, missing links, wrong input types) with their messages, plus code diagnostics (line, message, code) where available. minLevel filters by severity: 0 hint, 1 warning, 2 error (default 1). optional opId checks a single op. use it after changing shader code or port values.",
        { "minLevel": z.number().optional(), "opId": z.string().optional() },
        ({ minLevel, opId }) =>
        {
            logMcp("check patch errors" + (opId ? " of " + opLabel(opId) : ""));

            if (opId && !CABLES.patch.getOpById(opId)) return respondError("no op found with id " + opId);

            const errors = getPatchErrors(minLevel === undefined ? 1 : minLevel, opId);
            return respondText(errors.length ? JSON.stringify(errors, null, 1) : "no errors found");
        }
    );

    server.tool(
        "save-patch",
        "save the current patch to disk/server, the same as the editor's own save action (ctrl+s). skips confirmation dialogs since there is no user to click through them.",
        { },
        async () =>
        {
            logMcp("save patch");

            try
            {
                await savePatch();
                return respondText("patch saved");
            }
            catch (e)
            {
                return respondError("save failed: " + e.message);
            }
        }
    );

    server.tool(
        "screenshot",
        "take a screenshot of the patch's rendering canvas and return it as a png image; use it to check what a change looks like.",
        { "maxWidth": z.number().optional() },
        async ({ maxWidth }) =>
        {
            logMcp("screenshot");

            try
            {
                const png = await grabScreenshot(maxWidth || 1024);
                return respond({ "content": [{ "type": "image", "data": png, "mimeType": "image/png" }] });
            }
            catch (e)
            {
                return respondError("screenshot failed: " + e.message);
            }
        }
    );

    server.tool(
        "list-commands",
        "list the cables editor commands (the same as in the command palette), with category and description. optional str filters by name/category/description. run them with run-command.",
        { "str": z.string().optional() },
        ({ str }) =>
        {
            logMcp("list commands" + (str ? " \"" + str + "\"" : ""));

            const filter = (str || "").toLowerCase();
            const cmds = CABLES.CMD.commands
                .filter((c) => c && c.func)
                .filter((c) => !filter || ((c.cmd || "") + " " + (c.category || "") + " " + (c.infotext || "")).toLowerCase().indexOf(filter) > -1)
                .map((c) => ({ "name": c.cmd, "category": c.category, "description": c.infotext }));

            return respondText(cmds.length ? JSON.stringify(cmds, null, 1) : "no commands found");
        }
    );

    server.tool(
        "run-command",
        "run a cables editor command by its name, exactly as listed by list-commands (the same as selecting it in the command palette). many commands act on the currently selected ops.",
        { "name": z.string() },
        async ({ name }) =>
        {
            logMcp("run command \"" + name + "\"");

            const cmd = CABLES.CMD.commands.find((c) => c && c.cmd == name);
            if (!cmd || !cmd.func) return respondError(cmd ? "command \"" + name + "\" has no function" : "no command named \"" + name + "\", use list-commands");

            try
            {
                await cmd.func();
                return respondText("executed command " + name);
            }
            catch (e)
            {
                return respondError("command failed: " + e.message);
            }
        }
    );

    server.tool(
        "set-canvas-size",
        "set the size of the rendering canvas in pixels, the same as the editor's \"change canvas size\" command",
        { "width": z.number(), "height": z.number() },
        ({ width, height }) =>
        {
            logMcp("set canvas size " + width + "x" + height);

            const w = Math.round(width);
            const h = Math.round(height);

            gui.canvasManager.setSize(w, h);
            if (gui.canvasManager.mode != gui.canvasManager.CANVASMODE_POPOUT)
            {
                gui.rendererWidth = w;
                gui.rendererHeight = h;
            }
            else gui.canvasManager.subWindow.resizeTo(w, h);
            gui.setLayout();

            return respondText("canvas size set to " + w + "x" + h);
        }
    );

    server.tool(
        "get-op-docs",
        "get the documentation of an op by its full op name (objName), e.g. Ops.Gl.Meshes.Circle_v2: summary, description, port documentation, ports layout, libs/dependencies and whether a newer version exists (oldVersion)",
        { "objName": z.string() },
        ({ objName }) =>
        {
            logMcp("op docs " + objName);

            const doc = getOpDocData(objName);
            if (!doc) return respondError("no op docs found for \"" + objName + "\", use search-ops to find op names");

            return respondText(JSON.stringify(doc, null, 1));
        }
    );

    server.tool(
        "list-op-docs",
        "list all documented ops, one per line as \"name: summary\". optional str filters by name/summary. old versions and hidden ops are left out unless includeOld / includeHidden is true. use get-op-docs for the full documentation of an op.",
        { "str": z.string().optional(), "includeOld": z.boolean().optional(), "includeHidden": z.boolean().optional() },
        ({ str, includeOld, includeHidden }) =>
        {
            logMcp("list op docs" + (str ? " \"" + str + "\"" : ""));

            const filter = (str || "").toLowerCase();
            const lines = gui.opDocs.getAll()
                .filter((d) => d && d.name)
                .filter((d) => includeOld || !d.oldVersion)
                .filter((d) => includeHidden || !d.hidden)
                .filter((d) => !filter || (d.name + " " + (d.summary || "")).toLowerCase().indexOf(filter) > -1)
                .map((d) => d.name + ": " + (d.summary || ""));

            return respondText(lines.length ? lines.length + " ops\n" + lines.join("\n") : "no ops found");
        }
    );

    return server;
}

const httpServer = http.createServer(async (req, res) =>
{
    if (req.url !== "/mcp")
    {
        res.writeHead(404).end();
        return;
    }

    const mcpServer = buildMcpServer();
    const transport = new StreamableHTTPServerTransport.StreamableHTTPServerTransport({ "sessionIdGenerator": undefined });

    res.on("close", () =>
    {
        transport.close();
        mcpServer.close();
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
});

setTimeout(() =>
{
    window.cablesMcpServerStarts = (window.cablesMcpServerStarts || 0) + 1;

    httpServer.on("error", (e) => { logMcp("mcp server error: " + e.message); });
    httpServer.listen(3000, () =>
    {
        logMcp("mcp server " + (window.cablesMcpServerStarts > 1 ? "restarted" : "started") + " on port 3000");
        console.log("MCP server listening on http://localhost:3000/mcp");
        outStarted.set(true);
    });

}, 500);

op.onDelete = () =>
{
    httpServer.close(() =>
    {
        console.log("Server closed");
    });
};
