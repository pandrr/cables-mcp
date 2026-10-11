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
