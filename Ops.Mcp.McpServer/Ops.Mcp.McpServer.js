const McpServer = op.require("@modelcontextprotocol/sdk/server/mcp.js");
const StreamableHTTPServerTransport = op.require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const http = op.require("node:http");
const { z } = op.require("zod");

const
    outStarted = op.outBoolNum("Started", false),
    outData = op.outObject("Last Request Data"),
    outLog = op.outString("Log","");

const MCP_PORT = 3000;
const SCREENSHOT_DEFAULT_MAX_SIZE = 640;
const SELF_EXECUTE_DELAY_MS = 100;
const SEARCH_DEFAULT_LIMIT = 20;
const PATCHFIELD_FRAME_TIMEOUT_MS = 3000;
const PATCHFIELD_VIEW_ANIM_MS = 500;
const PATCHFIELD_FIT_PADDING = 1.1;
const PATCHFIELD_FIT_MIN_SIZE = 250;
const KEYFRAME_TIME_TOLERANCE = 0.0005;
const EASING_NAME_CLIP = "Clip";
const easingConverter = new CABLES.Anim();
const CLEANUP_GRID_X = 12;
const CLEANUP_GRID_Y = 20;
const CLEANUP_GAP_X = 2 * CLEANUP_GRID_X;
const CLEANUP_GAP_Y = CLEANUP_GRID_Y;
const CLEANUP_MAX_SHIFT_STEPS = 400;
const CLEANUP_FANOUT_GAP_X = 4 * CLEANUP_GRID_X;
const CLEANUP_OP_HEIGHT = 31;
let sideChainTops = new Set();
let lastFanSlots = new Map();
let fixedRects = [];
let selectedSet = new Set();
const CLEANUP_LINK_GAP_MIN_LINKS = 2;
const CLEANUP_LINK_GAP_MAX_LINKS = 10;
const CLEANUP_LINK_GAP_MIN_OPS = 2;
const CLEANUP_LINK_GAP_MAX_OPS = 5;
const CLEANUP_SMALL_BRANCH_FACTOR = 2;
const CLEANUP_FANOUT_MIN_CHILDREN = 3;
const LISTEN_RETRY_MS = 20;
const LISTEN_MAX_RETRIES = 1150;
const RELOAD_EDITOR_DELAY_MS = 300;

const DEVTOOLS_PORT = 9222;
const CONSOLE_MAX_ENTRIES = 1000;
const CONSOLE_DEFAULT_LIMIT = 100;
const CONSOLE_LEVELS = ["verbose", "info", "warning", "error"];
const CONSOLE_API_LEVELS = { "debug": "verbose", "trace": "verbose", "warning": "warning", "error": "error", "assert": "error" };

const consoleEntries = [];
let devToolsSocket = null;
let devToolsConnecting = null;

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

// attachment file names always start with att_, e.g. att_inc_node.js
function attachmentFileName(name)
{
    return name.startsWith("att_") ? name : "att_" + name;
}

function getOpDocOrThrow(opname)
{
    const opDoc = gui.opDocs.getOpDocByName(opname);
    if (!opDoc) throw new Error("no op found with name " + opname);
    return opDoc;
}

async function readOpAttachment(opname, name)
{
    const opDoc = getOpDocOrThrow(opname);
    const res = await talkerSend("opAttachmentGet", { "opname": opDoc.id, "name": attachmentFileName(name) });
    if (!res || res.content === undefined || res.content === null) throw new Error("no attachment " + attachmentFileName(name) + " in op " + opname + ", see list-op-attachments");
    return res.content;
}

// writes an attachment, creates it first if the op does not have it yet
async function writeOpAttachment(opname, name, content)
{
    const opDoc = getOpDocOrThrow(opname);
    const fileName = attachmentFileName(name);
    opDoc.attachmentFiles = opDoc.attachmentFiles || [];

    let created = false;
    if (!opDoc.attachmentFiles.includes(fileName))
    {
        await talkerSend("opAttachmentAdd", { "opname": opDoc.id, "name": fileName.substring(4) });
        opDoc.attachmentFiles.push(fileName);
        created = true;
    }

    const res = await talkerSend("opAttachmentSave", { "opname": opDoc.id, "name": fileName, "content": content });
    if (res && res.data && res.data.updated) gui.patchView.store.setServerDate(res.data.updated);
    gui.emitEvent("refreshManageOp", opDoc.name);
    return created;
}

// rejects when a promise does not settle in time, so tools report which step hung instead of blocking
function withTimeout(promise, ms, step)
{
    return Promise.race([promise, new Promise((resolve, reject) => { setTimeout(() => { reject(new Error("timeout in step: " + step)); }, ms); })]);
}

// creates a new op (the location follows from its name), optionally with code and attachments { "att_name": content }, and loads it.
// attachments are written afterwards, passing them to opCreate fails in electron when the project has op dirs
async function createOp(opname, code, attachments)
{
    const req = { "opname": opname };
    if (code) req.code = code;

    const res = await withTimeout(talkerSend("opCreate", req), 10000, "opCreate");
    if (res && res.problems && res.problems.length) throw new Error(res.problems.join(", "));

    const created = (res && res.data) || res;
    await withTimeout(new Promise((resolve) => { gui.serverOps.loadOp(created, () => { resolve(); }); }), 15000, "loadOp");

    for (const name in attachments || {}) await withTimeout(writeOpAttachment(opname, name, attachments[name]), 10000, "attachment " + name);
    if (attachments && Object.keys(attachments).length) await executeOp(opname);

    gui.opSelect().reload();
    return created;
}

// saves new op code like the op code editor does, also updates the op's editor tab if it is open
// so saving that tab later does not bring back the old code
async function saveOpCode(opname, code)
{
    const opDoc = getOpDocOrThrow(opname);
    const res = await talkerSend("saveOpCode", { "opname": opDoc.id, "code": code, "format": false });
    if (!res.success) throw new Error(res.error ? JSON.stringify(res.error) : "saving failed");
    if (res.updated) gui.patchView.store.setServerDate(res.updated);

    const tab = findOpenTab(urlName(opname));
    if (tab) tab.editor.setContent(code);
}

// the op code, or the content of one of its attachments when attachment is given
function readOpText(opname, attachment)
{
    return attachment ? readOpAttachment(opname, attachment) : getOpSource(opname);
}

// executes the op afterwards; the response of an edit to this op itself has to be sent before
// it restarts the mcp server, so that execution is delayed
async function writeOpText(opname, attachment, text)
{
    if (attachment) await writeOpAttachment(opname, attachment, text);
    else await saveOpCode(opname, text);

    if (opname === op.objName) setTimeout(() => { executeOp(opname); }, SELF_EXECUTE_DELAY_MS);
    else await executeOp(opname);
}

function countOccurrences(text, part)
{
    return text.split(part).length - 1;
}

// lines with their line numbers, like cat -n
function numberedLines(lines, firstLine)
{
    return lines.map((line, i) => (firstLine + i) + "\t" + line).join("\n");
}

// reloads the code of an op in all its instances in the patch
function executeOp(opname)
{
    return new Promise((resolve) =>
    {
        const timeout = setTimeout(resolve, 15000);
        gui.serverOps.execute(opname, () => { clearTimeout(timeout); resolve(); });
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
        CABLES.UI.undo.add({
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
        CABLES.UI.undo.add({
            "title": "Op comment",
            "undo": () => { apply(oldComment); },
            "redo": () => { apply(comment); }
        });
}

// finds an animatable port (number input) of an op in the patch, returns { port } or { error }
function getAnimatablePort(opId, portName)
{
    const targetOp = CABLES.patch.getOpById(opId);
    if (!targetOp) return { "error": "no op found with id " + opId };

    const port = targetOp.getPort(portName);
    if (!port) return { "error": "no port named \"" + portName + "\" on op " + opId };
    if (port.direction !== CABLES.Port.DIR_IN || port.type !== CABLES.Port.TYPE_VALUE) return { "error": "port \"" + portName + "\" on op " + opId + " is not a number input port, only those can be animated" };

    return { "port": port };
}

// easing names as shown in the timeline, the anim easing constants are not in the order of Anim.EASINGNAMES.
// clip easing is left out, it needs a clip anim to work
function easingNames()
{
    return CABLES.Anim.EASINGNAMES.filter((n) => n != EASING_NAME_CLIP);
}

function easingByName(name)
{
    const names = easingNames();
    for (let i = 0; i < names.length; i++)
        if (names[i].toLowerCase() == String(name).toLowerCase()) return easingConverter.easingFromString(names[i]);
    return null;
}

function easingName(easing)
{
    const names = easingNames();
    for (let i = 0; i < names.length; i++)
        if (easingConverter.easingFromString(names[i]) === easing) return names[i];
    return String(easing);
}

function portAnimState(port)
{
    return { "animated": port.isAnimated(), "anim": port.anim ? port.anim.getSerialized() : null };
}

function applyPortAnimState(opId, portName, state)
{
    const o = CABLES.patch.getOpById(opId);
    if (!o) return;
    const p = o.getPort(portName);
    if (!p) return;

    p.setAnimated(state.animated);
    if (state.animated && state.anim)
    {
        p.anim.deserialize(state.anim, true);
        p.anim.loop = state.anim.loop || CABLES.Anim.LOOP_OFF;
        p.anim.emitEvent(CABLES.Anim.EVENT_CHANGE, p.anim);
    }
    o.patch.emitEvent(CABLES.Port.EVENT_ANIM_UPDATED, o, p, p.anim);
    gui.savedState.setUnSaved("mcpAnim", o.getSubPatch());
    if (gui.patchView.isCurrentOp(o)) o.refreshParams();
}

// runs change(port) and registers one undo step that restores the animation state of the port from before
function changePortAnimUndoable(opId, portName, title, change)
{
    const port = CABLES.patch.getOpById(opId).getPort(portName);
    const oldState = portAnimState(port);

    change(port);
    if (port.anim) port.anim.emitEvent(CABLES.Anim.EVENT_CHANGE, port.anim);
    applyPortAnimState(opId, portName, portAnimState(port));

    const newState = portAnimState(port);
    CABLES.UI.undo.add({
        "title": title,
        "context": { "portname": portName },
        "undo": () => { applyPortAnimState(opId, portName, oldState); },
        "redo": () => { applyPortAnimState(opId, portName, newState); }
    });
}

function portAnimInfo(port)
{
    const anim = port.anim;
    const time = CABLES.patch.timer.getTime();
    const info = { "animated": port.isAnimated(), "time": round3(time), "value": port.get() };
    if (!anim) return info;

    info.loop = ["off", "repeat", "mirror", "offset"][anim.getLoop()] || anim.getLoop();
    info.length = anim.keys.length ? round3(anim.lastKey.time) : 0;
    info.valueAtTime = anim.keys.length ? anim.getValue(time) : null;
    info.keys = [];
    for (let i = 0; i < anim.keys.length; i++)
        info.keys.push({ "time": round3(anim.keys[i].time), "value": anim.keys[i].value, "easing": easingName(anim.keys[i].getEasing()) });
    return info;
}

function round3(v)
{
    return Math.round(v * 1000) / 1000;
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

// converts a png blob to base64 (without data: prefix), downscaled so its longer edge is at most maxSize
// to keep the image (and its token cost) small; maxSize 0 = keep original size
async function blobToPng(blob, maxSize)
{
    const img = await createImageBitmap(blob);
    const longEdge = Math.max(img.width, img.height);
    const scale = maxSize && longEdge > maxSize ? maxSize / longEdge : 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();

    return canvas.toDataURL("image/png").split(",")[1];
}

// renders a frame and captures it right away with the renderer's own screenshot function (the same as the
// "save screenshot" command), so the canvas still holds the rendered image instead of an already cleared buffer
function grabScreenshot(maxSize)
{
    return new Promise((resolve, reject) =>
    {
        const cg = gui.canvasManager.currentContextCg() || CABLES.patch.cgl;
        if (!cg || !cg.screenShot) { reject(new Error("no rendering context with a screenshot function found")); return; }

        cg.patch.renderOneFrame();
        cg.screenShot((blob) =>
        {
            if (!blob) { reject(new Error("screenshot returned no image")); return; }
            blobToPng(blob, maxSize).then(resolve, reject);
        }, false, "image/png");
    });
}

// captures the patch field (the glpatch canvas) right after its next rendered frame, while the drawing buffer still holds the image
function grabPatchFieldScreenshot(maxSize)
{
    return new Promise((resolve, reject) =>
    {
        const cgl = gui.patchView.patchRenderer.cgl;
        const timeout = setTimeout(() => { cgl.off(listener); reject(new Error("patch field did not render a frame")); }, PATCHFIELD_FRAME_TIMEOUT_MS);

        const listener = cgl.on("endFrame", () =>
        {
            clearTimeout(timeout);
            setTimeout(() => { cgl.off(listener); }, 0);
            cgl.screenShot((blob) =>
            {
                if (!blob) { reject(new Error("screenshot returned no image")); return; }
                blobToPng(blob, maxSize).then(resolve, reject);
            }, false, "image/png");
        });
    });
}

// size of the patch field in css pixels, the unit of screen coordinates in the viewbox
function patchFieldSize()
{
    const canvas = gui.patchView.patchRenderer.cgl.canvas;
    return { "w": canvas.clientWidth, "h": canvas.clientHeight };
}

// the ops of the subpatch currently shown in the patch field
function visiblePatchOps()
{
    const sub = gui.patchView.getCurrentSubPatch();
    return CABLES.patch.ops.filter((o) => (o.uiAttribs.subPatch || 0) == sub && !o.uiAttribs.hidden);
}

// viewbox zoom is half the visible width in patch units; scroll y is stored scaled by the aspect ratio
function setPatchView(x, y, zoom)
{
    const viewBox = gui.patchView.patchRenderer.viewBox;
    const size = patchFieldSize();

    if (zoom) viewBox.animateZoom(zoom);
    // as user interaction, otherwise the view is shifted to the part of the field not covered by panels, and x/y would not end up in the center
    if (x !== undefined && y !== undefined) viewBox.animateScrollTo(x, y * size.w / size.h, undefined, true);
}

function fitPatchView(ops)
{
    const bounds = gui.patchView.getOpBounds(ops);
    const size = patchFieldSize();

    const w = Math.max(bounds.size[0], PATCHFIELD_FIT_MIN_SIZE);
    const h = Math.max(bounds.size[1], PATCHFIELD_FIT_MIN_SIZE);
    const zoom = Math.max(w, h * size.w / size.h) / 2 * PATCHFIELD_FIT_PADDING;

    setPatchView(bounds.center[0], bounds.center[1], zoom);
}

// the visible area of the patch field in patch coordinates, as used by op positions (move-op / uiAttribs.translate)
function patchViewInfo()
{
    const glPatch = gui.patchView.patchRenderer;
    const size = patchFieldSize();
    const topLeft = glPatch.screenToPatchCoord(0, 0);
    const bottomRight = glPatch.screenToPatchCoord(size.w, size.h);
    const round = (v) => Math.round(v);

    return {
        "zoom": round(glPatch.viewBox.zoom),
        "subPatch": gui.patchView.getCurrentSubPatch(),
        "visible": { "x1": round(topLeft[0]), "y1": round(topLeft[1]), "x2": round(bottomRight[0]), "y2": round(bottomRight[1]) },
        "center": { "x": round((topLeft[0] + bottomRight[0]) / 2), "y": round((topLeft[1] + bottomRight[1]) / 2) },
        "fieldSize": size
    };
}

function snapUp(v, grid)
{
    return Math.ceil(v / grid) * grid;
}

function snapNearest(v, grid)
{
    return Math.round(v / grid) * grid;
}

// incoming links of an op that come from ops in the set, in port order
function linksFromSet(op, set)
{
    const result = [];
    for (const portIn of op.portsIn)
        for (const link of portIn.links)
            if (set.has(link.portOut.op)) result.push({ "parent": link.portOut.op, "portOut": link.portOut, "portIn": portIn });
    return result;
}

// the op above: the one linked to the first linked input port
function primaryParent(op, set)
{
    const links = linksFromSet(op, set);
    return links.length ? links[0].parent : null;
}

// rows by longest link path from the ops without parents in the set, so every op is below all ops linked to its inputs.
// null if the links form a cycle, then the paths never stop growing
function layerOps(ops, set, sideChains)
{
    const parentsOf = (o) => linksFromSet(o, set).map((l) => l.parent).concat(sideChains.has(o) ? [sideChains.get(o).above] : []);
    const layer = new Map(ops.map((o) => [o, 0]));
    for (let pass = 0; pass <= ops.length; pass++)
    {
        let changed = false;
        for (const o of ops)
            for (const parent of parentsOf(o))
                if (layer.get(o) < layer.get(parent) + 1)
                {
                    layer.set(o, layer.get(parent) + 1);
                    changed = true;
                }

        if (!changed)
        {
            pullDownToChildren(ops, set, layer, sideChains);
            const layers = [];
            for (const o of ops) (layers[layer.get(o)] = layers[layer.get(o)] || []).push(o);
            return layers.filter(Boolean);
        }
    }
    return null;
}

// the distinct ops in the set linked to the outputs of op, in the order of its output links
function childOpsInSet(op, set)
{
    const children = [];
    for (const portOut of op.portsOut)
        for (const link of portOut.links)
            if (set.has(link.portIn.op) && !children.includes(link.portIn.op)) children.push(link.portIn.op);
    return children;
}

// connected ops as close as possible: every op with children moves down to the row right above its highest child
function pullDownToChildren(ops, set, layer, sideChains)
{
    const children = new Map(ops.map((o) => [o, childOpsInSet(o, set)]));
    for (const [source, sideChain] of sideChains) children.get(sideChain.above).push(source);
    for (let pass = 0; pass <= ops.length; pass++)
    {
        let changed = false;
        for (const o of ops)
        {
            if (!children.get(o).length) continue;
            const above = Math.min(...children.get(o).map((c) => layer.get(c))) - 1;
            if (layer.get(o) < above)
            {
                layer.set(o, above);
                changed = true;
            }
        }
        if (!changed) return;
    }
}

// moves rect to the nearest spot, in grid steps, where it is not too close to any placed rect. it can always move right and down,
// left and up only if allowed. returns false if there is no free spot within the search distance
function moveToNearestFreeSpot(rect, placed, allowLeft, allowUp)
{
    const startX = rect.x;
    const startY = rect.y;
    for (let distance = 0; distance <= CLEANUP_MAX_SHIFT_STEPS; distance++)
        for (let stepsY = 0; stepsY <= distance; stepsY++)
        {
            const stepsX = distance - stepsY;
            for (const dirX of stepsX ? [1, -1] : [1])
                for (const dirY of stepsY ? [1, -1] : [1])
                {
                    if ((dirX < 0 && !allowLeft) || (dirY < 0 && !allowUp)) continue;
                    rect.x = startX + dirX * stepsX * CLEANUP_GRID_X;
                    rect.y = startY + dirY * stepsY * CLEANUP_GRID_Y;
                    if (!placed.some((p) => rectsTooClose(rect, p))) return true;
                }
        }
    return false;
}

function snapDown(v, grid)
{
    return Math.floor(v / grid) * grid;
}

// side chains: a linear chain of ops starting at a source op (no parents) that feeds a not-first input of another op, the anchor
// (e.g. Timer -> CircleCoordinates -> Transform.posX). it goes between the anchor and the op above the anchor, which is placed first.
// returns a map source op -> { chain, anchor, link, above }
function findSideChains(ops, set)
{
    const sideChains = new Map();
    const inChain = new Set();
    for (const anchor of ops)
    {
        const above = primaryParent(anchor, set);
        if (!above) continue;

        for (const link of linksFromSet(anchor, set))
        {
            const last = link.parent;
            if (last == above || inChain.has(last)) continue;
            if (childOpsInSet(last, set).length != 1 && linksFromSet(last, set).length) continue;

            const chain = [last];
            for (;;)
            {
                const parents = [...new Set(linksFromSet(chain[0], set).map((l) => l.parent))];
                if (parents.length != 1 || parents[0] == above || chain.includes(parents[0]) || childOpsInSet(parents[0], set).length != 1) break;
                chain.unshift(parents[0]);
            }
            chain.forEach((o) => inChain.add(o));
            sideChains.set(chain[0], { "chain": chain, "anchor": anchor, "link": link, "above": above });
        }
    }
    return sideChains;
}

// a side chain source right below the op above its anchor, with the chain's output port above the input of the anchor it feeds,
// so the anchor moves down below the chain and no cable crosses the op above
function sideChainRect(source, sideChain, set, pos, fanSlots)
{
    const above = pos.get(sideChain.above);
    const last = sideChain.chain[sideChain.chain.length - 1];
    const chainOffset = sideChain.chain.slice(1).reduce((sum, o) => sum + childOffsetX(o, set), 0);
    const x = childX(sideChain.anchor, set, pos, fanSlots) + portCenterX(sideChain.anchor, sideChain.link.portIn) - portCenterX(last, sideChain.link.portOut) - chainOffset;
    const parentsBottom = linksFromSet(source, set).map((l) => pos.get(l.parent).y + pos.get(l.parent).h + childGap(l.parent, set));
    return opRect(source, snapNearest(x, CLEANUP_GRID_X), snapUp(Math.max(above.y + above.h + CLEANUP_GAP_Y, ...parentsBottom), CLEANUP_GRID_Y));
}

// other source ops go right above their highest child, using the positions of a first layout pass. returns a map source op -> { x, y }
function sourceHints(ops, set, firstPos, sideChains)
{
    const hints = new Map();
    for (const source of ops)
    {
        if (!selectedSet.has(source) || primaryParent(source, set) || sideChains.has(source)) continue;
        const sourceChildren = childOpsInSet(source, set);
        if (!sourceChildren.length) continue;

        const first = firstPos.get(source);
        const highestChild = Math.min(...sourceChildren.map((c) => firstPos.get(c).y));
        hints.set(source, { "x": first.x, "y": snapDown(highestChild - first.h - childGap(source, set), CLEANUP_GRID_Y) });
    }
    return hints;
}

// position of the link to child among all outgoing links of parent, so split children keep the order of the parent's ports
function outLinkIndex(parent, child)
{
    let index = 0;
    for (const portOut of parent.portsOut)
        for (const link of portOut.links)
        {
            if (link.portIn.op == child) return index;
            index++;
        }
    return index;
}

// distance to the ops below grows with the number of outgoing links: 2 links 2 op heights, up to 5 op heights at 10 links
function childGap(parent, set)
{
    const links = parent.portsOut.reduce((sum, p) => sum + p.links.filter((l) => set.has(l.portIn.op)).length, 0);
    if (links < CLEANUP_LINK_GAP_MIN_LINKS) return CLEANUP_GAP_Y;

    const t = (Math.min(links, CLEANUP_LINK_GAP_MAX_LINKS) - CLEANUP_LINK_GAP_MIN_LINKS) / (CLEANUP_LINK_GAP_MAX_LINKS - CLEANUP_LINK_GAP_MIN_LINKS);
    return (CLEANUP_LINK_GAP_MIN_OPS + t * (CLEANUP_LINK_GAP_MAX_OPS - CLEANUP_LINK_GAP_MIN_OPS)) * CLEANUP_OP_HEIGHT;
}

function rectsTooClose(a, b)
{
    return a.x < b.x + b.w + CLEANUP_GAP_X && b.x < a.x + a.w + CLEANUP_GAP_X && a.y < b.y + b.h + CLEANUP_GAP_Y && b.y < a.y + a.h + CLEANUP_GAP_Y;
}

function opRect(o, x = o.uiAttribs.translate.x, y = o.uiAttribs.translate.y)
{
    const glOp = gui.patchView.patchRenderer.getGlOp(o);
    return { "x": x, "y": y, "w": glOp.w, "h": glOp.h };
}

// right below the lowest of its parents, further below a parent it is one of many children of (fan), so the cables are visible;
// source ops at their hint, without any links at their old y, otherwise at startY
function opY(o, set, pos, startY, hints, fanSlots)
{
    const fanParent = fanSlots.has(o) ? fanSlots.get(o).parent : null;
    const links = linksFromSet(o, set);
    if (links.length) return snapUp(Math.max(...links.map((l) =>
    {
        const p = pos.get(l.parent);
        return p.y + p.h + childGap(l.parent, set);
    })), CLEANUP_GRID_Y);
    if (hints.has(o)) return hints.get(o).y;
    if (!childOpsInSet(o, set).length) return snapNearest(o.uiAttribs.translate.y, CLEANUP_GRID_Y);
    return startY;
}

// places the ops row by row: every op at the x of the op above until it splits, split children side by side in port order,
// source ops at their hint or their old x. an op in the way of another moves to the nearest free x. snapped to the grid.
// returns a map op -> { x, y, w, h }, or a string why it is not possible
function placeOps(layers, set, startY, hints, sideChains, fanRows)
{
    const placed = [...fixedRects];
    const pos = new Map();
    const fanSlots = new Map();
    lastFanSlots = fanSlots;
    const extents = new Map();
    const extentOf = (o) => subtreeExtent(o, set, sideChains, extents);

    for (const row of layers)
    {
        const desired = new Map();
        const order = new Map();
        for (const o of row)
        {
            const parent = primaryParent(o, set);
            if (!selectedSet.has(o)) desired.set(o, o.uiAttribs.translate.x);
            else if (sideChains.has(o)) desired.set(o, sideChainRect(o, sideChains.get(o), set, pos, fanSlots).x);
            else if (parent) desired.set(o, childX(o, set, pos, fanSlots));
            else desired.set(o, hints.has(o) ? hints.get(o).x : snapNearest(o.uiAttribs.translate.x, CLEANUP_GRID_X));
            order.set(o, parent ? outLinkIndex(parent, o) : 0);
        }
        row.sort((a, b) => (desired.get(a) - desired.get(b)) || (order.get(a) - order.get(b)) || (a.uiAttribs.translate.x - b.uiAttribs.translate.x));

        const lastChild = new Map();
        for (const o of row)
        {
            if (isUnconnected(o, set)) continue;
            if (!selectedSet.has(o))
            {
                pos.set(o, opRect(o));
                addFanSlots(o, pos.get(o), set, fanSlots, extentOf);
                continue;
            }
            const parent = primaryParent(o, set);
            const fanSlot = fanSlots.get(o);
            const sideChain = sideChains.get(o);
            const sibling = parent && !fanSlot && !sideChain ? lastChild.get(parent) : null;
            const rect = sideChain ? sideChainRect(o, sideChain, set, pos, fanSlots) : opRect(o, desired.get(o), opY(o, set, pos, startY, hints, fanSlots));
            if (sibling) rect.x = Math.max(rect.x, snapUp(siblingMinX(sibling, o, set, sideChains, extentOf), CLEANUP_GRID_X));
            if (fanSlot && fanRows.has(fanSlot.parent)) rect.y = Math.max(rect.y, snapUp(pos.get(fanSlot.parent).y + fanRows.get(fanSlot.parent), CLEANUP_GRID_Y));

            const allowLeft = !sibling && !(fanSlot && fanSlot.index > 0);
            if (!moveToNearestFreeSpot(rect, placed, allowLeft, !parent && !sideChain)) return "no free place found for op " + o.id + " (" + o.getTitle() + ")";
            placed.push(rect);
            pos.set(o, rect);
            if (parent && !fanSlot && !sideChain) lastChild.set(parent, { "x": rect.x, "op": o });
            addFanSlots(o, rect, set, fanSlots, extentOf);
        }
    }

    // unconnected ops last, at the free spot nearest to where they were, so they do not block the connected ones
    for (const o of layers.flat().filter((op) => isUnconnected(op, set)))
    {
        if (!selectedSet.has(o))
        {
            pos.set(o, opRect(o));
            continue;
        }
        const rect = opRect(o, snapNearest(o.uiAttribs.translate.x, CLEANUP_GRID_X), snapNearest(o.uiAttribs.translate.y, CLEANUP_GRID_Y));
        if (!moveToNearestFreeSpot(rect, placed, true, true)) return "no free place found for op " + o.id + " (" + o.getTitle() + ")";
        placed.push(rect);
        pos.set(o, rect);
    }
    return pos;
}

function isUnconnected(o, set)
{
    return !linksFromSet(o, set).length && !childOpsInSet(o, set).length;
}

function portCenterX(op, port)
{
    return op.getPortPosX(port.name, null, true) || 0;
}

// x below the op above: in a fan slot if it is one of many children of one output port, at the same x if it is linked by its first input port,
// otherwise with its input port right below the output port, so the cable is straight
function childX(o, set, pos, fanSlots)
{
    if (fanSlots.has(o)) return fanSlots.get(o).x;
    return snapNearest(pos.get(primaryParent(o, set)).x + childOffsetX(o, set), CLEANUP_GRID_X);
}

// the children of op that hang below it (op is the op above them), per output port in link order, each child only once
function childrenByPort(op, set)
{
    const seen = new Set();
    return op.portsOut.map((portOut) => ({
        "portOut": portOut,
        "children": portOut.links.map((l) => l.portIn.op).filter((c) =>
        {
            if (seen.has(c) || !set.has(c) || primaryParent(c, set) != op || sideChainTops.has(c)) return false;
            seen.add(c);
            return true;
        })
    }));
}

// x of a child relative to the op above it: the same x if linked by its first input port, otherwise its input port below the output port
function childOffsetX(child, set)
{
    const link = linksFromSet(child, set)[0];
    return portCenterX(link.parent, link.portOut) - portCenterX(child, link.portIn);
}

// the horizontal room an op and everything hanging below it need (side chains, fans, children side by side),
// relative to its x and laid out like placeOps does, so neighbouring columns do not run into each other. returns { left, right }
function subtreeExtent(o, set, sideChains, memo)
{
    if (memo.has(o)) return memo.get(o);
    const ext = { "left": 0, "right": opRect(o).w };
    memo.set(o, ext);

    for (const sideChain of sideChains.values())
    {
        if (sideChain.anchor != o) continue;
        const last = sideChain.chain[sideChain.chain.length - 1];
        const x = portCenterX(o, sideChain.link.portIn) - portCenterX(last, sideChain.link.portOut);
        ext.left = Math.min(ext.left, x);
        ext.right = Math.max(ext.right, x + Math.max(...sideChain.chain.map((c) => opRect(c).w)));
    }

    let prev = null;
    for (const { portOut, children } of childrenByPort(o, set))
    {
        if (children.length >= CLEANUP_FANOUT_MIN_CHILDREN)
        {
            const total = children.reduce((sum, c) => sum + extentWidth(subtreeExtent(c, set, sideChains, memo)), 0) + (children.length - 1) * CLEANUP_FANOUT_GAP_X;
            const start = portCenterX(o, portOut) - total / 2;
            ext.left = Math.min(ext.left, start);
            ext.right = Math.max(ext.right, start + total);
            continue;
        }

        for (const child of children)
        {
            const childExt = subtreeExtent(child, set, sideChains, memo);
            let x = childOffsetX(child, set);
            if (prev) x = Math.max(x, siblingMinX(prev, child, set, sideChains, (c) => subtreeExtent(c, set, sideChains, memo)));
            ext.left = Math.min(ext.left, x + childExt.left);
            ext.right = Math.max(ext.right, x + childExt.right);
            prev = { "x": x, "op": child };
        }
    }
    return ext;
}

function extentWidth(ext)
{
    return ext.right - ext.left;
}

// number of ops in the branch below an op, including its side chains
function subtreeSize(o, set, sideChains)
{
    let size = 1;
    for (const sideChain of sideChains.values()) if (sideChain.anchor == o) size += sideChain.chain.length;
    for (const { children } of childrenByPort(o, set)) for (const c of children) size += subtreeSize(c, set, sideChains);
    return size;
}

// leftmost x of a child next to its previous sibling prev { x, op }: next to the previous sibling's whole branch,
// but a much smaller branch goes right next to the previous sibling op, so it stays close to its parent
function siblingMinX(prev, o, set, sideChains, extentOf)
{
    const small = subtreeSize(o, set, sideChains) * CLEANUP_SMALL_BRANCH_FACTOR <= subtreeSize(prev.op, set, sideChains);
    const prevRight = small ? prev.x + opRect(prev.op).w : prev.x + extentOf(prev.op).right;
    return prevRight + CLEANUP_GAP_X - extentOf(o).left;
}

// many children on one output port are spread with a wider gap, so the cables are visible, and centered below that port.
// every child gets the room of its whole subtree
function addFanSlots(op, rect, set, fanSlots, extentOf)
{
    for (const { portOut, children } of childrenByPort(op, set))
    {
        if (children.length < CLEANUP_FANOUT_MIN_CHILDREN) continue;

        const extents = children.map(extentOf);
        const total = extents.reduce((sum, e) => sum + extentWidth(e), 0) + (children.length - 1) * CLEANUP_FANOUT_GAP_X;
        let x = rect.x + portCenterX(op, portOut) - total / 2;
        children.forEach((c, i) =>
        {
            fanSlots.set(c, { "x": snapNearest(x - extents[i].left, CLEANUP_GRID_X), "index": i, "parent": op });
            x += extentWidth(extents[i]) + CLEANUP_FANOUT_GAP_X;
        });
    }
}

// rows following the links with connected ops as close together as possible. other ops in the way are handled by makeRoomBelow.
// a first pass finds where the ops fed by side chains end up, the second pass puts the side chains next to them.
// returns a map op -> { x, y, w, h }, or a string why the layout is not possible
function layoutGroup(ops)
{
    const set = new Set(ops);
    let sideChains = findSideChains(ops, set);
    let layers = layerOps(ops, set, sideChains);
    if (!layers)
    {
        sideChains = new Map();
        layers = layerOps(ops, set, sideChains);
    }
    sideChainTops = new Set(sideChains.keys());
    if (!layers) return "the links between the ops form a cycle";

    const startY = snapNearest(Math.min(...ops.map((o) => o.uiAttribs.translate.y)), CLEANUP_GRID_Y);
    const firstPos = placeOps(layers, set, startY, new Map(), sideChains, new Map());
    if (typeof firstPos == "string") return firstPos;

    // all children of a fan in one row, as far below the fan op as the lowest of them was in the first pass
    const fanRows = new Map();
    for (const [child, slot] of lastFanSlots)
    {
        const dy = firstPos.get(child).y - firstPos.get(slot.parent).y;
        fanRows.set(slot.parent, Math.max(fanRows.has(slot.parent) ? fanRows.get(slot.parent) : dy, dy));
    }

    return placeOps(layers, set, startY, sourceHints(ops, set, firstPos, sideChains), sideChains, fanRows);
}

// groups of ops that are linked with each other, biggest first
function connectedGroups(ops, set)
{
    const groupOf = new Map();
    const groups = [];
    for (const start of ops)
    {
        if (groupOf.has(start)) continue;
        const group = [];
        const todo = [start];
        groupOf.set(start, group);
        while (todo.length)
        {
            const o = todo.pop();
            group.push(o);
            const linked = linksFromSet(o, set).map((l) => l.parent).concat(childOpsInSet(o, set));
            for (const other of linked)
                if (!groupOf.has(other))
                {
                    groupOf.set(other, group);
                    todo.push(other);
                }
        }
        groups.push(group);
    }
    return groups.sort((a, b) => b.length - a.length);
}

// every group of linked ops is laid out on its own, then placed as a block at the free spot nearest to where the group was,
// so unrelated groups do not push each other around
function layoutOps(ops)
{
    selectedSet = new Set(ops);
    const all = [...new Set(ops.concat(visiblePatchOps().filter((o) => o.uiAttribs.translate && gui.patchView.patchRenderer.getGlOp(o))))];
    fixedRects = all.filter((o) => !selectedSet.has(o)).map((o) => opRect(o));

    const result = new Map();
    for (const group of connectedGroups(all, new Set(all)))
    {
        if (!group.some((o) => selectedSet.has(o))) continue;

        const pos = layoutGroup(group);
        if (typeof pos == "string") return pos;

        for (const [o, p] of pos)
        {
            if (!selectedSet.has(o)) continue;
            result.set(o, p);
            fixedRects.push(p);
        }
    }
    return result;
}

// the other ops of the subpatch that the layout would touch, and all below their top, move down together until the layout is free.
// moving all of them by the same amount keeps their own layout and can not create new overlaps between them.
// returns a map op -> { x, y, w, h } of the ops to move
function makeRoomBelow(pos)
{
    const layout = [...pos.values()];
    const others = visiblePatchOps()
        .filter((o) => !pos.has(o) && o.uiAttribs.translate && gui.patchView.patchRenderer.getGlOp(o))
        .map((o) => ({ "op": o, "rect": opRect(o) }));

    const touching = others.filter((o) => layout.some((p) => rectsTooClose(o.rect, p)));
    if (!touching.length) return new Map();

    const top = Math.min(...touching.map((o) => o.rect.y));
    const below = others.filter((o) => o.rect.y >= top);

    const left = Math.min(...layout.map((p) => p.x));
    const right = Math.max(...layout.map((p) => p.x + p.w));
    const bottom = Math.max(...layout.map((p) => p.y + p.h));
    const inColumn = below.filter((o) => o.rect.x < right + CLEANUP_GAP_X && left < o.rect.x + o.rect.w + CLEANUP_GAP_X);
    const shift = snapUp(Math.max(...inColumn.map((o) => bottom + CLEANUP_GAP_Y - o.rect.y)), CLEANUP_GRID_Y);

    return new Map(below.map((o) => [o.op, { ...o.rect, "y": o.rect.y + shift }]));
}

// moves the ops to their new positions as one undo step, returns the number of moved ops
function applyOpPositions(pos)
{
    let moved = 0;
    const undoGroup = CABLES.UI.undo.startGroup();
    for (const [o, p] of pos)
    {
        if (o.uiAttribs.translate.x == p.x && o.uiAttribs.translate.y == p.y) continue;
        gui.patchView.setOpPos(o, p.x, p.y);
        moved++;
    }
    CABLES.UI.undo.endGroup(undoGroup, "Tidy up ops");
    return moved;
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

// console capture through the chrome devtools protocol, the only way to also get browser messages like
// webgl warnings, which never pass through console.*. needs electron started with --remote-debugging-port
function getJson(url)
{
    return new Promise((resolve, reject) =>
    {
        http.get(url, (res) =>
        {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () =>
            {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(e); }
            });
        }).on("error", reject);
    });
}

function addConsoleEntry(level, source, text, timestamp, url, line)
{
    const entry = { "timestamp": timestamp || Date.now(), "level": level, "source": source, "text": text };
    if (url) entry.location = url.split("/").pop() + (line !== undefined ? ":" + line : "");

    consoleEntries.push(entry);
    if (consoleEntries.length > CONSOLE_MAX_ENTRIES) consoleEntries.shift();
}

function remoteObjectToString(obj)
{
    if (obj.value !== undefined) return typeof obj.value == "string" ? obj.value : JSON.stringify(obj.value);
    return obj.description || obj.type;
}

// console args as one line, %c styling placeholders and their css arguments are dropped
function consoleArgsToString(args)
{
    const strs = args.map(remoteObjectToString);
    if (strs.length && typeof args[0].value == "string" && args[0].value.includes("%c"))
    {
        const numStyles = args[0].value.split("%c").length - 1;
        strs.splice(1, numStyles);
        strs[0] = strs[0].replace(/%c/g, "");
    }
    return strs.join(" ");
}

function onDevToolsMessage(data)
{
    const msg = JSON.parse(String(data));
    const params = msg.params;

    if (msg.method == "Log.entryAdded")
    {
        const e = params.entry;
        addConsoleEntry(e.level, e.source, e.text, e.timestamp, e.url, e.lineNumber);
    }
    else if (msg.method == "Runtime.consoleAPICalled")
    {
        const frame = params.stackTrace && params.stackTrace.callFrames[0];
        addConsoleEntry(CONSOLE_API_LEVELS[params.type] || "info", "console", consoleArgsToString(params.args), params.timestamp, frame && frame.url, frame && frame.lineNumber + 1);
    }
    else if (msg.method == "Runtime.exceptionThrown")
    {
        const d = params.exceptionDetails;
        addConsoleEntry("error", "exception", d.exception ? d.exception.description : d.text, params.timestamp, d.url, d.lineNumber + 1);
    }
}

async function openDevToolsSocket()
{
    let targets;
    try
    {
        targets = await getJson("http://127.0.0.1:" + DEVTOOLS_PORT + "/json");
    }
    catch (e)
    {
        throw new Error("devtools port " + DEVTOOLS_PORT + " not reachable (" + e.message + "), start electron with: npm run start -- --remote-debugging-port=" + DEVTOOLS_PORT);
    }

    // the editor runs in an iframe of the electron page, its messages arrive through the page's target
    const pageUrl = window.top.location.href.split("#")[0];
    const target = targets.find((t) => t.type == "page" && t.url.split("#")[0] == pageUrl);
    if (!target) throw new Error("no devtools target found for " + pageUrl + ", targets: " + targets.map((t) => t.type + " " + t.url).join(", "));

    const WebSocket = op.require("ws");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) =>
    {
        socket.once("open", resolve);
        socket.once("error", reject);
    });

    socket.on("message", onDevToolsMessage);
    socket.on("close", () => { if (devToolsSocket === socket) devToolsSocket = null; });

    // enabling replays the messages logged so far, so start with an empty list
    consoleEntries.length = 0;
    let msgId = 0;
    for (const method of ["Log.enable", "Runtime.enable"]) socket.send(JSON.stringify({ "id": ++msgId, "method": method }));

    devToolsSocket = socket;
}

function connectDevTools()
{
    if (devToolsSocket) return Promise.resolve();
    if (!devToolsConnecting) devToolsConnecting = openDevToolsSocket().finally(() => { devToolsConnecting = null; });
    return devToolsConnecting;
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

function linkLabel(port)
{
    return port.op.id + "." + port.name;
}

function isPlainValuePort(port)
{
    const type = port.getType();
    return type == CABLES.Port.TYPE_VALUE || type == CABLES.Port.TYPE_STRING;
}

function changedPortValues(o)
{
    const values = [];
    for (let i = 0; i < o.portsIn.length; i++)
    {
        const p = o.portsIn[i];
        if (!isPlainValuePort(p) || p.links.length > 0 || p.get() === p.defaultValue) continue;
        values.push(p.name + "=" + JSON.stringify(p.get()));
    }
    return values;
}

function patchOverviewLines(subPatch, filter, withValues)
{
    const lines = [];
    const lowerFilter = (filter || "").toLowerCase();
    const ops = CABLES.patch.ops;

    for (let i = 0; i < ops.length; i++)
    {
        const o = ops[i];
        const opSubPatch = o.uiAttribs.subPatch || "0";
        if (subPatch !== undefined && opSubPatch != subPatch) continue;
        if (lowerFilter && (o.objName + " " + o.getTitle()).toLowerCase().indexOf(lowerFilter) == -1) continue;

        let head = o.id + " " + o.objName;
        if (o.getTitle() != o.objName.split(".").pop()) head += " \"" + o.getTitle() + "\"";
        if (o.uiAttribs.extendTitle) head += " (" + o.uiAttribs.extendTitle + ")";
        if (opSubPatch != "0") head += " sub:" + opSubPatch;
        lines.push(head);

        const incoming = [];
        for (let j = 0; j < o.portsIn.length; j++)
            for (let k = 0; k < o.portsIn[j].links.length; k++)
                incoming.push(o.portsIn[j].name + ": " + linkLabel(o.portsIn[j].links[k].portOut));

        const outgoing = [];
        for (let j = 0; j < o.portsOut.length; j++)
            for (let k = 0; k < o.portsOut[j].links.length; k++)
                outgoing.push(o.portsOut[j].name + ": " + linkLabel(o.portsOut[j].links[k].portIn));

        if (incoming.length) lines.push("  <- " + incoming.join(", "));
        if (outgoing.length) lines.push("  -> " + outgoing.join(", "));

        if (withValues)
        {
            const values = changedPortValues(o);
            if (values.length) lines.push("  = " + values.join(", "));
        }
    }
    return lines;
}

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
        "read-op",
        "read the code of an op (or one of its attachments, att_ prefix optional) with line numbers, much cheaper than reading the whole file: fromLine/toLine limit it to a range of lines, find only lists the lines containing that text. use edit-op-text to change it.",
        { "opname": z.string(), "attachment": z.string().optional(), "fromLine": z.number().optional(), "toLine": z.number().optional(), "find": z.string().optional() },
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
        "change the code of an op (or one of its attachments, att_ prefix optional) by replacing oldText with newText, without sending the whole file. oldText has to match exactly once (copy it from read-op without the line numbers, include enough surrounding lines to make it unique), or pass replaceAll=true to replace every occurrence. the op is saved and re-executed afterwards.",
        { "opname": z.string(), "attachment": z.string().optional(), "oldText": z.string(), "newText": z.string(), "replaceAll": z.boolean().optional() },
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
        "search through all available ops, best matches first, one per line as \"name: summary\". limit is the number of results (default " + SEARCH_DEFAULT_LIMIT + ", 0 = all). use get-op-docs for ports and docs, read-op for the source.",
        { "str": z.string(), "limit": z.number().optional() },
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
        "create-op",
        "create a new op by its full name (e.g. Ops.Extension.ShaderGraph.Sdf.Sphere, the name decides where it is stored), optionally with its code and attachments as { \"att_name\": content } (att_ prefix optional). add it to the patch with add-op afterwards.",
        { "opname": z.string(), "code": z.string().optional(), "attachments": z.record(z.string()).optional() },
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
        "list the attachment files of an op (e.g. att_inc_node.js, att_shader.vert), by full op name. read them with read-op-attachment, change them with write-op-attachment.",
        { "opname": z.string() },
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
        "read the content of an op attachment file by full op name and attachment name (e.g. att_inc_node.js, the att_ prefix is optional); see list-op-attachments",
        { "opname": z.string(), "name": z.string() },
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
        "write the full content of an op attachment file (the att_ prefix is optional), creating it if the op does not have it yet. att_inc_*.js files are included into the op code, other attachments are available in the op as attachments.<name> (dots replaced by _). by default the op is re-executed afterwards so all instances in the patch use the new code; pass execute=false when writing several attachments and only execute on the last one.",
        { "opname": z.string(), "name": z.string(), "content": z.string(), "execute": z.boolean().optional() },
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
        "upload-file",
        "upload a file into the patch's asset folder, either downloaded by the editor from a url (the server must allow cors) or from base64 content. returns the path to use in file ports, e.g. the File port of Ops.Gl.Texture_v3.",
        { "filename": z.string(), "url": z.string().optional(), "base64": z.string().optional() },
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
        "timeline",
        "control the timeline: play (true plays, false pauses) and time (jump to a time in seconds). without arguments it only reports the current time and whether it is playing. animated ports and Ops.TimeLine.* ops follow this time.",
        { "play": z.boolean().optional(), "time": z.number().optional() },
        ({ play, time }) =>
        {
            const timer = CABLES.patch.timer;
            logMcp("timeline" + (play !== undefined ? (play ? " play" : " pause") : "") + (time !== undefined ? " time " + time : ""));

            if (time !== undefined) timer.setTime(time);
            if (play === true) timer.play();
            if (play === false) timer.pause();

            return respondText(JSON.stringify({ "time": round3(timer.getTime()), "playing": timer.isPlaying() }));
        }
    );

    server.tool(
        "set-port-animated",
        "make a number input port animated (keyframed by the timeline) or not animated anymore. a newly animated port gets a first keyframe with its current value at the current timeline time. undoable. the same way Ops.TimeLine.Anim has an animated \"Value\" port whose anim can be reused by linking its \"Anim\" output to several Ops.TimeLine.AnimGetValue ops.",
        { "opId": z.string(), "portName": z.string(), "animated": z.boolean() },
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
        "get the animation of a port: whether it is animated, its keyframes (time in seconds, value, easing), loop mode, length (time of the last keyframe), the current timeline time and the value at that time.",
        { "opId": z.string(), "portName": z.string() },
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
        "delete keyframes of an animated port by their times in seconds (see get-anim). an animation needs at least one key, to remove the whole animation use set-port-animated with animated=false. undoable as one step.",
        { "opId": z.string(), "portName": z.string(), "times": z.array(z.number()) },
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
        "patch-view",
        "scroll/zoom the patch field (the editor's op graph, not the rendering canvas). fit=true zooms to show all ops of the current subpatch, opIds fits the view to those ops, x/y center the view on a patch coordinate (the same coordinates as op positions), zoom is half the visible width in patch units (bigger = further out). without arguments it only reports the current view. returns the visible area in patch coordinates. take a look with patch-field-screenshot.",
        { "fit": z.boolean().optional(), "opIds": z.array(z.string()).optional(), "x": z.number().optional(), "y": z.number().optional(), "zoom": z.number().optional() },
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
        "take a screenshot of the patch field (the editor's op graph with ops and links, not the rendering canvas) as a png image. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size). use patch-view to scroll/zoom first; panels on top of the patch field are not in the image.",
        { "maxSize": z.number().optional() },
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
        "tidy-up-ops",
        "tidy up the layout of ops: arranges them in rows following their links (every op below all ops linked to its inputs), each op at the x of the op above until the links split, split children side by side in port order. ops never overlap. unselected ops are never moved, the selected ops are placed around them. links may cross. snapped to the grid. works on the selected ops, or on opIds; all have to be in the current subpatch. undoable as one step. if no valid layout is found (link cycle, no free place) nothing is changed and the reason is returned.",
        { "opIds": z.array(z.string()).optional(), "dryRun": z.boolean().optional() },
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
        "temporary: debug info of an op's glop (size, area size)",
        { "opId": z.string() },
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
            return respondText(JSON.stringify({
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
        "set the comment of an op in the patch by its id, shown next to its title in the patch editor (the same as the comment field in the param panel). an empty comment removes it. undoable.",
        { "opId": z.string(), "comment": z.string() },
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
        "get-patch-overview",
        "compact overview of the current patch, much smaller than cables://patch.json: one line per op with its id, full op name (objName), title and subpatch, followed by its incoming (<-) and outgoing (->) links as port: opId.port. no port values unless values=true, then only the values that differ from the op's defaults (linked ports left out). optional subPatch limits it to one subpatch, filter to ops whose name or title contains the text. use get-patch-op for all values of a single op.",
        { "subPatch": z.string().optional(), "filter": z.string().optional(), "values": z.boolean().optional() },
        ({ subPatch, filter, values }) =>
        {
            logMcp("patch overview" + (filter ? " \"" + filter + "\"" : ""));

            const lines = patchOverviewLines(subPatch, filter, values);
            return respondText(lines.length ? lines.join("\n") : "no ops found");
        }
    );

    server.tool(
        "select-op",
        "select ops in the patch editor, like clicking them. commands from run-command act on the selected ops. opIds is a list of op ids, add true keeps the current selection, otherwise it is cleared first.",
        { "opIds": z.array(z.string()), "add": z.boolean().optional() },
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
        "set-patch-name",
        "rename the current patch (its title), the same as the editor's patch title dialog. the new name is stored right away, no save-patch needed.",
        { "name": z.string() },
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
        "read the editor's console: console.log/warn/error, uncaught exceptions and browser messages like the yellow webgl warnings (GL_INVALID_OPERATION...). needs electron started with --remote-debugging-port=9222. minLevel: verbose, info, warning or error (default info). optional str filters by text, limit is the number of newest entries (default 100), clear empties the list afterwards.",
        { "minLevel": z.enum(CONSOLE_LEVELS).optional(), "str": z.string().optional(), "limit": z.number().optional(), "clear": z.boolean().optional() },
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
        "take a screenshot of the patch's rendering canvas and return it as a png image; use it to check what a change looks like. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size); larger images cost more tokens.",
        { "maxSize": z.number().optional() },
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

    server.tool(
        "get-patch-op",
        "get one op instance from the current patch as serialized json, by its op id (see cables://patch.json for op ids): its current port values, uiAttribs, storage and outgoing links (incoming links are stored on the op they come from). this is the op as it is used in the patch, not its documentation (use get-op-docs for that) and not its source code (use cables://op/<name>).",
        { "opId": z.string() },
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
        "list what the editor is loading: \"ui\" are editor jobs (the ui loading indicator, e.g. loading op code or docs), \"patch\" are asset loading tasks started by ops in the patch (e.g. textures, files, libs). running entries show how long they have been running, one running for a long time is probably stuck. optional numFinished also lists the most recent finished entries of both with their duration.",
        { "numFinished": z.number().optional() },
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
        "build info of the code that is running in the editor right now (compiled into the bundles, not read from disk): when the ui and core were built and from which git commit. ageSeconds is how long ago that was. use it after reloading the editor to check that a change is live: created has to be newer than the edit. serverStarted is when this mcp server started (changes with every editor reload), loading/runningJobs tell if the editor or patch is still loading.",
        {},
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
            for (let i = 0; i < uiJobs.length; i++) if (!uiJobs[i].finished) runningJobs++;
            const patchTasks = gui.corePatch().loading.getList();
            for (let i = 0; i < patchTasks.length; i++) if (!patchTasks[i].finished) runningJobs++;

            return respondText(JSON.stringify({
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
        "reload the whole editor page, e.g. to load newly built ui code. this mcp server restarts with it, so the answer only confirms the reload was triggered. afterwards poll get-build-info until it answers again with a newer serverStarted and loading false. with unsaved changes it does not reload (the editor would block on a leave-page dialog) unless unsaved is \"save\" (save the patch first) or \"discard\" (reload without saving, the changes are lost).",
        { "unsaved": z.enum(["save", "discard"]).optional() },
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
        "clear the editor's ui profiler and start measuring from now on (the same data as the ui profiler tab). every gui.uiProfiler.start(name)/finish() in the ui code is one measurement. do the actions to measure afterwards (e.g. select ops, drag, reload), then read the result with ui-profiler-read.",
        {},
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
        "read the ui profiler measurements since ui-profiler-start: per measured name the count, average/max/last time in ms (over the most recent times the profiler keeps, see keptTimes) and estTotalMs (count * average). sorted by estTotalMs, so the biggest cost is first. optional filter only lists names containing that text, limit the number of entries (default 30).",
        { "filter": z.string().optional(), "limit": z.number().optional() },
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
