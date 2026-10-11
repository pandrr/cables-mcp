// patch errors and the compact patch overview

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

// registers the tools of this file, called by buildMcpServer
function registerPatchInfoTools(server)
{
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
}
