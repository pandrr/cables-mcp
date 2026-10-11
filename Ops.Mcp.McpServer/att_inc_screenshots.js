// screenshots of the canvas, the patch field and the timeline

// converts a png blob to base64 (without data: prefix), downscaled so its longer edge is at most maxSize
// to keep the image (and its token cost) small; maxSize 0 = keep original size
async function blobToPng(blob, maxSize)
{
    const img = await createImageBitmap(blob);
    const longEdge = Math.max(img.width, img.height);
    const scale = maxSize && longEdge > maxSize ? maxSize / longEdge : 1;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();

    return canvas.toDataURL("image/png").split(",")[1];
}

// renders a frame and captures it right away with the renderer's own screenshot function (the same as the
// "save screenshot" command), so the canvas still holds the rendered image instead of an already cleared buffer
function grabScreenshot(maxSize)
{
    return new Promise((resolve, reject) =>
    {
        const cg = gui.canvasManager.currentContextCg() || CABLES.patch.cgl;
        if (!cg || !cg.screenShot) { reject(new Error("no rendering context with a screenshot function found")); return; }

        cg.patch.renderOneFrame();
        cg.screenShot((blob) =>
        {
            if (!blob) { reject(new Error("screenshot returned no image")); return; }
            blobToPng(blob, maxSize).then(resolve, reject);
        }, false, "image/png");
    });
}

// captures the patch field (the glpatch canvas) right after its next rendered frame, while the drawing buffer still holds the image
function grabPatchFieldScreenshot(maxSize)
{
    return new Promise((resolve, reject) =>
    {
        const cgl = gui.patchView.patchRenderer.cgl;
        const timeout = setTimeout(() =>
        {
            cgl.off(listener);
            reject(new Error("patch field did not render a frame"));
        }, PATCHFIELD_FRAME_TIMEOUT_MS);

        const listener = cgl.on("endFrame", () =>
        {
            clearTimeout(timeout);
            setTimeout(() => { cgl.off(listener); }, 0);
            cgl.screenShot((blob) =>
            {
                if (!blob) { reject(new Error("screenshot returned no image")); return; }
                blobToPng(blob, maxSize).then(resolve, reject);
            }, false, "image/png");
        });
    });
}

// captures the timeline canvas right after a frame it renders; only the gl part, the html line titles on top are not in the image
function grabTimelineScreenshot(maxSize)
{
    return new Promise((resolve, reject) =>
    {
        const glTimeline = gui.glTimeline;
        if (!glTimeline) { reject(new Error("timeline is not open, run the command \"Show timeline\" first")); return; }

        const cgl = glTimeline.cgl;
        const timeout = setTimeout(() =>
        {
            cgl.off(listener);
            reject(new Error("timeline did not render a frame"));
        }, PATCHFIELD_FRAME_TIMEOUT_MS);

        const listener = cgl.on("endFrame", () =>
        {
            clearTimeout(timeout);
            setTimeout(() => { cgl.off(listener); }, 0);
            cgl.screenShot((blob) =>
            {
                if (!blob) { reject(new Error("screenshot returned no image")); return; }
                blobToPng(blob, maxSize).then(resolve, reject);
            }, false, "image/png");
        });

        glTimeline.needsUpdateAll = "mcp screenshot";
    });
}

// registers the tools of this file, called by buildMcpServer
function registerScreenshotTools(server)
{
    server.tool(
        "screenshot",
        "take a screenshot of the patch's rendering canvas and return it as a png image; use it to check what a change looks like. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size); larger images cost more tokens.", { "maxSize": z.number().optional() },
        async ({ maxSize }) =>
        {
            logMcp("screenshot");

            try
            {
                const png = await grabScreenshot(maxSize ?? SCREENSHOT_DEFAULT_MAX_SIZE);
                return respond({ "content": [{ "type": "image", "data": png, "mimeType": "image/png" }] });
            }
            catch (e)
            {
                return respondError("screenshot failed: " + e.message);
            }
        }
    );

    server.tool(
        "patch-field-screenshot",
        "take a screenshot of the patch field (the editor's op graph with ops and links, not the rendering canvas) as a png image. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size). use patch-view to scroll/zoom first; panels on top of the patch field are not in the image.", { "maxSize": z.number().optional() },
        async ({ maxSize }) =>
        {
            logMcp("patch field screenshot");

            try
            {
                const png = await grabPatchFieldScreenshot(maxSize ?? SCREENSHOT_DEFAULT_MAX_SIZE);
                return respond({ "content": [{ "type": "image", "data": png, "mimeType": "image/png" }] });
            }
            catch (e)
            {
                return respondError("patch field screenshot failed: " + e.message);
            }
        }
    );

    server.tool(
        "timeline-screenshot",
        "take a screenshot of the timeline panel (ruler, overview, keys and curves) as a png image. only the gl canvas: the html line titles and buttons are not in the image. maxSize limits the longer edge in pixels (default " + SCREENSHOT_DEFAULT_MAX_SIZE + ", 0 = original size). the timeline has to be open (command \"Show timeline\").", { "maxSize": z.number().optional() },
        async ({ maxSize }) =>
        {
            logMcp("timeline screenshot");

            try
            {
                const png = await grabTimelineScreenshot(maxSize ?? SCREENSHOT_DEFAULT_MAX_SIZE);
                return respond({ "content": [{ "type": "image", "data": png, "mimeType": "image/png" }] });
            }
            catch (e)
            {
                return respondError("timeline screenshot failed: " + e.message);
            }
        }
    );
}
