// reading and writing op code and attachments

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
    logMcp("saved " + opname + "/" + fileName);
    return created;
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
    logMcp("saved " + opname);
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
        gui.serverOps.execute(opname, () =>
        {
            clearTimeout(timeout);
            resolve();
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
