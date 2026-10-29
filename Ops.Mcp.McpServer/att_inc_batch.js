// batch tools: several ops, values or positions in one call, to save round trips

// splits "ref.Port Name" at the first dot into op ref and port name
function splitPortRef(ref)
{
    const dot = String(ref).indexOf(".");
    if (dot < 1) return null;
    return { "ref": ref.substring(0, dot), "portName": ref.substring(dot + 1) };
}

// moves an op as one undo step, the same as move-op
function moveOpUndoable(opId, x, y)
{
    const targetOp = CABLES.patch.getOpById(opId);
    const old = targetOp.uiAttribs.translate || { "x": 0, "y": 0 };
    const oldX = old.x;
    const oldY = old.y;
    const moveTo = (px, py) => { gui.patchView.patchRenderer.patchAPI.setOpUiAttribs(opId, "translate", { "x": px, "y": py }); };

    moveTo(x, y);
    unplacedOpIds.delete(opId);
    CABLES.UI.undo.add(
    {
        "title": "Move op",
        "undo": () => { moveTo(oldX, oldY); },
        "redo": () => { moveTo(x, y); }
    });
}

// registers the tools of this file, called by buildMcpServer
function registerBatchTools(server)
{
    server.tool(
        "build-ops",
        "add several ops with their port values and comments and link them, in one call. each op gets a key you choose; links are \"key.Port\" -> \"key.Port\", a key can also be the id of an op already in the patch. all op names are checked first, nothing is added if one is unknown. other errors (wrong port, incompatible link) are reported and the rest is still built. tidy (default true) arranges the new ops like tidy-up-ops. returns the new op ids per key.",
        {
            "ops": z.array(z.object({
                "key": z.string().describe("your name for the op, used in links, e.g. \"lfo\""),
                "objName": param.opName(),
                "values": z.record(z.any()).optional().describe("input port values by port name, e.g. {\"Frequency\": 0.5}"),
                "comment": z.string().optional().describe("op comment shown next to its title")
            })).describe("ops to add"),
            "links": z.array(z.object({
                "from": z.string().describe("output port as \"key.Port\" or \"opId.Port\""),
                "to": z.string().describe("input port as \"key.Port\" or \"opId.Port\"")
            })).optional().describe("links to create, in order"),
            "tidy": z.boolean().optional().describe("arrange the new ops afterwards, default true")
        },
        async ({ ops, links, tidy }) =>
        {
            logMcp("build ops: " + ops.length + " ops, " + (links || []).length + " links");

            const keys = new Set();
            for (const o of ops)
            {
                if (keys.has(o.key)) return respondError("key \"" + o.key + "\" is used twice");
                keys.add(o.key);
            }

            const unknown = [];
            for (const o of ops) if (!gui.opDocs.getOpDocByName(o.objName) && !isCollectionOpName(o.objName) && !await loadOpDoc(o.objName)) unknown.push(o.objName);
            if (unknown.length) return respondError("nothing added, unknown op names: " + unknown.join(", ") + " (find names with search-ops)");

            const idByKey = {};
            const added = [];
            const errors = [];

            for (const o of ops)
            {
                try
                {
                    const newOp = await addOpChecked(o.objName);
                    idByKey[o.key] = newOp.id;
                    added.push(newOp);
                }
                catch (e)
                {
                    errors.push(o.key + ": " + e.message);
                }
            }

            for (const o of ops)
            {
                const opId = idByKey[o.key];
                if (!opId) continue;
                for (const portName in o.values || {})
                {
                    try
                    {
                        setPortValueChecked(opId, portName, o.values[portName]);
                    }
                    catch (e)
                    {
                        errors.push(o.key + ": " + e.message);
                    }
                }
                if (o.comment) setOpCommentUndoable(opId, o.comment);
            }

            const resolve = (ref) =>
            {
                const p = splitPortRef(ref);
                if (!p) throw new Error("\"" + ref + "\" is not \"key.Port\"");
                const opId = idByKey[p.ref] || (CABLES.patch.getOpById(p.ref) ? p.ref : null);
                if (!opId) throw new Error("\"" + p.ref + "\" in \"" + ref + "\" is neither a key nor an op id");
                return { "opId": opId, "portName": p.portName };
            };

            let numLinked = 0;
            for (const l of links || [])
            {
                try
                {
                    const from = resolve(l.from);
                    const to = resolve(l.to);
                    linkPortsChecked(from.opId, from.portName, to.opId, to.portName);
                    numLinked++;
                }
                catch (e)
                {
                    errors.push(l.from + " -> " + l.to + ": " + e.message);
                }
            }

            let tidyText = "";
            if (tidy !== false && added.length)
            {
                const pos = layoutOps(added);
                if (typeof pos == "string") tidyText = "tidy up failed: " + pos;
                else
                {
                    applyOpPositions(pos);
                    for (const o of added) unplacedOpIds.delete(o.id);
                    fitPatchView(added);
                    tidyText = "tidied up";
                }
            }

            const lines = [];
            lines.push("added " + added.length + " of " + ops.length + " ops, " + numLinked + " of " + (links || []).length + " links" + (tidyText ? ", " + tidyText : ""));
            for (const o of ops) if (idByKey[o.key]) lines.push(o.key + " = " + idByKey[o.key] + " " + o.objName);
            if (errors.length) lines.push("errors:\n" + errors.join("\n"));
            return respondText(lines.join("\n"));
        }
    );

    server.tool(
        "set-port-values",
        "set several input port values in one call, each like set-port-value. every value is set even if others fail, failures are listed.",
        {
            "values": z.array(z.object({
                "opId": param.opId(),
                "portName": param.portName(),
                "value": z.any().describe("the new value, its type has to match the port")
            })).describe("values to set")
        },
        ({ values }) =>
        {
            logMcp("set " + values.length + " port values");

            const errors = [];
            for (const v of values)
            {
                try
                {
                    setPortValueChecked(v.opId, v.portName, v.value);
                }
                catch (e)
                {
                    errors.push(v.opId + "." + v.portName + ": " + e.message);
                }
            }

            const text = "set " + (values.length - errors.length) + " of " + values.length + " values";
            if (errors.length) return respondText(text + "\nerrors:\n" + errors.join("\n"));
            return respondText(text);
        }
    );

    server.tool(
        "move-ops",
        "move several ops to new patch coordinates in one call, as one undo step. use it after tidy-up-ops when the layout needs fixing, check-layout tells what overlaps.",
        {
            "positions": z.array(z.object({
                "opId": param.opId(),
                "x": z.number().describe("new patch x coordinate"),
                "y": z.number().describe("new patch y coordinate")
            })).describe("new positions")
        },
        ({ positions }) =>
        {
            logMcp("move " + positions.length + " ops");

            const missing = positions.filter((p) => !CABLES.patch.getOpById(p.opId)).map((p) => p.opId);
            if (missing.length) return respondError("nothing moved, no op found with id " + missing.join(", "));

            const undoGroup = CABLES.UI.undo.startGroup();
            for (const p of positions) moveOpUndoable(p.opId, p.x, p.y);
            CABLES.UI.undo.endGroup(undoGroup, "Move ops");

            return respondText("moved " + positions.length + " ops");
        }
    );
}
