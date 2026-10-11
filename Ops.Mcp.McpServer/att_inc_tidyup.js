// tidy-up-ops: layout of ops in rows following their links

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
            for (const o of ops)(layers[layer.get(o)] = layers[layer.get(o)] || []).push(o);
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
    return op.portsOut.map((portOut) => (
    {
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
    for (const sideChain of sideChains.values())
        if (sideChain.anchor == o) size += sideChain.chain.length;
    for (const { children } of childrenByPort(o, set))
        for (const c of children) size += subtreeSize(c, set, sideChains);
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
