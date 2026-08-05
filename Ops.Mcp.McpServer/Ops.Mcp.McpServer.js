const McpServer = op.require("@modelcontextprotocol/sdk/server/mcp.js");
const StreamableHTTPServerTransport = op.require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const http = op.require("node:http");
const { z } = op.require("zod");

const
    inData = op.inTriggerButton("update"),
    outData = op.outObject("Data"),
  outLog=op.outString("Log");

let log="";
let logCount=0
buildMcpServer();

inData.onTriggered = () =>
{
    outData.set(getOpenTabData());
};

function getOpenTabData()
{
    const arr = [];

    arr.push({ "type": "text", "text": "files currently opened in cables editor" });
    for (let i = 0; i < gui.mainTabs.tabs.length; i++)
    {
        const tab = gui.mainTabs.tabs[i];
        console.log("tab", tab);
        if (tab.editor)
            arr.push({
                "type": "resource",
                "resource":
                {
                    "uri": "file:///" + tab.editor.options.name,
                    "name": tab.editor.options.name,
                    "title": tab.editor.options.title,

                    "type": tab.editor.options.type,
                    "syntax": tab.editor.options.syntax,
                    "text": tab.editor.getContent()
                }
            });
    }
    return arr;
}

function logMcp(_log)
{
  log=log+logCount+": "+_log+"\n";
  logCount++;
  outLog.set(log)
}

const s=new CABLES.UI.OpSearch()
s.buildList()

function buildMcpServer()
{
    const server = new McpServer.McpServer({ "name": "cables standalone mcp server", "version": "1.0.0" });

    server.tool(
        "get-opened-resources",
        "get currently opened files",
        { },
        () =>
        {
          logMcp("get-opened-resources");

            const data = { "content": [] };
            data.content = getOpenTabData();

outData.setRef({data:data})
            return data;
        }
    );



  server.tool(
      "edit-op",
        "open an op to edit and change it",
        { opname:z.string()},
        (opts) =>
        {

           gui.serverOps.edit(opts.opname, false, null, true);
            const data = { "content":[] };

outData.setRef({data:data})
            return data;
        }
    );


  server.tool(
      "search-ops",
        "search through a list of all available ops",
        { str:z.string()},
        (str) =>
        {
          logMcp("search ops: "+str.str);
s.search(str.str)
            const data = { "content":[] };
for(let i=0;i<s.list.length;i++){
if(s.list[i].score>0)data.content.push({type:"text",text:s.list[i].name+": "+s.list[i].summary})
  }

outData.setRef({data:data})
            // data.content = getOpenTabData();
            return data;
        }
    );

    server.tool(
        "set-opened-resources",
        "change content of an opened file",
        { "uri": z.string(), "text": z.string() },
        ({ uri, text }) =>
        {

          logMcp("set-opened-resources "+uri);
            let found = false;
            for (let i = 0; i < gui.mainTabs.tabs.length; i++)
            {
                const tab = gui.mainTabs.tabs[i];
                if (tab.editor && "file:///" + tab.editor.options.name === uri)
                {
                    tab.editor.setContent(text);
                    tab.editor.save();
                    found = true;
                    break;
                }
            }

            const data = { "content": [{ "type": "text", "text": found ? "content updated" : "no opened file matches uri " + uri }] };

outData.setRef({data:data})
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
    });

}, 500);

op.onDelete = () =>
{
    httpServer.close(() =>
    {
        console.log("Server closed");
    });

};
