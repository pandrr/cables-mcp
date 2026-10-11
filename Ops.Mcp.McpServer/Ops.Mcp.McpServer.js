const McpServer = op.require("@modelcontextprotocol/sdk/server/mcp.js");
const StreamableHTTPServerTransport = op.require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const http = op.require("node:http");
const https = op.require("node:https");
const { z } = op.require("zod");

const
    outStarted = op.outBoolNum("Started", false),
    outData = op.outObject("Last Request Data"),
    outLog = op.outString("Log", "");

const MCP_PORT = 3000;
const SCREENSHOT_DEFAULT_MAX_SIZE = 640;
const SELF_EXECUTE_DELAY_MS = 100;
const SEARCH_DEFAULT_LIMIT = 20;
const PATCHFIELD_VIEW_ANIM_MS = 500;
const KEYFRAME_TIME_TOLERANCE = 0.0005;
const LISTEN_RETRY_MS = 20;
const LISTEN_MAX_RETRIES = 1150;
const RELOAD_EDITOR_DELAY_MS = 300;

const CONSOLE_DEFAULT_LIMIT = 100;
const CONSOLE_LEVELS = ["verbose", "info", "warning", "error"];

const consoleEntries = [];
let devToolsSocket = null;

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
            resources.push(
            {
                "uri": "mcpfile:///" + urlName(tab.editor.options.name),
                "name": tab.editor.options.name,
                "title": tab.editor.options.title,
                "mimeType": "text/plain"
            });
    }
    return resources;
}

// sends a talkerAPI command and resolves with its result
function talkerSend(cmd, data)
{
    return new Promise((resolve, reject) =>
    {
        CABLESUILOADER.talkerAPI.send(cmd, data, (err, rslt) =>
        {
            if (err) reject(new Error(err.msg || JSON.stringify(err)));
            else resolve(rslt);
        });
    });
}

// downloads a url in the editor and resolves with its content as a data url
async function urlToDataUrl(url)
{
    const response = await fetch(url);
    if (!response.ok) throw new Error("download failed: " + response.status + " " + response.statusText);

    const blob = await response.blob();
    return new Promise((resolve, reject) =>
    {
        const reader = new FileReader();
        reader.onload = () => { resolve(reader.result); };
        reader.onerror = () => { reject(reader.error); };
        reader.readAsDataURL(blob);
    });
}

// rejects when a promise does not settle in time, so tools report which step hung instead of blocking
function withTimeout(promise, ms, step)
{
    return Promise.race([promise, new Promise((resolve, reject) => { setTimeout(() => { reject(new Error("timeout in step: " + step)); }, ms); })]);
}

outLog.changeAlways = true;

function logMcp(_log)
{
    outLog.set(_log);
}

// the log port starts with this line instead of "", relinking after an op reload copies the current value to the logger
logMcp("mcp server starting");

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
        CABLES.UI.undo.add(
        {
            "title": "Value change " + portName,
            "context": { "portname": portName },
            "undo": () => { apply(oldValue); },
            "redo": () => { apply(value); }
        });
}

// sets an op comment the same way the param panel's comment field does: an empty comment removes it, undoable and marked unsaved
function setOpCommentUndoable(opId, comment)
{
    const apply = (c) =>
    {
        const o = CABLES.patch.getOpById(opId);
        if (!o) return;
        o.uiAttr({ "comment": c || null });
        o.patch.emitEvent("commentChanged");
        gui.savedState.setUnSaved("mcpSetOpComment", o.getSubPatch());
        if (gui.patchView.isCurrentOp(o)) o.refreshParams();
    };

    const oldComment = CABLES.patch.getOpById(opId).uiAttribs.comment || "";
    apply(comment);

    if (oldComment !== comment)
        CABLES.UI.undo.add(
        {
            "title": "Op comment",
            "undo": () => { apply(oldComment); },
            "redo": () => { apply(comment); }
        });
}

// adds an op via the patch view (loads op dependencies, current subpatch) and registers undo/redo
function addOpUndoable(objName, uiAttribs)
{
    return new Promise((resolve, reject) =>
    {
        const timeout = setTimeout(() => { reject(new Error("timed out, no such op?")); }, 10000);

        gui.patchView.addOp(objName,
        {
            "uiAttribs": uiAttribs,
            "onOpAdd": (newOp) =>
            {
                clearTimeout(timeout);
                const opId = newOp.id;
                const attribs = JSON.parse(JSON.stringify(newOp.uiAttribs));

                CABLES.UI.undo.add(
                {
                    "title": "Add op " + objName,
                    "undo": () => { CABLES.patch.deleteOp(opId); },
                    "redo": () => { CABLES.patch.addOp(objName, attribs, opId); }
                });

                resolve(newOp);
            }
        });
    });
}

// resolves after the next frame has been rendered completely, e.g. so a shader recompile
// triggered by an op reload has happened; falls back after a timeout if no frame is rendered (e.g. patch is paused)
function waitForRenderedFrame()
{
    return new Promise((resolve) =>
    {
        const cgl = CABLES.patch.cgl;
        let done = false;
        let listener = null;

        const finish = () =>
        {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            if (listener) setTimeout(() => { cgl.off(listener); }, 0);
            resolve();
        };

        const timeout = setTimeout(finish, 1000);

        // next frame once callbacks run at the start of a frame, before rendering, so wait for the end of that frame
        cgl.addNextFrameOnceCallback(() =>
        {
            if (!done) listener = cgl.on("endFrame", finish);
        });
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

// renames the patch like the editor's patch title dialog (store.setPatchName), but returns errors instead of showing a modal
async function setPatchName(name)
{
    const res = await talkerSend("setProjectName", { "id": gui.project()._id, "name": name });
    const newName = res && res.data && res.data.name;
    if (!newName) throw new Error("server returned no name");

    gui.setProjectName(newName);
    gui.patchParamPanel.show(true);
    return newName;
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
        new McpServer.ResourceTemplate("mcpfile:///{name}", { "list": () => ({ "resources": listOpenTabResources() }) }), { "description": "a file currently opened in the cables code editor" },
        async (uri) =>
        {
            logMcp("read file " + uriLabel(uri.href));
            const content = await readResourceContent(uri.href);
            return respond({ "contents": [{ "uri": uri.href, ...content }] });
        }
    );

    server.registerResource(
        "patch json",
        new McpServer.ResourceTemplate("cables://patch.json", { "list": undefined }), { "description": "read-only structure and data of the current patch" },
        async (uri) =>
        {
            logMcp("read patch.json");
            const content = op.patch.serialize();
            return respond({ "contents": [{ "uri": uri.href, ...content }] });
        }
    );

    server.registerResource(
        "op-source",
        new McpServer.ResourceTemplate("cables://op/{opname}", { "list": undefined }), { "description": "read-only source code of a cables op; get op names from search-ops" },
        async (uri) =>
        {
            logMcp("read op source " + uriLabel(uri.href));
            const content = await readResourceContent(uri.href);
            return respond({ "contents": [{ "uri": uri.href, ...content }] });
        }
    );

    server.registerResource(
        "op-docs",
        new McpServer.ResourceTemplate("cables://opdoc/{objName}", { "list": undefined }), { "description": "documentation of a cables op as json (summary, description, port docs, ports layout); get op names from search-ops or list-op-docs" },
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
        "list readable resources: files currently opened in the cables editor", {},
        () =>
        {
            logMcp("list open files");
            return respond({ "content": listOpenTabResources().map((r) => ({ "type": "resource_link", ...r })) });
        }
    );

    server.tool(
        "read-resource",
        "read a resource by uri (mcpfile:///<name>, cables://op/<opname>, cables://opdoc/<opname>, or cables://patch.json)", { "uri": z.string() },
        async ({ uri }) =>
        {
            logMcp("read " + uriLabel(uri));
            const content = await readResourceContent(uri);
            return respondText(content.text);
        }
    );

    server.tool(
        "read-op",
        "read the code of an op (or one of its attachments, att_ prefix optional) with line numbers, much cheaper than reading the whole file: fromLine/toLine limit it to a range of lines, find only lists the lines containing that text. use edit-op-text to change it.", { "opname": z.string(), "attachment": z.string().optional(), "fromLine": z.number().optional(), "toLine": z.number().optional(), "find": z.string().optional() },
        async ({ opname, attachment, fromLine, toLine, find }) =>
        {
            logMcp("read op " + opname + (attachment ? "/" + attachmentFileName(attachment) : ""));

            try
            {
                const lines = (await readOpText(opname, attachment)).split("\n");

                if (find)
                {
                    const found = lines.map((line, i) => (line.includes(find) ? (i + 1) + "\t" + line : null)).filter((line) => line !== null);
                    return respondText(found.length ? found.join("\n") : "\"" + find + "\" not found");
                }

                const first = Math.max(1, fromLine || 1);
                const last = Math.min(lines.length, toLine || lines.length);
                return respondText(lines.length + " lines\n" + numberedLines(lines.slice(first - 1, last), first));
            }
            catch (e)
            {
                return respondError("could not read op: " + e.message);
            }
        }
    );

    server.tool(
        "edit-op-text",
        "change the code of an op (or one of its attachments, att_ prefix optional) by replacing oldText with newText, without sending the whole file. oldText has to match exactly once (copy it from read-op without the line numbers, include enough surrounding lines to make it unique), or pass replaceAll=true to replace every occurrence. the op is saved and re-executed afterwards.", { "opname": z.string(), "attachment": z.string().optional(), "oldText": z.string(), "newText": z.string(), "replaceAll": z.boolean().optional() },
        async ({ opname, attachment, oldText, newText, replaceAll }) =>
        {
            logMcp("edit op " + opname + (attachment ? "/" + attachmentFileName(attachment) : ""));

            try
            {
                const text = await readOpText(opname, attachment);
                const count = countOccurrences(text, oldText);

                if (!oldText || count == 0) return respondError("oldText not found, nothing changed");
                if (count > 1 && !replaceAll) return respondError("oldText found " + count + " times, add surrounding lines to make it unique or pass replaceAll=true; nothing changed");

                await writeOpText(opname, attachment, text.split(oldText).join(newText));
                return respondText("replaced " + count + " occurrence" + (count > 1 ? "s" : "") + ", op saved and executed");
            }
            catch (e)
            {
                return respondError("could not edit op: " + e.message);
            }
        }
    );

    server.tool(
        "edit-op",
        "open an op to edit and change it", { "opname": z.string() },
        (opts) =>
        {
            logMcp("edit op " + opts.opname);
            gui.serverOps.edit(opts.opname, false, null, true);
            return respond({ "content": [] });
        }
    );

    server.tool(
        "search-ops",
        "search through all available ops, best matches first, one per line as \"name: summary\". limit is the number of results (default " + SEARCH_DEFAULT_LIMIT + ", 0 = all). use get-op-docs for ports and docs, read-op for the source.", { "str": z.string(), "limit": z.number().optional() },
        ({ str, limit }) =>
        {
            logMcp("search ops \"" + str + "\"");

            // the search only matches lowercase terms
            s.search(str.toLowerCase());
            const found = s.list.filter((o) => o.score > 0).sort((a, b) => b.score - a.score);
            const maxResults = limit ?? SEARCH_DEFAULT_LIMIT;
            const lines = (maxResults ? found.slice(0, maxResults) : found).map((o) => o.name + ": " + (o.summary || ""));

            if (!lines.length) return respondText("no ops found");
            return respondText(lines.join("\n") + (lines.length < found.length ? "\n(" + lines.length + " of " + found.length + " results)" : ""));
        }
    );

    server.tool(
        "write-opened-resources",
        "change/write content of an opened file", { "uri": z.string(), "text": z.string() },
        ({ uri, text }) =>
        {
            logMcp("write file " + uriLabel(uri));
            const tab = findOpenTab(uri.replace("mcpfile:///", ""));
            if (tab)
            {
                tab.editor.setContent(text);
                tab.editor.save();
                logMcp("saved " + uriLabel(uri));
            }

            return respondText(tab ? "content updated" : "no opened file matches uri " + uri);
        }
    );

    server.tool(
        "create-op",
        "create a new op by its full name (e.g. Ops.Extension.ShaderGraph.Sdf.Sphere, the name decides where it is stored), optionally with its code and attachments as { \"att_name\": content } (att_ prefix optional). add it to the patch with add-op afterwards.", { "opname": z.string(), "code": z.string().optional(), "attachments": z.record(z.string()).optional() },
        async ({ opname, code, attachments }) =>
        {
            logMcp("create op " + opname);

            if (gui.opDocs.getOpDocByName(opname)) return respondError("op " + opname + " already exists, use edit-op / write-op-attachment");

            try
            {
                await createOp(opname, code, attachments);
                return respondText("created op " + opname);
            }
            catch (e)
            {
                return respondError("could not create op: " + e.message);
            }
        }
    );

    server.tool(
        "list-op-attachments",
        "list the attachment files of an op (e.g. att_inc_node.js, att_shader.vert), by full op name. read them with read-op-attachment, change them with write-op-attachment.", { "opname": z.string() },
        ({ opname }) =>
        {
            logMcp("list attachments " + opname);

            const opDoc = gui.opDocs.getOpDocByName(opname);
            if (!opDoc) return respondError("no op found with name " + opname);

            const files = opDoc.attachmentFiles || [];
            return respondText(files.length ? files.join("\n") : "op " + opname + " has no attachments");
        }
    );

    server.tool(
        "read-op-attachment",
        "read the content of an op attachment file by full op name and attachment name (e.g. att_inc_node.js, the att_ prefix is optional); see list-op-attachments", { "opname": z.string(), "name": z.string() },
        async ({ opname, name }) =>
        {
            logMcp("read attachment " + opname + "/" + attachmentFileName(name));

            try
            {
                return respondText(await readOpAttachment(opname, name));
            }
            catch (e)
            {
                return respondError("could not read attachment: " + e.message);
            }
        }
    );

    server.tool(
        "write-op-attachment",
        "write the full content of an op attachment file (the att_ prefix is optional), creating it if the op does not have it yet. att_inc_*.js files are included into the op code, other attachments are available in the op as attachments.<name> (dots replaced by _). by default the op is re-executed afterwards so all instances in the patch use the new code; pass execute=false when writing several attachments and only execute on the last one.", { "opname": z.string(), "name": z.string(), "content": z.string(), "execute": z.boolean().optional() },
        async ({ opname, name, content, execute }) =>
        {
            logMcp("write attachment " + opname + "/" + attachmentFileName(name));

            try
            {
                const created = await writeOpAttachment(opname, name, content);
                if (execute !== false) await executeOp(opname);

                return respondText((created ? "created " : "saved ") + attachmentFileName(name) + (execute !== false ? ", op re-executed" : ""));
            }
            catch (e)
            {
                return respondError("could not write attachment: " + e.message);
            }
        }
    );

    server.tool(
        "delete-op-attachment",
        "delete an attachment file of an op by full op name and attachment name (the att_ prefix is optional), see list-op-attachments. by default the op is re-executed afterwards so all instances in the patch use the code without it; pass execute=false when deleting several attachments and only execute on the last one.", { "opname": z.string(), "name": z.string(), "execute": z.boolean().optional() },
        async ({ opname, name, execute }) =>
        {
            const fileName = attachmentFileName(name);
            logMcp("delete attachment " + opname + "/" + fileName);

            try
            {
                const opDoc = getOpDocOrThrow(opname);
                if (opDoc.attachmentFiles && !opDoc.attachmentFiles.includes(fileName)) return respondError(opname + " has no attachment " + fileName + ", see list-op-attachments");

                await withTimeout(talkerSend("opAttachmentDelete", { "opname": opDoc.id, "name": fileName }), 10000, "opAttachmentDelete");
                if (opDoc.attachmentFiles) opDoc.attachmentFiles.splice(opDoc.attachmentFiles.indexOf(fileName), 1);
                gui.emitEvent("refreshManageOp", opDoc.name);
                if (execute !== false) await executeOp(opname);

                return respondText("deleted " + fileName + (execute !== false ? ", op re-executed" : ""));
            }
            catch (e)
            {
                return respondError("could not delete attachment: " + e.message);
            }
        }
    );

    server.tool(
        "upload-file",
        "upload a file into the patch's asset folder, either downloaded by the editor from a url (the server must allow cors) or from base64 content. returns the path to use in file ports, e.g. the File port of Ops.Gl.Texture_v3.", { "filename": z.string(), "url": z.string().optional(), "base64": z.string().optional() },
        async ({ filename, url, base64 }) =>
        {
            logMcp("upload file " + filename);

            if (!url && !base64) return respondError("pass either url or base64");

            try
            {
                let fileStr = "data:application/octet-stream;base64," + base64;
                if (url) fileStr = await urlToDataUrl(url);

                const result = await talkerSend("fileUploadStr", { "fileStr": fileStr, "filename": filename });
                const savedName = (result && result.filename) || filename;

                return respondText("uploaded " + savedName + ", use it in file ports as ./" + savedName);
            }
            catch (e)
            {
                return respondError("could not upload file: " + e.message);
            }
        }
    );

    const loadPatchParams = { "clear": z.boolean().optional(), "x": z.number().optional(), "y": z.number().optional(), "server": z.string().optional(), "assetServer": z.string().optional() };
    const loadPatchDescription = "file ports pointing at /assets/... (project and library files) are rewritten to load from https://devsandbox.cables.gl/assets/... (assetServer changes that url). clear=true deletes all ops first, except the mcp server op and the ops linked to it. x/y place the ops, by default right of the existing ops. undoable. ops that are not available locally (e.g. user or patch ops) are left out and reported.";

    server.tool(
        "load-patch-json",
        "download a public patch from the live cables server and add its ops to the current subpatch, like pasting them. project is the patch id, short id or url (https://cables.gl/p/<id>). " + loadPatchDescription, { "project": z.string(), ...loadPatchParams },
        async (params) =>
        {
            const patchId = parsePatchId(params.project);
            logMcp("load patch json " + patchId);
            return loadPatchJson(patchId, params, "");
        }
    );

    server.tool(
        "load-example-patch",
        "load the example patch of an op by its full op name (e.g. Ops.Gl.Texture_v3) from the live cables server and add its ops to the current subpatch, like pasting them. if the op has no example patch, the example of its newest older version that has one is used. " + loadPatchDescription, { "opname": z.string(), ...loadPatchParams },
        async (params) =>
        {
            logMcp("example " + params.opname);

            const opDoc = gui.opDocs.getOpDocByName(params.opname);
            if (!opDoc) return respondError("no op found with name " + params.opname);

            const example = findExamplePatch(opDoc);
            if (!example) return respondError(params.opname + " and its older versions have no example patch");

            let note = "example patch of " + example.opName;
            if (example.opName != params.opname) note += ", " + params.opname + " has no example patch of its own";
            return loadPatchJson(example.patchId, params, note);
        }
    );

    server.tool(
        "upgrade-ops",
        "replace ops with the newest version of their op, the same as the editor's \"Upgrade selected ops\" command: port values, links and position are copied, the op gets a new id. opIds are op ids in the current patch, all=true upgrades every outdated op in the patch instead. ops that are already the newest version are skipped. reports links that are lost because the new version does not have that port.", { "opIds": z.array(z.string()).optional(), "all": z.boolean().optional() },
        async ({ opIds, all }) =>
        {
            let ids = opIds || [];
            if (all)
            {
                ids = [];
                for (let i = 0; i < CABLES.patch.ops.length; i++)
                    if (getNewestVersionName(CABLES.patch.ops[i])) ids.push(CABLES.patch.ops[i].id);
            }
            if (!ids.length) return respondText(all ? "no outdated ops in the patch" : "pass opIds or all=true");

            return respondText(await replaceOpVersions(ids, getNewestVersionName, "already the newest version", "upgrade"));
        }
    );

    server.tool(
        "downgrade-ops",
        "replace ops with the previous version of their op (e.g. Ops.Gl.Texture_v3 -> Ops.Gl.Texture_v2), the same as the editor's \"Downgrade selected op\" command: port values, links and position are copied, the op gets a new id. ops without a previous version are skipped. reports links that are lost because the old version does not have that port.", { "opIds": z.array(z.string()) },
        async ({ opIds }) =>
        {
            return respondText(await replaceOpVersions(opIds, getPreviousVersionName, "has no previous version", "downgrade"));
        }
    );

    server.tool(
        "clear-patch",
        "delete all ops of the patch (in all subpatches) except this mcp server op and the ops linked to it, e.g. its logger. returns the number of deleted ops.", {},
        () =>
        {
            logMcp("clear patch");
            return respondText("deleted " + clearPatchKeepMcp() + " ops");
        }
    );

    server.tool(
        "set-port-value",
        "set the value of a port on an op in the current patch; identify the op by its id and the port by its name (see get-patch / cables://patch.json for op ids and port names)", { "opId": z.string(), "portName": z.string(), "value": z.any() },
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
        "timeline",
        "control the timeline: play (true plays, false pauses) and time (jump to a time in seconds). viewStart/viewLength scroll/zoom the timeline panel so it shows viewLength seconds starting at viewStart (animated, the reported view is from before the change). without arguments it only reports the current time, whether it is playing and, if the timeline panel is open, its view. animated ports and Ops.TimeLine.* ops follow this time.", { "play": z.boolean().optional(), "time": z.number().optional(), "viewStart": z.number().optional(), "viewLength": z.number().optional() },
        ({ play, time, viewStart, viewLength }) =>
        {
            const timer = CABLES.patch.timer;
            logMcp("timeline" + (play !== undefined ? (play ? " play" : " pause") : "") + (time !== undefined ? " time " + time : ""));

            if (time !== undefined) timer.setTime(time);
            if (play === true) timer.play();
            if (play === false) timer.pause();

            const result = { "time": round3(timer.getTime()), "playing": timer.isPlaying() };
            const glTimeline = gui.glTimeline;
            if (glTimeline)
            {
                result.view = { "start": round3(glTimeline.view.timeLeft), "length": round3(glTimeline.view.visibleTime), "saved": glTimeline.savePatchData().view };
                if (viewLength !== undefined) glTimeline.view.setZoomLength(viewLength);
                if (viewStart !== undefined) glTimeline.view.scrollTo(viewStart);
            }
            else if (viewStart !== undefined || viewLength !== undefined) return respondError("timeline is not open, run the command \"Show timeline\" first");

            return respondText(JSON.stringify(result));
        }
    );

    server.tool(
        "set-port-animated",
        "make a number input port animated (keyframed by the timeline) or not animated anymore. a newly animated port gets a first keyframe with its current value at the current timeline time. undoable. the same way Ops.TimeLine.Anim has an animated \"Value\" port whose anim can be reused by linking its \"Anim\" output to several Ops.TimeLine.AnimGetValue ops.", { "opId": z.string(), "portName": z.string(), "animated": z.boolean() },
        ({ opId, portName, animated }) =>
        {
            logMcp((animated ? "animate " : "unanimate ") + opLabel(opId) + "." + portName);

            const found = getAnimatablePort(opId, portName);
            if (found.error) return respondError(found.error);

            if (found.port.isAnimated() != animated)
                changePortAnimUndoable(opId, portName, (animated ? "Animate " : "Unanimate ") + portName, (port) => { port.setAnimated(animated); });

            return respondText(JSON.stringify(portAnimInfo(found.port)));
        }
    );

    server.tool(
        "get-anim",
        "get the animation of a port: whether it is animated, its keyframes (time in seconds, value, easing), loop mode, length (time of the last keyframe), the current timeline time and the value at that time.", { "opId": z.string(), "portName": z.string() },
        ({ opId, portName }) =>
        {
            logMcp("get anim " + opLabel(opId) + "." + portName);

            const found = getAnimatablePort(opId, portName);
            if (found.error) return respondError(found.error);

            return respondText(JSON.stringify(portAnimInfo(found.port)));
        }
    );

    server.tool(
        "set-keyframes",
        "add or change keyframes of a number input port, the port is made animated if it is not yet. keys is a list of { time (seconds), value, easing (optional) }, a key at an existing time replaces it. easing is the curve from this key to the next one, one of: " + easingNames().join(", ") + " (default linear). clear=true removes all existing keys first. loop sets the loop mode after the last key: off, repeat, mirror or offset. undoable as one step.",
        {
            "opId": z.string(),
            "portName": z.string(),
            "keys": z.array(z.object({ "time": z.number(), "value": z.number(), "easing": z.string().optional() })),
            "clear": z.boolean().optional(),
            "loop": z.enum(["off", "repeat", "mirror", "offset"]).optional()
        },
        ({ opId, portName, keys, clear, loop }) =>
        {
            logMcp("set " + keys.length + " keyframes " + opLabel(opId) + "." + portName);

            const found = getAnimatablePort(opId, portName);
            if (found.error) return respondError(found.error);
            if (clear && keys.length == 0) return respondError("clear needs at least one key, use set-port-animated to remove the animation");

            for (let i = 0; i < keys.length; i++)
                if (keys[i].easing !== undefined && easingByName(keys[i].easing) === null) return respondError("unknown easing \"" + keys[i].easing + "\", use one of: " + easingNames().join(", "));

            changePortAnimUndoable(opId, portName, "Keyframes " + portName, (port) =>
            {
                if (!port.isAnimated()) port.setAnimated(true);
                if (clear) port.anim.clear();

                for (let i = 0; i < keys.length; i++)
                {
                    const key = port.anim.setValue(keys[i].time, keys[i].value);
                    if (keys[i].easing !== undefined) key.setEasing(easingByName(keys[i].easing));
                }
                port.anim.sortKeys();

                if (loop !== undefined) port.anim.setLoop(["off", "repeat", "mirror", "offset"].indexOf(loop));
            });

            return respondText(JSON.stringify(portAnimInfo(found.port)));
        }
    );

    server.tool(
        "delete-keyframes",
        "delete keyframes of an animated port by their times in seconds (see get-anim). an animation needs at least one key, to remove the whole animation use set-port-animated with animated=false. undoable as one step.", { "opId": z.string(), "portName": z.string(), "times": z.array(z.number()) },
        ({ opId, portName, times }) =>
        {
            logMcp("delete " + times.length + " keyframes " + opLabel(opId) + "." + portName);

            const found = getAnimatablePort(opId, portName);
            if (found.error) return respondError(found.error);
            if (!found.port.isAnimated()) return respondError("port \"" + portName + "\" on op " + opId + " is not animated");

            const anim = found.port.anim;
            const toDelete = [];
            const notFound = [];
            for (let i = 0; i < times.length; i++)
            {
                const key = anim.keys.find((k) => Math.abs(k.time - times[i]) < KEYFRAME_TIME_TOLERANCE);
                if (key) toDelete.push(key);
                else notFound.push(times[i]);
            }

            if (notFound.length) return respondError("no keyframe at time " + notFound.join(", ") + ", nothing deleted");
            if (toDelete.length >= anim.keys.length) return respondError("that would delete all keyframes, use set-port-animated with animated=false to remove the animation");

            changePortAnimUndoable(opId, portName, "Delete keyframes " + portName, (port) =>
            {
                for (let i = 0; i < toDelete.length; i++) port.anim.remove(toDelete[i]);
            });

            return respondText(JSON.stringify(portAnimInfo(found.port)));
        }
    );

    server.tool(
        "trigger-port",
        "trigger/execute a trigger-type port on an op directly, without needing anything connected to it; identify the op by its id and the port by its name (see cables://patch.json for op ids and port names). fails if the port is not a trigger port.", { "opId": z.string(), "portName": z.string() },
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
        "connect (link) an output port of one op to an input port of another op in the current patch; identify ops by id and ports by name (see cables://patch.json for op ids and port names)", { "opId1": z.string(), "portName1": z.string(), "opId2": z.string(), "portName2": z.string() },
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
        "remove an existing link between two ports (the inverse of link-ports); identify ops by id and ports by name. fails if no such link exists.", { "opId1": z.string(), "portName1": z.string(), "opId2": z.string(), "portName2": z.string() },
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
        "reposition an existing op in the patch editor view (does not affect rendering, purely cosmetic layout); identify the op by its id and give its new x/y editor coordinates", { "opId": z.string(), "x": z.number(), "y": z.number() },
        ({ opId, x, y }) =>
        {
            logMcp("move " + opLabel(opId) + " to " + x + "," + y);

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp) return respondError("no op found with id " + opId);

            const old = targetOp.uiAttribs.translate || { "x": 0, "y": 0 };
            const oldX = old.x,
                oldY = old.y;
            const moveTo = (px, py) => { gui.patchView.patchRenderer.patchAPI.setOpUiAttribs(opId, "translate", { "x": px, "y": py }); };

            moveTo(x, y);
            CABLES.UI.undo.add(
            {
                "title": "Move op",
                "undo": () => { moveTo(oldX, oldY); },
                "redo": () => { moveTo(x, y); }
            });

            return respondText("moved " + opId + " to " + x + "," + y);
        }
    );

    server.tool(
        "patch-view",
        "scroll/zoom the patch field (the editor's op graph, not the rendering canvas). fit=true zooms to show all ops of the current subpatch, opIds fits the view to those ops, x/y center the view on a patch coordinate (the same coordinates as op positions), zoom is half the visible width in patch units (bigger = further out). without arguments it only reports the current view. returns the visible area in patch coordinates. take a look with patch-field-screenshot.", { "fit": z.boolean().optional(), "opIds": z.array(z.string()).optional(), "x": z.number().optional(), "y": z.number().optional(), "zoom": z.number().optional() },
        async ({ fit, opIds, x, y, zoom }) =>
        {
            logMcp("patch view");

            if (opIds)
            {
                const ops = opIds.map((opId) => CABLES.patch.getOpById(opId));
                const missing = opIds.filter((opId, i) => !ops[i]);
                if (missing.length) return respondError("no op found with id " + missing.join(", "));
                fitPatchView(ops);
            }
            else if (fit)
            {
                const ops = visiblePatchOps();
                if (!ops.length) return respondError("no ops in the current subpatch");
                fitPatchView(ops);
            }
            else if ((x === undefined) != (y === undefined)) return respondError("pass both x and y");
            else setPatchView(x, y, zoom);

            // view changes are animated, report the view once they are done
            await new Promise((resolve) => { setTimeout(resolve, PATCHFIELD_VIEW_ANIM_MS); });
            return respondText(JSON.stringify(patchViewInfo()));
        }
    );

    server.tool(
        "patch-field-screenshot",
        "take a screenshot of the patch field (the editor's op graph with ops and links, not the rendering canvas) as a png image. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size). use patch-view to scroll/zoom first; panels on top of the patch field are not in the image.", { "maxSize": z.number().optional() },
        async ({ maxSize }) =>
        {
            logMcp("patch field screenshot");

            try
            {
                const png = await grabPatchFieldScreenshot(maxSize ?? SCREENSHOT_DEFAULT_MAX_SIZE);
                return respond({ "content": [{ "type": "image", "data": png, "mimeType": "image/png" }] });
            }
            catch (e)
            {
                return respondError("patch field screenshot failed: " + e.message);
            }
        }
    );

    server.tool(
        "perf-profiler-read",
        "read the patch's perf profiler (the per-frame durations and counts the code reports with perfProfiler.setDuration/addCount, e.g. \"timeline cpu\" or \"<canvas> gpu\" from gl timer queries): per name the average, max and last value over the kept frames (default 120). optional filter only lists names containing that text.", { "filter": z.string().optional() },
        ({ filter }) =>
        {
            logMcp("perf profiler read");

            const profiler = CABLES.patch.perfProfiler;
            const summarize = (frames, key) =>
            {
                const values = frames.map((f) => f[key]).filter((v) => typeof v == "number");
                if (!values.length) return null;
                const sum = values.reduce((a, b) => a + b, 0);
                return { "avg": round3(sum / values.length), "max": round3(Math.max(...values)), "last": round3(values[values.length - 1]), "frames": values.length };
            };

            const result = { "durationsMs": {}, "counts": {} };
            for (const name in profiler.durationsFrames)
                if (!filter || name.includes(filter)) result.durationsMs[name] = summarize(profiler.durationsFrames[name], "ms");
            for (const name in profiler.countsFrames)
                if (!filter || name.includes(filter)) result.counts[name] = summarize(profiler.countsFrames[name], "num");

            return respondText(JSON.stringify(result));
        }
    );

    server.tool(
        "timeline-screenshot",
        "take a screenshot of the timeline panel (ruler, overview, keys and curves) as a png image. only the gl canvas: the html line titles and buttons are not in the image. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size). the timeline has to be open (command \"Show timeline\").", { "maxSize": z.number().optional() },
        async ({ maxSize }) =>
        {
            logMcp("timeline screenshot");

            try
            {
                const png = await grabTimelineScreenshot(maxSize ?? SCREENSHOT_DEFAULT_MAX_SIZE);
                return respond({ "content": [{ "type": "image", "data": png, "mimeType": "image/png" }] });
            }
            catch (e)
            {
                return respondError("timeline screenshot failed: " + e.message);
            }
        }
    );

    server.tool(
        "tidy-up-ops",
        "tidy up the layout of ops: arranges them in rows following their links (every op below all ops linked to its inputs), each op at the x of the op above until the links split, split children side by side in port order. ops never overlap. unselected ops are never moved, the selected ops are placed around them. links may cross. snapped to the grid. works on the selected ops, or on opIds; all have to be in the current subpatch. undoable as one step. if no valid layout is found (link cycle, no free place) nothing is changed and the reason is returned.", { "opIds": z.array(z.string()).optional(), "dryRun": z.boolean().optional() },
        ({ opIds, dryRun }) =>
        {
            logMcp("tidy up ops");

            let ops = gui.patchView.getSelectedOps();
            if (opIds)
            {
                ops = opIds.map((opId) => CABLES.patch.getOpById(opId));
                const missing = opIds.filter((opId, i) => !ops[i]);
                if (missing.length) return respondError("no op found with id " + missing.join(", "));
            }
            if (!ops.length) ops = visiblePatchOps();

            const sub = gui.patchView.getCurrentSubPatch();
            const outside = ops.filter((o) => (o.uiAttribs.subPatch || 0) != sub || !o.uiAttribs.translate || !gui.patchView.patchRenderer.getGlOp(o));
            if (outside.length) return respondError("ops not in the current subpatch: " + outside.map((o) => o.id).join(", "));

            const pos = layoutOps(ops);
            if (typeof pos == "string") return respondError("nothing changed: " + pos);

            if (dryRun) return respondText([...pos].map(([o, p]) => o.id + " " + p.x + "," + p.y).join("\n"));

            const moved = applyOpPositions(pos);
            fitPatchView(ops);
            return respondText(JSON.stringify({ "ops": ops.length, "moved": moved, "rows": new Set([...pos.values()].map((p) => p.y)).size }));
        }
    );

    server.tool(
        "debug-glop",
        "temporary: debug info of an op's glop (size, area size)", { "opId": z.string() },
        ({ opId }) =>
        {
            if (opId == "scripts")
            {
                const srcs = [...document.querySelectorAll("script")].map((s) => s.src).filter((s) => s);
                return (async () =>
                {
                    const out = [];
                    for (const s of srcs)
                    {
                        if (!s.includes("cables.ui")) { out.push(s); continue; }
                        const t = await (await fetch(s)).text();
                        out.push(s + " len " + t.length + " findCycleLinks " + t.includes("findCycleLinks") + " fan( " + t.includes("#fan("));
                    }
                    return respondText(out.join("\n"));
                })();
            }
            if (opId == "tidy")
            {
                gui.patchView.tidyUpOps(gui.patchView.getSelectedOps());
                const msgs = [...document.querySelectorAll(".iziToast")].map((el) => el.textContent);
                return respondText(JSON.stringify(msgs));
            }
            const o = CABLES.patch.getOpById(opId);
            if (!o) return respondError("no op " + opId);
            const g = gui.patchView.patchRenderer.getGlOp(o);
            const ra = g ? (g.resizableArea || g._resizableArea) : null;
            return respondText(JSON.stringify(
            {
                "translate": o.uiAttribs.translate,
                "hasArea": o.uiAttribs.hasArea,
                "area": o.uiAttribs.area,
                "glop": g ? { "w": g.w, "h": g.h, "hasResizableAreaGetter": "resizableArea" in g } : null,
                "resizableArea": ra ? { "w": ra.w, "h": ra.h, "_w": ra._w, "_h": ra._h } : null,
                "tidyUpOps": String(gui.patchView.tidyUpOps).substring(0, 300)
            }));
        }
    );

    server.tool(
        "set-op-comment",
        "set the comment of an op in the patch by its id, shown next to its title in the patch editor (the same as the comment field in the param panel). an empty comment removes it. undoable.", { "opId": z.string(), "comment": z.string() },
        ({ opId, comment }) =>
        {
            logMcp("comment " + opLabel(opId));

            if (!CABLES.patch.getOpById(opId)) return respondError("no op found with id " + opId);

            setOpCommentUndoable(opId, comment);
            return respondText(comment ? "comment of " + opId + " set" : "comment of " + opId + " removed");
        }
    );

    server.tool(
        "focus-op",
        "scroll/zoom the patch editor view to center on an op and open its param panel, so the person looking at the editor can see it. does not affect rendering.", { "opId": z.string() },
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
        "get-patch-overview",
        "compact overview of the current patch, much smaller than cables://patch.json: one line per op with its id, full op name (objName), title and subpatch, followed by its incoming (<-) and outgoing (->) links as port: opId.port. no port values unless values=true, then only the values that differ from the op's defaults (linked ports left out). optional subPatch limits it to one subpatch, filter to ops whose name or title contains the text. use get-patch-op for all values of a single op.", { "subPatch": z.string().optional(), "filter": z.string().optional(), "values": z.boolean().optional() },
        ({ subPatch, filter, values }) =>
        {
            logMcp("patch overview" + (filter ? " \"" + filter + "\"" : ""));

            const lines = patchOverviewLines(subPatch, filter, values);
            return respondText(lines.length ? lines.join("\n") : "no ops found");
        }
    );

    server.tool(
        "select-op",
        "select ops in the patch editor, like clicking them. commands from run-command act on the selected ops. opIds is a list of op ids, add true keeps the current selection, otherwise it is cleared first.", { "opIds": z.array(z.string()), "add": z.boolean().optional() },
        ({ opIds, add }) =>
        {
            logMcp("select " + opIds.map((opId) => { return opLabel(opId); }).join(", "));

            if (!CABLES.UI || !gui.patchView) return respondError("no patch editor UI available to select in");

            const missing = opIds.filter((opId) => { return !CABLES.patch.getOpById(opId); });
            if (missing.length > 0) return respondError("no op found with id " + missing.join(", "));

            if (!add) gui.patchView.unselectAllOps();
            opIds.forEach((opId) => { gui.patchView.selectOpId(opId); });

            const selected = gui.patchView.getSelectedOps().map((selOp) => { return selOp.id + " (" + selOp.objName + ")"; });
            return respondText("selected: " + selected.join(", "));
        }
    );

    server.tool(
        "add-op",
        "add a new op to the current patch by its full op name (objName), e.g. Ops.Anim.Timer_v2; get valid names from search-ops. returns the new op's id (use it with link-ports / set-port-value) and its port names. optional x/y place it in the patch editor view.", { "objName": z.string(), "x": z.number().optional(), "y": z.number().optional() },
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
        "delete an op from the current patch by its id (see cables://patch.json for op ids); this also removes any links connected to it", { "opId": z.string() },
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
        "check the current patch for errors: lists ops that show ui errors/warnings (e.g. shader compile errors, missing links, wrong input types) with their messages, plus code diagnostics (line, message, code) where available. minLevel filters by severity: 0 hint, 1 warning, 2 error (default 1). optional opId checks a single op. use it after changing shader code or port values.", { "minLevel": z.number().optional(), "opId": z.string().optional() },
        async ({ minLevel, opId }) =>
        {
            logMcp("check patch errors" + (opId ? " of " + opLabel(opId) : ""));

            if (opId && !CABLES.patch.getOpById(opId)) return respondError("no op found with id " + opId);

            // shaders recompile while rendering, so errors of the last change only show up after the next rendered frame
            await waitForRenderedFrame();

            const errors = getPatchErrors(minLevel === undefined ? 1 : minLevel, opId);
            return respondText(errors.length ? JSON.stringify(errors, null, 1) : "no errors found");
        }
    );

    server.tool(
        "save-patch",
        "save the current patch to disk/server, the same as the editor's own save action (ctrl+s). skips confirmation dialogs since there is no user to click through them.", {},
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
        "set-patch-name",
        "rename the current patch (its title), the same as the editor's patch title dialog. the new name is stored right away, no save-patch needed.", { "name": z.string() },
        async ({ name }) =>
        {
            logMcp("set patch name \"" + name + "\"");

            if (!name.trim()) return respondError("patch name must not be empty");

            try
            {
                const newName = await withTimeout(setPatchName(name), 10000, "setProjectName");
                return respondText("patch renamed to \"" + newName + "\"");
            }
            catch (e)
            {
                return respondError("could not rename patch: " + e.message);
            }
        }
    );

    server.tool(
        "get-console-logs",
        "read the editor's console: console.log/warn/error, uncaught exceptions and browser messages like the yellow webgl warnings (GL_INVALID_OPERATION...). needs electron started with --remote-debugging-port=9222. minLevel: verbose, info, warning or error (default info). optional str filters by text, limit is the number of newest entries (default 100), clear empties the list afterwards.", { "minLevel": z.enum(CONSOLE_LEVELS).optional(), "str": z.string().optional(), "limit": z.number().optional(), "clear": z.boolean().optional() },
        async ({ minLevel, str, limit, clear }) =>
        {
            logMcp("get console logs" + (str ? " \"" + str + "\"" : ""));

            try
            {
                await connectDevTools();
            }
            catch (e)
            {
                return respondError("could not connect to devtools: " + e.message);
            }

            const minIndex = CONSOLE_LEVELS.indexOf(minLevel || "info");
            const filter = (str || "").toLowerCase();
            const lines = consoleEntries
                .filter((e) => CONSOLE_LEVELS.indexOf(e.level) >= minIndex)
                .filter((e) => !filter || e.text.toLowerCase().includes(filter))
                .sort((a, b) => a.timestamp - b.timestamp)
                .slice(-(limit || CONSOLE_DEFAULT_LIMIT))
                .map((e) => new Date(e.timestamp).toLocaleTimeString() + " " + e.level + " [" + e.source + "] " + e.text + (e.location ? " (" + e.location + ")" : ""));

            if (clear) consoleEntries.length = 0;

            return respondText(lines.length ? lines.join("\n") : "no console entries" + (filter || minLevel ? " matching the filter" : ""));
        }
    );

    server.tool(
        "screenshot",
        "take a screenshot of the patch's rendering canvas and return it as a png image; use it to check what a change looks like. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size); larger images cost more tokens.", { "maxSize": z.number().optional() },
        async ({ maxSize }) =>
        {
            logMcp("screenshot");

            try
            {
                const png = await grabScreenshot(maxSize ?? SCREENSHOT_DEFAULT_MAX_SIZE);
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
        "list the cables editor commands (the same as in the command palette), with category and description. optional str filters by name/category/description. run them with run-command.", { "str": z.string().optional() },
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
        "run a cables editor command by its name, exactly as listed by list-commands (the same as selecting it in the command palette). many commands act on the currently selected ops.", { "name": z.string() },
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
        "set the size of the rendering canvas in pixels, the same as the editor's \"change canvas size\" command", { "width": z.number(), "height": z.number() },
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
        "get the documentation of an op by its full op name (objName), e.g. Ops.Gl.Meshes.Circle_v2: summary, description, port documentation, ports layout, libs/dependencies and whether a newer version exists (oldVersion)", { "objName": z.string() },
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
        "list all documented ops, one per line as \"name: summary\". optional str filters by name/summary. old versions and hidden ops are left out unless includeOld / includeHidden is true. use get-op-docs for the full documentation of an op.", { "str": z.string().optional(), "includeOld": z.boolean().optional(), "includeHidden": z.boolean().optional() },
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

    server.tool(
        "get-patch-op",
        "get one op instance from the current patch as serialized json, by its op id (see cables://patch.json for op ids): its current port values, uiAttribs, storage and outgoing links (incoming links are stored on the op they come from). this is the op as it is used in the patch, not its documentation (use get-op-docs for that) and not its source code (use cables://op/<name>).", { "opId": z.string() },
        ({ opId }) =>
        {
            logMcp("get patch op " + opLabel(opId));

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp) return respondError("no op found with id " + opId);

            const serialized = targetOp.getSerialized();
            if (!serialized.objName) serialized.objName = targetOp.objName;

            return respondText(JSON.stringify(serialized, null, 1));
        }
    );

    server.tool(
        "get-jobs",
        "list what the editor is loading: \"ui\" are editor jobs (the ui loading indicator, e.g. loading op code or docs), \"patch\" are asset loading tasks started by ops in the patch (e.g. textures, files, libs). running entries show how long they have been running, one running for a long time is probably stuck. optional numFinished also lists the most recent finished entries of both with their duration.", { "numFinished": z.number().optional() },
        ({ numFinished }) =>
        {
            logMcp("get jobs");

            const now = Date.now();
            const last = (arr) => (numFinished ? arr.slice(-numFinished) : []);

            const uiJobs = gui.jobs().getList();
            const ui = {
                "running": uiJobs.filter((j) => !j.finished).map((j) => ({ "id": j.id, "title": j.title, "runningMs": now - j.timeStart })),
                "finished": last(uiJobs.filter((j) => j.finished)).map((j) => ({ "id": j.id, "title": j.title, "durationMs": j.timeEnd - j.timeStart }))
            };

            const patchTask = (t) =>
            {
                const r = { "type": t.type, "name": t.name };
                if (t.op) r.op = { "id": t.op.id, "title": t.op.getTitle() };
                if (t.finished) r.durationMs = t.timeEnd - t.timeStart;
                else r.runningMs = now - t.timeStart;
                return r;
            };
            const patchTasks = gui.corePatch().loading.getList();
            const patch = {
                "running": patchTasks.filter((t) => !t.finished).map(patchTask),
                "finished": last(patchTasks.filter((t) => t.finished)).map(patchTask)
            };

            if (!numFinished)
            {
                delete ui.finished;
                delete patch.finished;
            }

            return respondText(JSON.stringify({ "ui": ui, "patch": patch }, null, 1));
        }
    );

    server.tool(
        "get-build-info",
        "build info of the code that is running in the editor right now (compiled into the bundles, not read from disk): when the ui and core were built and from which git commit. ageSeconds is how long ago that was. use it after reloading the editor to check that a change is live: created has to be newer than the edit. serverStarted is when this mcp server started (changes with every editor reload), loading/runningJobs tell if the editor or patch is still loading.", {},
        () =>
        {
            logMcp("get build info");

            const now = Date.now();
            const describe = (build) =>
            {
                if (!build) return null;
                const r = { "created": build.created, "ageSeconds": Math.round((now - build.timestamp) / 1000) };
                if (build.git) r.git = { "branch": build.git.branch, "commit": build.git.commit, "message": build.git.message };
                return r;
            };

            const loaderInfo = (window.CABLESUILOADER && CABLESUILOADER.buildInfo) || {};

            let runningJobs = 0;
            const uiJobs = gui.jobs().getList();
            for (let i = 0; i < uiJobs.length; i++)
                if (!uiJobs[i].finished) runningJobs++;
            const patchTasks = gui.corePatch().loading.getList();
            for (let i = 0; i < patchTasks.length; i++)
                if (!patchTasks[i].finished) runningJobs++;

            return respondText(JSON.stringify(
            {
                "now": new Date(now).toISOString(),
                "serverStarted": window.cablesMcpServerStarted,
                "loading": runningJobs > 0,
                "runningJobs": runningJobs,
                "ui": describe(CABLES.UI.build || loaderInfo.ui),
                "core": describe(CABLES.build || loaderInfo.core),
                "api": describe(loaderInfo.api)
            }, null, 1));
        }
    );

    server.tool(
        "reload-editor",
        "reload the whole editor page, e.g. to load newly built ui code. this mcp server restarts with it, so the answer only confirms the reload was triggered. afterwards poll get-build-info until it answers again with a newer serverStarted and loading false. with unsaved changes it does not reload (the editor would block on a leave-page dialog) unless unsaved is \"save\" (save the patch first) or \"discard\" (reload without saving, the changes are lost).", { "unsaved": z.enum(["save", "discard"]).optional() },
        async ({ unsaved }) =>
        {
            logMcp("reload editor" + (unsaved ? " (" + unsaved + " unsaved)" : ""));

            const cmd = CABLES.CMD.commands.find((c) => c && c.cmd == "Reload Editor");
            if (!cmd || !cmd.func) return respondError("no \"Reload Editor\" command found");

            if (!gui.savedState.isSaved)
            {
                if (unsaved == "save")
                {
                    try
                    {
                        await savePatch();
                    }
                    catch (e)
                    {
                        return respondError("not reloading, save failed: " + e.message);
                    }
                }
                else if (unsaved == "discard") gui.savedState.setSavedAll("mcp reload-editor");
                else return respondError("not reloading: the patch has unsaved changes, call again with unsaved \"save\" or \"discard\"");
            }

            setTimeout(() => { cmd.func(); }, RELOAD_EDITOR_DELAY_MS);
            return respondText(JSON.stringify({ "reloading": true, "serverStarted": window.cablesMcpServerStarted }));
        }
    );

    server.tool(
        "ui-profiler-start",
        "clear the editor's ui profiler and start measuring from now on (the same data as the ui profiler tab). every gui.uiProfiler.start(name)/finish() in the ui code is one measurement. do the actions to measure afterwards (e.g. select ops, drag, reload), then read the result with ui-profiler-read.", {},
        () =>
        {
            logMcp("ui profiler start");

            gui.uiProfiler.ignore = false;
            gui.uiProfiler.clear();
            window.cablesMcpUiProfilerStarted = performance.now();
            return respondText("ui profiler cleared and measuring");
        }
    );

    server.tool(
        "ui-profiler-read",
        "read the ui profiler measurements since ui-profiler-start: per measured name the count, average/max/last time in ms (over the most recent times the profiler keeps, see keptTimes) and estTotalMs (count * average). sorted by estTotalMs, so the biggest cost is first. optional filter only lists names containing that text, limit the number of entries (default 30).", { "filter": z.string().optional(), "limit": z.number().optional() },
        ({ filter, limit }) =>
        {
            logMcp("ui profiler read");

            const measures = gui.uiProfiler._measures;
            const entries = [];
            for (const name in measures)
            {
                if (filter && name.indexOf(filter) == -1) continue;

                const times = measures[name].times || [];
                if (!times.length) continue;

                let sum = 0;
                let max = 0;
                for (let i = 0; i < times.length; i++)
                {
                    sum += times[i];
                    max = Math.max(max, times[i]);
                }
                const avg = sum / times.length;
                const round = (v) => Math.round(v * 1000) / 1000;

                const entry = {
                    "name": name,
                    "count": measures[name].count,
                    "avgMs": round(avg),
                    "maxMs": round(max),
                    "lastMs": round(times[times.length - 1]),
                    "estTotalMs": round(avg * measures[name].count),
                    "keptTimes": times.length
                };
                if (measures[name].text) entry.text = measures[name].text;
                entries.push(entry);
            }

            entries.sort((a, b) => b.estTotalMs - a.estTotalMs);

            const result = {
                "measuringMs": window.cablesMcpUiProfilerStarted ? Math.round(performance.now() - window.cablesMcpUiProfilerStarted) : null,
                "numNames": entries.length,
                "entries": entries.slice(0, limit || 30)
            };
            return respondText(JSON.stringify(result, null, 1));
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

// close() only stops accepting new connections and calls back once all open ones are gone,
// keep-alive connections of the mcp client would keep the port busy, so they are closed right away
function stopServer(server)
{
    console.log("stop mcp")
    return new Promise((resolve) =>
    {
        if (!server || !server.listening) { resolve(); return; }

        server.close(() => { resolve(); });
        if (server.closeAllConnections) server.closeAllConnections();
    });
}

// the port can still be in use for a moment after the previous server was stopped, so retry instead of giving up
const instanceToken = {};
window.cablesMcpInstance = instanceToken;

function isCurrentInstance()
{
    return window.cablesMcpInstance === instanceToken;
}

function listen(retriesLeft)
{
    if (!isCurrentInstance()) return;

    const onListenError = (e) =>
    {
        if (e.code === "EADDRINUSE" && retriesLeft > 0)
        {
            setTimeout(() => { listen(retriesLeft - 1); }, LISTEN_RETRY_MS);
            return;
        }
        logMcp("mcp server error: " + e.message);
    };

    httpServer.once("error", onListenError);
    httpServer.listen(MCP_PORT, () =>
    {
        httpServer.off("error", onListenError);
        if (!isCurrentInstance())
        {
            stopServer(httpServer);
            return;
        }
        httpServer.on("error", (e) => { logMcp("mcp server error: " + e.message); });

        window.cablesMcpHttpServer = httpServer;
        window.cablesMcpServerStarted = new Date().toISOString();
        window.cablesMcpServerStarts = (window.cablesMcpServerStarts || 0) + 1;

        logMcp("mcp server " + (window.cablesMcpServerStarts > 1 ? "restarted" : "started") + " on port " + MCP_PORT);
        console.log("MCP server listening on http://localhost:" + MCP_PORT + "/mcp");
        outStarted.set(true);
    });
}

// start capturing right away so messages from before the first get-console-logs call are kept, without the debug port there is nothing to capture
connectDevTools().catch(() => {});

// after an op reload the server of the previous instance may still be running, it has to release the port first
op.startMcpServer = () =>
{
    window.cablesMcpInstance = instanceToken;
    stopServer(window.cablesMcpHttpServer).then(() => { listen(LISTEN_MAX_RETRIES); });
};
op.startMcpServer();

function checkSingleServerOp()
{
    const serverOps = op.patch.getOpsByObjName(op.objName);
    if (serverOps.length > 1) op.setUiError("multipleServerOps", "there are " + serverOps.length + " " + op.objName + " ops in this patch, only one of them can run the mcp server. delete the others.", 2);
    else op.setUiError("multipleServerOps", null);
}

const opAddedListener = op.patch.on(CABLES.Patch.EVENT_OP_ADDED, checkSingleServerOp);
const opDeletedListener = op.patch.on(CABLES.Patch.EVENT_OP_DELETED, checkSingleServerOp);
checkSingleServerOp();

// when the running server op is deleted (not reloaded) another server op in the patch takes over
op.onDelete = (reloadingOp) =>
{
    const wasRunning = isCurrentInstance();
    logMcp("stop mcp server");
    if (window.cablesMcpHttpServer === httpServer) window.cablesMcpHttpServer = null;
    if (isCurrentInstance()) window.cablesMcpInstance = null;
    op.patch.off(opAddedListener);
    op.patch.off(opDeletedListener);

    const otherServerOps = op.patch.getOpsByObjName(op.objName);
    if (wasRunning && !reloadingOp && otherServerOps.length > 0 && otherServerOps[0].startMcpServer) otherServerOps[0].startMcpServer();
    if (devToolsSocket) devToolsSocket.close();
    stopServer(httpServer).then(() => { console.log("Server closed"); });
};
