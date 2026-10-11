// animated ports: keyframes and easings

const EASING_NAME_CLIP = "Clip";
const easingConverter = new CABLES.Anim();

// finds an animatable port (number input) of an op in the patch, returns { port } or { error }
function getAnimatablePort(opId, portName)
{
    const targetOp = CABLES.patch.getOpById(opId);
    if (!targetOp) return { "error": "no op found with id " + opId };

    const port = targetOp.getPort(portName);
    if (!port) return { "error": "no port named \"" + portName + "\" on op " + opId };
    if (port.direction !== CABLES.Port.DIR_IN || port.type !== CABLES.Port.TYPE_VALUE) return { "error": "port \"" + portName + "\" on op " + opId + " is not a number input port, only those can be animated" };

    return { "port": port };
}

// easing names as shown in the timeline, the anim easing constants are not in the order of Anim.EASINGNAMES.
// clip easing is left out, it needs a clip anim to work
function easingNames()
{
    return CABLES.Anim.EASINGNAMES.filter((n) => n != EASING_NAME_CLIP);
}

function easingByName(name)
{
    const names = easingNames();
    for (let i = 0; i < names.length; i++)
        if (names[i].toLowerCase() == String(name).toLowerCase()) return easingConverter.easingFromString(names[i]);
    return null;
}

function easingName(easing)
{
    const names = easingNames();
    for (let i = 0; i < names.length; i++)
        if (easingConverter.easingFromString(names[i]) === easing) return names[i];
    return String(easing);
}

function portAnimState(port)
{
    return { "animated": port.isAnimated(), "anim": port.anim ? port.anim.getSerialized() : null };
}

function applyPortAnimState(opId, portName, state)
{
    const o = CABLES.patch.getOpById(opId);
    if (!o) return;
    const p = o.getPort(portName);
    if (!p) return;

    p.setAnimated(state.animated);
    if (state.animated && state.anim)
    {
        p.anim.deserialize(state.anim, true);
        p.anim.loop = state.anim.loop || CABLES.Anim.LOOP_OFF;
        p.anim.emitEvent(CABLES.Anim.EVENT_CHANGE, p.anim);
    }
    o.patch.emitEvent(CABLES.Port.EVENT_ANIM_UPDATED, o, p, p.anim);
    gui.savedState.setUnSaved("mcpAnim", o.getSubPatch());
    if (gui.patchView.isCurrentOp(o)) o.refreshParams();
}

// runs change(port) and registers one undo step that restores the animation state of the port from before
function changePortAnimUndoable(opId, portName, title, change)
{
    const port = CABLES.patch.getOpById(opId).getPort(portName);
    const oldState = portAnimState(port);

    change(port);
    if (port.anim) port.anim.emitEvent(CABLES.Anim.EVENT_CHANGE, port.anim);
    applyPortAnimState(opId, portName, portAnimState(port));

    const newState = portAnimState(port);
    CABLES.UI.undo.add(
    {
        "title": title,
        "context": { "portname": portName },
        "undo": () => { applyPortAnimState(opId, portName, oldState); },
        "redo": () => { applyPortAnimState(opId, portName, newState); }
    });
}

function portAnimInfo(port)
{
    const anim = port.anim;
    const time = CABLES.patch.timer.getTime();
    const info = { "animated": port.isAnimated(), "time": round3(time), "value": port.get() };
    if (!anim) return info;

    info.loop = ["off", "repeat", "mirror", "offset"][anim.getLoop()] || anim.getLoop();
    info.length = anim.keys.length ? round3(anim.lastKey.time) : 0;
    info.valueAtTime = anim.keys.length ? anim.getValue(time) : null;
    info.keys = [];
    for (let i = 0; i < anim.keys.length; i++)
        info.keys.push({ "time": round3(anim.keys[i].time), "value": anim.keys[i].value, "easing": easingName(anim.keys[i].getEasing()) });
    return info;
}

function round3(v)
{
    return Math.round(v * 1000) / 1000;
}
