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

// the include attachments of an op (att_inc_*.js), in the order they are put in front of its code
function includeFileNames(opname)
{
    const files = getOpDocOrThrow(opname).attachmentFiles || [];
    const names = [];
    for (let i = 0; i < files.length; i++)
        if (files[i].startsWith("att_inc_")) names.push(files[i]);
    return names.sort();
}

// the lines that contain text, as "<prefix><line number>\t<line>"
function findLines(lines, text, prefix)
{
    const found = [];
    for (let i = 0; i < lines.length; i++)
        if (lines[i].includes(text)) found.push(prefix + (i + 1) + "\t" + lines[i]);
    return found;
}

// registers the tools of this file, called by buildMcpServer
function registerOpFileTools(server)
{
    server.tool(
        "read-op",
        "read the code of an op (or one of its attachments, att_ prefix optional) with line numbers, much cheaper than reading the whole file: fromLine/toLine limit it to a range of lines, find only lists the lines containing that text, without attachment it also searches the op's include attachments (att_inc_*.js) and prefixes each line with its file name. use edit-op-text to change it.", { "opname": z.string(), "attachment": z.string().optional(), "fromLine": z.number().optional(), "toLine": z.number().optional(), "find": z.string().optional() },
        async ({ opname, attachment, fromLine, toLine, find }) =>
        {
            logMcp("read op " + opname + (attachment ? "/" + attachmentFileName(attachment) : ""));

            try
            {
                const lines = (await readOpText(opname, attachment)).split("\n");

                if (find)
                {
                    const includes = attachment ? [] : includeFileNames(opname);
                    let found = findLines(lines, find, includes.length ? opname + ".js:" : "");
                    for (let i = 0; i < includes.length; i++)
                        found = found.concat(findLines((await readOpAttachment(opname, includes[i])).split("\n"), find, includes[i] + ":"));

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
}
