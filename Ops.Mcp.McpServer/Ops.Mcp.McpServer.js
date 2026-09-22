const McpServer = op.require("@modelcontextprotocol/sdk/server/mcp.js");
const StreamableHTTPServerTransport = op.require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const http = op.require("node:http");
const { z } = op.require("zod");

const
    outStarted = op.outBoolNum("Started", false),
    outData = op.outObject("Last Request Data"),
    outLog = op.outString("Log","");

let log = "";
let logCount = 0;
let currentServer = null;
buildMcpServer();


console.log("hello");

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

// resolves any uri this server hands out (mcpfile:/// or cables://op/ or cables://patch.json) to { mimeType, text }
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
    if (uri === "cables://patch.json")
    {
        return { "mimeType": "application/json", "text": JSON.stringify(op.patch.serialize()) };
    }
    throw new Error("unsupported uri " + uri);
}

function logMcp(_log)
{
    log = log + logCount + ": " + _log + "\n";
    logCount++;
    outLog.set(log);
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

const s = new CABLES.UI.OpSearch();
s.buildList();

gui.mainTabs.on("onTabRemoved", () => { if (currentServer && currentServer.isConnected()) currentServer.sendResourceListChanged(); });
gui.mainTabs.on("onTabAdded", () => { if (currentServer && currentServer.isConnected()) currentServer.sendResourceListChanged(); });

function buildMcpServer()
{
    const server = new McpServer.McpServer({ "name": "cables standalone mcp server", "version": "1.0.0" });
    currentServer = server;

    console.log("server", server);

    // real MCP resources, for clients that browse/read via resources/list + resources/read
    server.registerResource(
        "open-tab",
        new McpServer.ResourceTemplate("mcpfile:///{name}", { "list": () => ({ "resources": listOpenTabResources() }) }),
        { "description": "a file currently opened in the cables code editor" },
        async (uri) =>
        {
            logMcp("read open-tab " + uri.href);
            const content = await readResourceContent(uri.href);
            const data = { "contents": [{ "uri": uri.href, ...content }] };
            outData.setRef({ "data": data });
            return data;
        }
    );

    server.registerResource(
        "patch json",
        new McpServer.ResourceTemplate("cables://patch.json", { "list": undefined }),
        { "description": "read-only structure and data of the current patch" },
        async (uri) =>
        {
             const content= op.patch.serialize() ;
            const data = { "contents": [{ "uri": uri.href, ...content }] };
            outData.setRef({ "data": data });
            return data;
        }
    );

    server.registerResource(
        "op-source",
        new McpServer.ResourceTemplate("cables://op/{opname}", { "list": undefined }),
        { "description": "read-only source code of a cables op; get op names from search-ops" },
        async (uri) =>
        {
            logMcp("read op-source " + uri.href);
            const content = await readResourceContent(uri.href);
            const data = { "contents": [{ "uri": uri.href, ...content }] };
            outData.setRef({ "data": data });
            return data;
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
            logMcp("list-resources");
            const data = { "content": listOpenTabResources().map((r) => ({ "type": "resource_link", ...r })) };
            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "read-resource",
        "read a resource by uri (mcpfile:///<name>, cables://op/<opname>, or cables://patch.json)",
        { "uri": z.string() },
        async ({ uri }) =>
        {
            logMcp("read-resource " + uri);
            const content = await readResourceContent(uri);
            const data = { "content": [{ "type": "text", "text": content.text }] };
            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "edit-op",
        "open an op to edit and change it",
        { "opname": z.string() },
        (opts) =>
        {
            gui.serverOps.edit(opts.opname, false, null, true);
            const data = { "content": [] };

            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "search-ops",
        "search through a list of all available ops; read cables://op/<name> to see an op's source",
        { "str": z.string() },
        (str) =>
        {
            logMcp("search ops: " + str.str);
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

            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "write-opened-resources",
        "change/write content of an opened file",
        { "uri": z.string(), "text": z.string() },
        ({ uri, text }) =>
        {
            logMcp("set-opened-resources " + uri);
            const tab = findOpenTab(uri.replace("mcpfile:///", ""));
            if (tab)
            {
                tab.editor.setContent(text);
                tab.editor.save();
            }

            const data = { "content": [{ "type": "text", "text": tab ? "content updated" : "no opened file matches uri " + uri }] };

            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "set-port-value",
        "set the value of a port on an op in the current patch; identify the op by its id and the port by its name (see get-patch / cables://patch.json for op ids and port names)",
        { "opId": z.string(), "portName": z.string(), "value": z.any() },
        ({ opId, portName, value }) =>
        {
            logMcp("set-port-value " + opId + "." + portName);

            const targetOp = op.patch.getOpById(opId);
            if (!targetOp)
            {
                const data = { "content": [{ "type": "text", "text": "no op found with id " + opId }] };
                outData.setRef({ "data": data });
                return data;
            }

            const port = targetOp.getPort(portName);
            if (!port)
            {
                const data = { "content": [{ "type": "text", "text": "no port named \"" + portName + "\" on op " + opId }] };
                outData.setRef({ "data": data });
                return data;
            }

            port.set(value);

            if(CABLES.UI&&gui.patchView.isCurrentOp(targetOp)) targetOp.refreshParams();

            const data = { "content": [{ "type": "text", "text": "set " + opId + "." + portName + " = " + JSON.stringify(value) }] };
            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "trigger-port",
        "trigger/execute a trigger-type port on an op directly, without needing anything connected to it; identify the op by its id and the port by its name (see cables://patch.json for op ids and port names). fails if the port is not a trigger port.",
        { "opId": z.string(), "portName": z.string() },
        ({ opId, portName }) =>
        {
            logMcp("trigger-port " + opId + "." + portName);

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp)
            {
                const data = { "content": [{ "type": "text", "text": "no op found with id " + opId }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            const port = targetOp.getPort(portName);
            if (!port)
            {
                const data = { "content": [{ "type": "text", "text": "no port named \"" + portName + "\" on op " + opId }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            if (port.getType() !== CABLES.Port.TYPE_TRIGGER)
            {
                const data = { "content": [{ "type": "text", "text": "port \"" + portName + "\" on op " + opId + " is not a trigger port" }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            // .trigger() only forwards along the port's own links, which is a no-op for a
            // port that has nothing wired to it. _onTriggered() is what the cables editor's
            // own UI calls when clicking a trigger button (params_listener.js) - it fires the
            // op's onTriggered handler directly, regardless of whether anything is linked.
            port._onTriggered();

            if (CABLES.UI && gui.patchView.isCurrentOp(targetOp)) targetOp.refreshParams();

            const data = { "content": [{ "type": "text", "text": "triggered " + opId + "." + portName }] };
            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "link-ports",
        "connect (link) an output port of one op to an input port of another op in the current patch; identify ops by id and ports by name (see cables://patch.json for op ids and port names)",
        { "opId1": z.string(), "portName1": z.string(), "opId2": z.string(), "portName2": z.string() },
        ({ opId1, portName1, opId2, portName2 }) =>
        {
            logMcp("link-ports " + opId1 + "." + portName1 + " -> " + opId2 + "." + portName2);

            const op1 = CABLES.patch.getOpById(opId1);
            if (!op1)
            {
                const data = { "content": [{ "type": "text", "text": "no op found with id " + opId1 }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            const op2 = CABLES.patch.getOpById(opId2);
            if (!op2)
            {
                const data = { "content": [{ "type": "text", "text": "no op found with id " + opId2 }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            if (!op1.getPort(portName1))
            {
                const data = { "content": [{ "type": "text", "text": "no port named \"" + portName1 + "\" on op " + opId1 }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            if (!op2.getPort(portName2))
            {
                const data = { "content": [{ "type": "text", "text": "no port named \"" + portName2 + "\" on op " + opId2 }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            const link = CABLES.patch.link(op1, portName1, op2, portName2);

            const data = link
                ? { "content": [{ "type": "text", "text": "linked " + opId1 + "." + portName1 + " -> " + opId2 + "." + portName2 }] }
                : { "content": [{ "type": "text", "text": "could not link " + opId1 + "." + portName1 + " -> " + opId2 + "." + portName2 + " (incompatible ports?)" }], "isError": true };

            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "add-op",
        "add a new op to the current patch by its full op name (objName), e.g. Ops.Anim.Timer_v2; get valid names from search-ops. returns the new op's id (use it with link-ports / set-port-value) and its port names. optional x/y place it in the patch editor view.",
        { "objName": z.string(), "x": z.number().optional(), "y": z.number().optional() },
        ({ objName, x, y }) =>
        {
            logMcp("add-op " + objName);

            const uiAttribs = {};
            if (x !== undefined || y !== undefined) uiAttribs.translate = { "x": x || 0, "y": y || 0 };

            let newOp;
            try
            {
                newOp = CABLES.patch.addOp(objName, uiAttribs);
            }
            catch (e)
            {
                const data = { "content": [{ "type": "text", "text": "could not add op \"" + objName + "\": " + e.message }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            if (!newOp)
            {
                const data = { "content": [{ "type": "text", "text": "could not add op \"" + objName + "\" (no such op? see search-ops)" }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            const portsIn = newOp.portsIn.map((p) => p.name);
            const portsOut = newOp.portsOut.map((p) => p.name);

            const data = { "content": [{ "type": "text", "text": "added " + objName + " with id " + newOp.id + "; portsIn: [" + portsIn.join(", ") + "]; portsOut: [" + portsOut.join(", ") + "]" }] };
            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "delete-op",
        "delete an op from the current patch by its id (see cables://patch.json for op ids); this also removes any links connected to it",
        { "opId": z.string() },
        ({ opId }) =>
        {
            logMcp("delete-op " + opId);

            const targetOp = CABLES.patch.getOpById(opId);
            if (!targetOp)
            {
                const data = { "content": [{ "type": "text", "text": "no op found with id " + opId }], "isError": true };
                outData.setRef({ "data": data });
                return data;
            }

            const objName = targetOp.objName;

            // CABLES.patch.deleteOp does not return a success value, so verify by checking
            // that the op is actually gone from the patch afterwards
            CABLES.patch.deleteOp(opId);
            const stillThere = !!CABLES.patch.getOpById(opId);

            const data = !stillThere
                ? { "content": [{ "type": "text", "text": "deleted " + objName + " (" + opId + ")" }] }
                : { "content": [{ "type": "text", "text": "could not delete op " + opId }], "isError": true };

            outData.setRef({ "data": data });
            return data;
        }
    );

    server.tool(
        "screenshot",
        "take a screenshot of the patch's rendering canvas and return it as a png image; use it to check what a change looks like.",
        { "maxWidth": z.number().optional() },
        async ({ maxWidth }) =>
        {
            logMcp("screenshot");

            let data;
            try
            {
                const png = await grabScreenshot(maxWidth || 1024);
                data = { "content": [{ "type": "image", "data": png, "mimeType": "image/png" }] };
            }
            catch (e)
            {
                data = { "content": [{ "type": "text", "text": "screenshot failed: " + e.message }], "isError": true };
            }

            outData.setRef({ "data": data });
            return data;
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
    httpServer.listen(3000, () =>
    {
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
