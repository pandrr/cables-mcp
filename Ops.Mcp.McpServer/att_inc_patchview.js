// scrolling/zooming the patch field

const PATCHFIELD_FRAME_TIMEOUT_MS = 3000;
const PATCHFIELD_FIT_PADDING = 1.1;
const PATCHFIELD_FIT_MIN_SIZE = 250;

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
