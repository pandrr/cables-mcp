const McpServer = op.require("@modelcontextprotocol/sdk/server/mcp.js");
const StreamableHTTPServerTransport = op.require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const http = op.require("node:http");
const { z } = op.require("zod");

const
    outStarted = op.outBoolNum("Started", false),
    outData = op.outObject("Last Request Data"),
    outLog = op.outString("Log");

let log = "";
let logCount = 0;
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

// resolves any uri this server hands out (mcpfile:/// or cables://op/) to { mimeType, text }
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
    throw new Error("unsupported uri " + uri);
}

function logMcp(_log)
{
    log = log + logCount + ": " + _log + "\n";
    logCount++;
    outLog.set(log);
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
        "read a resource by uri (mcpfile:///<name> or cables://op/<opname>)",
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
