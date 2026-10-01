const { test, expect } = require("@playwright/test");

async function createDocument(request, title) {
    const response = await request.post("/documents", { data: { title } });
    expect(response.ok()).toBeTruthy();
    return response.json();
}

async function deleteDocument(request, documentState) {
    await request.delete(`/documents/${documentState.slug}?revision=${documentState.revision}`);
}

async function waitForSaved(page) {
    const saveState = page.locator("#save-state");
    await expect(saveState).toBeVisible();
    await expect(page.locator(".status-bar")).toHaveCSS("position", "fixed");
    await expect(page.locator(".status-bar")).toHaveCSS("width", `${page.viewportSize().width}px`);
    await expect(saveState).toHaveText("Saved", { timeout: 5000 });
}

test("document editing lifecycle works in the browser", async ({ page, request }) => {
    const title = `Playwright lifecycle ${Date.now()}`;
    let documentState;
    page.on("dialog", (dialog) => dialog.accept());

    await page.goto("/");
    await page.getByRole("button", { name: "New document" }).click();
    await expect(page).toHaveURL(/\/documents\//);
    await expect(page.locator(".paragraph").first()).toBeVisible();
    await expect(page.locator(".paragraph").first()).toHaveJSProperty("tagName", "D-PARAGRAPH");

    const paragraph = page.locator(".paragraph").first();
    await paragraph.focus();
    await paragraph.fill("Alpha");
    await expect(page.locator(".paragraph-metrics")).toContainText("5.000 znakova");
    await expect(page.locator(".paragraph-metrics")).toContainText("0 / 50 formatiranja");
    await expect(page.locator(".paragraph-metrics")).toContainText("0 / 20 linkova");
    await expect(page.locator("#document-size-limit")).toContainText("Size");
    await expect(page.locator("#document-block-limit")).toContainText("Blocks 1 / 10,000");
    await waitForSaved(page);

    await page.keyboard.press("Control+Z");
    await expect(paragraph).toHaveText("");
    await page.keyboard.press("Control+Shift+Z");
    await expect(paragraph).toHaveText("Alpha");
    await waitForSaved(page);

    const titleInput = page.locator("#document-title");
    await titleInput.fill(title);
    await titleInput.press("Tab");
    await waitForSaved(page);
    await expect(page).toHaveURL(new RegExp(`/documents/${title.toLowerCase().replaceAll(" ", "-")}`));

    documentState = await (await request.get("/documents")).json()
        .then((documents) => documents.find((document) => document.title === title));
    expect(documentState).toBeTruthy();

    await page.goto("/");
    const card = page.locator(".document-card", { hasText: title });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(card).toHaveCount(0);
});

test("block focus enables editing and File save persists changes", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright block edit flow ${Date.now()}`);
    page.on("dialog", (dialog) => dialog.accept());

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        await expect(page.locator("#file-save")).toBeDisabled();
        const paragraph = page.locator(".paragraph").first();
        await expect(paragraph).toHaveAttribute("contenteditable", "false");
        await paragraph.focus();
        await expect(paragraph).toHaveAttribute("contenteditable", "true");
        await paragraph.fill("Saved block content");
        await page.locator("#document-title").focus();
        await expect(paragraph).toHaveAttribute("contenteditable", "false");
        await expect(page.locator("#save-state")).toHaveText("Unsaved");
        await expect(page.locator("#file-save")).toBeEnabled();
        await expect(page.locator("#file-save")).toHaveClass(/has-changes/);
        await page.locator("#file-save").click();
        await waitForSaved(page);
        await expect(page.locator("#file-save")).toBeDisabled();
        await expect(page.locator("#file-save")).not.toHaveClass(/has-changes/);
    } finally {
        await page.goto("/");
        const card = page.locator(".document-card", { hasText: documentState.title });
        if (await card.count()) {
            await card.getByRole("button", { name: "Delete" }).click();
            await expect(card).toHaveCount(0);
        }
    }
});

test("paragraph stays unsaved on blur until File save", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright explicit save ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Saved explicitly");
        await expect(page.locator("#save-state")).toHaveText("Unsaved");
        await page.locator("#file-save").click();
        await waitForSaved(page);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});








test("paragraph blur without edits does not save", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright clean blur ${Date.now()}`);
    const saveRequests = [];
    page.on("request", (requestEvent) => {
        if (requestEvent.method() === "PUT" && requestEvent.url().includes(`/documents/${documentState.slug}`)) {
            saveRequests.push(requestEvent);
        }
    });

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        await page.locator(".paragraph").first().focus();
        await page.locator("#document-title").focus();
        await page.waitForTimeout(900);
        expect(saveRequests).toHaveLength(0);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Enter splits a paragraph through DOM, metadata, focus, persistence, and history", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright enter split ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        const blockId = await paragraph.getAttribute("data-block-id");
        await paragraph.evaluate((element, values) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", `<d-bold>AlphaBeta</d-bold>` +
                `<d-link href="/documents/${values.documentId}#block-${values.blockId}">Link</d-link>`);
            clipboard.setData("text/plain", "AlphaBetaLink");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        }, { documentId: documentState.id, blockId });
        await expect(paragraph.locator("d-bold")).toHaveText("AlphaBeta");
        await expect(paragraph.locator("d-link")).toHaveText("Link");
        await waitForSaved(page);

        await paragraph.evaluate((element) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let textNode = walker.nextNode();
            let offset = 5;
            while (textNode && offset > textNode.textContent.length) {
                offset -= textNode.textContent.length;
                textNode = walker.nextNode();
            }
            const range = document.createRange();
            range.setStart(textNode, offset);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.focus();
        });
        await page.keyboard.press("Enter");
        await waitForSaved(page);

        await expect(page.locator(".paragraph")).toHaveCount(2);
        const paragraphs = page.locator(".paragraph");
        await expect(paragraphs.nth(0)).toHaveJSProperty("tagName", "D-PARAGRAPH");
        await expect(paragraphs.nth(1)).toHaveJSProperty("tagName", "D-PARAGRAPH");
        await expect(paragraphs.nth(0)).toHaveText("Alpha");
        await expect(paragraphs.nth(1)).toHaveText("BetaLink");
        await expect(paragraphs.nth(0).locator("d-bold")).toHaveText("Alpha");
        await expect(paragraphs.nth(1).locator("d-bold")).toHaveText("Beta");
        await expect(paragraphs.nth(1).locator("d-link")).toHaveText("Link");

        const domResult = await page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            selectionOffset: (() => {
                const selection = window.getSelection();
                const paragraph = document.activeElement;
                if (!selection?.rangeCount || !paragraph?.classList.contains("paragraph")) return null;
                const range = document.createRange();
                range.selectNodeContents(paragraph);
                range.setEnd(selection.anchorNode, selection.anchorOffset);
                return range.toString().length;
            })(),
            blocks: [...document.querySelectorAll(".paragraph")].map((element) => ({
                id: element.dataset.blockId,
                tagName: element.tagName,
                text: element.textContent,
                html: element.innerHTML,
            })),
        }));
        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        const result = { dom: domResult, saved: saved.content.blocks };
        await test.info().attach("enter-split-result.json", {
            body: JSON.stringify(result, null, 2),
            contentType: "application/json",
        });

        expect(domResult.activeBlockId).toBe(saved.content.blocks[1].id);
        expect(domResult.selectionOffset).toBe(0);
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Alpha", "BetaLink"]);
        expect(saved.content.blocks[0].marks).toEqual([{ start: 0, end: 5, style: "bold" }]);
        expect(saved.content.blocks[1].marks).toEqual([{ start: 0, end: 4, style: "bold" }]);
        expect(saved.content.blocks[1].links).toEqual([{
            start: 4,
            end: 8,
            url: `https://documents/${documentState.id}#block-${blockId}`,
        }]);

        await page.keyboard.press("Control+Z");
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("AlphaBetaLink");
        await page.keyboard.press("Control+Shift+Z");
        await expect(page.locator(".paragraph")).toHaveCount(2);
        await waitForSaved(page);

        await page.keyboard.press("Control+Z");
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await page.locator(".paragraph").first().press("End");
        await page.keyboard.type(" ");
        await page.keyboard.press("Enter");
        await waitForSaved(page);
        await expect(page.locator(".paragraph").nth(0)).toHaveText("AlphaBetaLink");
        await expect(page.locator(".paragraph")).toHaveCount(1);
        const trimmedSplit = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(trimmedSplit.content.blocks.map((block) => block.text)).toEqual(["AlphaBetaLink"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Enter removes whitespace at both split paragraph boundaries", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright enter whitespace ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Alpha  Beta");
        await paragraph.press("Home");
        for (let index = 0; index < 6; index += 1) await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await waitForSaved(page);

        await expect(page.locator(".paragraph")).toHaveCount(2);
        await expect(page.locator(".paragraph").nth(0)).toHaveText("Alpha");
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Beta");
        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Alpha", "Beta"]);
        expect(saved.content.blocks.every((block) => !/^\s|\s$/.test(block.text))).toBeTruthy();
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Enter at the start keeps an empty paragraph before the full text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright enter at start ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Full text");
        await paragraph.press("Home");
        await page.keyboard.press("Enter");

        const paragraphs = page.locator(".paragraph");
        await expect(paragraphs).toHaveCount(2);
        await expect(paragraphs.nth(0)).toHaveText("");
        await expect(paragraphs.nth(1)).toHaveText("Full text");
        await expect.poll(() => page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            selectionOffset: window.getSelection()?.anchorOffset ?? null,
        }))).toEqual({
            activeBlockId: await paragraphs.nth(1).getAttribute("data-block-id"),
            selectionOffset: 0,
        });
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["", "Full text"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Enter at the end creates a new empty paragraph", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright enter at end ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Full text");
        await paragraph.press("End");
        await page.keyboard.press("Enter");

        const paragraphs = page.locator(".paragraph");
        await expect(paragraphs).toHaveCount(2);
        await expect(paragraphs.nth(0)).toHaveText("Full text");
        await expect(paragraphs.nth(1)).toHaveText("");
        await expect.poll(() => page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            selectionOffset: window.getSelection()?.anchorOffset ?? null,
        }))).toEqual({
            activeBlockId: await paragraphs.nth(1).getAttribute("data-block-id"),
            selectionOffset: 0,
        });
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Full text", ""]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Enter on a selection removes it and creates paragraphs around it", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright enter selection ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("BeforeSelectedAfter");
        await paragraph.evaluate((element) => {
            const textNode = element.firstChild;
            const range = document.createRange();
            range.setStart(textNode, "Before".length);
            range.setEnd(textNode, "BeforeSelected".length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.focus();
        });
        await page.keyboard.press("Enter");

        const paragraphs = page.locator(".paragraph");
        await expect(paragraphs).toHaveCount(2);
        await expect(paragraphs.nth(0)).toHaveText("Before");
        await expect(paragraphs.nth(1)).toHaveText("After");
        await expect.poll(() => page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            selectionOffset: window.getSelection()?.anchorOffset ?? null,
        }))).toEqual({
            activeBlockId: await paragraphs.nth(1).getAttribute("data-block-id"),
            selectionOffset: 0,
        });
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Before", "After"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("typing a trailing space preserves it in the paragraph text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright trailing space ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Alpha");
        await paragraph.press("End");
        await paragraph.press("Space");
        await expect(paragraph).toHaveText("Alpha ");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Alpha ");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("blur normalizes paragraph spacing, punctuation, and sentence case", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright blur normalization ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("  hello   world  ,this is a test. next?yes! final   ");
        await page.locator("#document-title").click();
        await expect(paragraph).toHaveText("Hello world, this is a test. Next? Yes! Final");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Hello world, this is a test. Next? Yes! Final");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Backspace updates and joins paragraph blocks through DOM, metadata, persistence, and history", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright backspace merge ${Date.now()}`);
    page.on("dialog", (dialog) => dialog.accept());

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        const blockId = await paragraph.getAttribute("data-block-id");
        await paragraph.evaluate((element, values) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", `<d-bold>AlphaBeta</d-bold>` +
                `<d-link href="/documents/${values.documentId}#block-${values.blockId}">Link</d-link>`);
            clipboard.setData("text/plain", "AlphaBetaLink");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        }, { documentId: documentState.id, blockId });
        await waitForSaved(page);

        await paragraph.press("Home");
        for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Backspace");
        await waitForSaved(page);
        await expect(paragraph).toHaveText("AlphBetaLink");
        await expect(paragraph.locator("d-bold")).toHaveText("AlphBeta");
        await expect(paragraph.locator("d-link")).toHaveText("Link");

    } finally {
        await page.goto("/");
        const card = page.locator(".document-card", { hasText: documentState.title });
        if (await card.count()) {
            await card.getByRole("button", { name: "Delete" }).click();
            await expect(card).toHaveCount(0);
        }
    }
});

test("Backspace after a split merges at the split position", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright backspace split position ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("AlphaBeta");
        await paragraph.evaluate((element) => {
            const textNode = element.firstChild;
            const range = document.createRange();
            range.setStart(textNode, 5);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.focus();
        });
        await page.keyboard.press("Enter");

        const paragraphs = page.locator(".paragraph");
        await expect(paragraphs).toHaveCount(2);
        await expect(paragraphs.nth(0)).toHaveText("Alpha");
        await expect(paragraphs.nth(1)).toHaveText("Beta");
        await expect.poll(() => page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            selectionOffset: (() => {
                const selection = window.getSelection();
                const activeParagraph = document.activeElement;
                if (!selection?.rangeCount || !activeParagraph?.classList.contains("paragraph")) return null;
                const range = document.createRange();
                range.selectNodeContents(activeParagraph);
                range.setEnd(selection.anchorNode, selection.anchorOffset);
                return range.toString().length;
            })(),
        }))).toEqual({
            activeBlockId: await paragraphs.nth(1).getAttribute("data-block-id"),
            selectionOffset: 0,
        });

        await paragraphs.nth(1).press("Backspace");
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("Alpha Beta");
        await expect.poll(() => page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            selectionOffset: (() => {
                const selection = window.getSelection();
                const activeParagraph = document.activeElement;
                if (!selection?.rangeCount || !activeParagraph?.classList.contains("paragraph")) return null;
                const range = document.createRange();
                range.selectNodeContents(activeParagraph);
                range.setEnd(selection.anchorNode, selection.anchorOffset);
                return range.toString().length;
            })(),
        }))).toEqual({
            activeBlockId: await page.locator(".paragraph").first().getAttribute("data-block-id"),
            selectionOffset: "Alpha ".length,
        });
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Alpha Beta"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Backspace at the start of a paragraph merges with the previous paragraph", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright backspace at paragraph start ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.focus();
        await firstParagraph.fill("First");
        await firstParagraph.press("End");
        await firstParagraph.press("Enter");

        const secondParagraph = page.locator(".paragraph").nth(1);
        await secondParagraph.focus();
        await secondParagraph.fill("Second");
        await secondParagraph.press("Home");
        await secondParagraph.press("Backspace");

        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("First Second");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["First Second"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Backspace at the start of the first paragraph does not merge or delete", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright backspace first paragraph ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("First paragraph");
        await paragraph.press("Home");
        await paragraph.press("Backspace");

        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(paragraph).toHaveText("First paragraph");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["First paragraph"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("selected non-empty reference can be removed without changing text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright backspace reference ${Date.now()}`);
    const targetDocument = await createDocument(request, `Playwright reference target ${Date.now()}`);

    try {
        const current = await (await request.get(`/documents/${documentState.slug}`)).json();
        const block = current.content.blocks[0];
        block.text = "Source";
        block.references = [{
            start: 0,
            end: "Source".length,
            documentId: targetDocument.id,
            blockId: targetDocument.content.blocks[0].id,
        }];
        await request.patch(`/documents/${documentState.slug}/blocks`, {
            data: {
                revision: current.revision,
                blocks: [block],
                replaceAll: true,
            },
        });

        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        const referenceSaved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(referenceSaved.content.blocks[0].references).toEqual([{
            start: 0,
            end: "Source".length,
            documentId: targetDocument.id,
            blockId: targetDocument.content.blocks[0].id,
        }]);
        await expect(paragraph).toHaveText("Source");
        await expect(paragraph.locator("d-reference")).toHaveCount(1);
        expect(await paragraph.locator("d-reference").evaluate((element) =>
            getComputedStyle(element, "::after").content)).toBe('"※"');
        await paragraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.locator('.ribbon-link-button[data-link-kind="reference"]').click();
        await expect(paragraph).toHaveText("Source");
        await expect(paragraph.locator("d-reference")).toHaveCount(0);
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Source");
        expect(saved.content.blocks[0].references ?? []).toEqual([]);
    } finally {
        for (const documentToDelete of [documentState, targetDocument]) {
            const response = await request.get(`/documents/${documentToDelete.slug}`);
            if (response.ok()) await deleteDocument(request, await response.json());
        }
    }
});

test("Delete updates and joins paragraph blocks through DOM, metadata, persistence, and history", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright delete character ${Date.now()}`);
    page.on("dialog", (dialog) => dialog.accept());

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        const blockId = await paragraph.getAttribute("data-block-id");
        await paragraph.evaluate((element, values) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", `<d-bold>AlphaBeta</d-bold>` +
                `<d-link href="/documents/${values.documentId}#block-${values.blockId}">Link</d-link>`);
            clipboard.setData("text/plain", "AlphaBetaLink");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        }, { documentId: documentState.id, blockId });
        await waitForSaved(page);

        await paragraph.press("Home");
        for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Delete");
        await waitForSaved(page);

        await expect(paragraph).toHaveText("AlphaetaLink");
        let saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].marks).toEqual([{ start: 0, end: 8, style: "bold" }]);
        expect(saved.content.blocks[0].links).toEqual([{
            start: 8,
            end: 12,
            url: `https://documents/${documentState.id}#block-${blockId}`,
        }]);

        await page.keyboard.press("Control+Z");
        await expect(paragraph).toHaveText("AlphaBetaLink");

        await paragraph.press("Home");
        for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await page.locator(".paragraph").first().press("End");
        await page.keyboard.press("Delete");
        await waitForSaved(page);

        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("AlphaBetaLink");
        await expect(page.locator(".paragraph").first().locator("d-bold")).toHaveText("AlphaBeta");
        await expect(page.locator(".paragraph").first().locator("d-link")).toHaveText("Link");
        const domResult = await page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            text: document.querySelector(".paragraph")?.textContent,
            html: document.querySelector(".paragraph")?.innerHTML,
        }));
        saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        await test.info().attach("delete-merge-result.json", {
            body: JSON.stringify({ dom: domResult, saved: saved.content.blocks }, null, 2),
            contentType: "application/json",
        });
        expect(domResult.activeBlockId).toBe(saved.content.blocks[0].id);
        expect(saved.content.blocks[0].marks).toEqual([{ start: 0, end: 9, style: "bold" }]);
        expect(saved.content.blocks[0].links).toEqual([{
            start: 9,
            end: 13,
            url: `https://documents/${documentState.id}#block-${blockId}`,
        }]);

    } finally {
        await page.goto("/");
        const card = page.locator(".document-card", { hasText: documentState.title });
        if (await card.count()) {
            await card.getByRole("button", { name: "Delete" }).click();
            await expect(card).toHaveCount(0);
        }
    }
});

test("Delete joining an empty paragraph normalizes the joined block", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright empty delete join ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.press("Enter");
        await page.locator(".paragraph").nth(1).fill("Next");
        await waitForSaved(page);

        await firstParagraph.focus();
        await firstParagraph.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.keyboard.press("Delete");
        await waitForSaved(page);

        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("Next");
        const selectionOffset = await page.evaluate(() => {
            const paragraph = document.activeElement;
            const selection = window.getSelection();
            if (!selection?.rangeCount || !paragraph?.classList.contains("paragraph")) return null;
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            range.setEnd(selection.anchorNode, selection.anchorOffset);
            return range.toString().length;
        });
        expect(selectionOffset).toBe(0);
        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Next"]);
        expect(saved.content.blocks.every((block) => !/^\s|\s$/.test(block.text))).toBeTruthy();
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Delete at the end of the last paragraph is a no-op", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright delete last paragraph ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Last paragraph");
        await paragraph.press("End");
        await page.keyboard.press("Delete");

        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(paragraph).toHaveText("Last paragraph");
        await waitForSaved(page);
        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Last paragraph"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("revision conflict preserves local content", async ({ browser, request }) => {
    const documentState = await createDocument(request, `Playwright conflict ${Date.now()}`);
    const firstPage = await browser.newPage();
    const secondPage = await browser.newPage();

    try {
        await firstPage.goto(`/documents/${documentState.slug}`);
        await secondPage.goto(`/documents/${documentState.slug}`);
        await waitForSaved(firstPage);
        await waitForSaved(secondPage);

        await firstPage.locator(".paragraph").first().focus();
        await firstPage.locator(".paragraph").first().fill("Server version");
        await waitForSaved(firstPage);

        await secondPage.locator(".paragraph").first().focus();
        await secondPage.locator(".paragraph").first().fill("Local version");
        await waitForSaved(secondPage);
        await expect(secondPage.locator(".paragraph").first()).toHaveText("Local version");

        const response = await request.get(`/documents/${documentState.slug}`);
        const saved = await response.json();
        expect(saved.content.blocks[0].text).toBe("Local version");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
        await firstPage.close();
        await secondPage.close();
    }
});

test("selected paragraph text adds an external link", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright links ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Open target");
        await paragraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.locator('.ribbon-link-button[data-link-kind="link"]').click();
        await expect(page.locator("#link-dialog")).toBeVisible();
        await expect(page.locator("#link-dialog-title")).toHaveText("Add external link");
        await expect(page.locator("#link-dialog-label")).toHaveText("External URL");
        await expect(page.locator("#link-dialog-input")).toHaveAttribute("placeholder", "https://example.com/resource");
        await page.locator("#link-dialog-input").fill("https://example.com/source");
        await page.locator("#link-dialog").getByRole("button", { name: "Insert link" }).click();
        await waitForSaved(page);

        const link = paragraph.locator("d-link");
        await expect(link).toHaveAttribute("href", "https://example.com/source");

        const response = await request.get(`/documents/${documentState.slug}`);
        let saved = await response.json();
        expect(saved.content.blocks[0].text).toBe("Open target");
        expect(saved.content.blocks[0].links).toEqual([{
            start: 0,
            end: "Open target".length,
            url: "https://example.com/source",
        }]);

    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});

test("selected paragraph text removes an existing external link", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright remove external link ${Date.now()}`);

    try {
        const current = await (await request.get(`/documents/${documentState.slug}`)).json();
        const block = current.content.blocks[0];
        block.text = "Open target";
        block.links = [{ start: 0, end: block.text.length, url: "https://example.com/source" }];
        const patch = await request.patch(`/documents/${documentState.slug}/blocks`, {
            data: { revision: current.revision, blocks: [block], replaceAll: true },
        });
        expect(patch.ok()).toBeTruthy();

        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await expect(paragraph.locator("d-link")).toHaveCount(1);
        await paragraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.locator('.ribbon-link-button[data-link-kind="link"]').click();
        await expect(paragraph).toHaveText("Open target");
        await expect.poll(async () => (await (await request.get(`/documents/${documentState.slug}`)).json()).content.blocks[0].links ?? []).toEqual([]);
        await expect(paragraph.locator("d-link")).toHaveCount(0);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("partial external link selection does not remove the link", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright partial link selection ${Date.now()}`);

    try {
        const current = await (await request.get(`/documents/${documentState.slug}`)).json();
        const block = current.content.blocks[0];
        block.text = "Open target";
        block.links = [{ start: 0, end: block.text.length, url: "https://example.com/source" }];
        const patch = await request.patch(`/documents/${documentState.slug}/blocks`, {
            data: { revision: current.revision, blocks: [block], replaceAll: true },
        });
        expect(patch.ok()).toBeTruthy();

        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.evaluate((element) => {
            element.focus();
            const textNode = element.querySelector("d-link")?.firstChild;
            const range = document.createRange();
            range.setStart(textNode, 0);
            range.setEnd(textNode, "Open".length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await expect(page.locator('.ribbon-link-button[data-link-kind="link"]')).toHaveAttribute("aria-label", "Add link");
        await page.locator('.ribbon-link-button[data-link-kind="link"]').click();
        await expect(page.locator("#link-dialog")).toBeVisible();
        await page.locator("#link-dialog").getByRole("button", { name: "Cancel" }).click();
        await expect(paragraph.locator("d-link")).toHaveCount(1);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("selected paragraph text adds and removes a block reference", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright block reference ${Date.now()}`);
    const targetDocument = await createDocument(request, `Playwright block reference target ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const sourceParagraph = page.locator(".paragraph").first();
        await sourceParagraph.focus();
        await sourceParagraph.fill("Source text");

        const targetBlockId = targetDocument.content.blocks[0].id;
        const targetLink = `/documents/${targetDocument.id}#block-${targetBlockId}`;

        await sourceParagraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.locator('.ribbon-link-button[data-link-kind="reference"]').click();
        await expect(page.locator("#reference-dialog")).toBeVisible();
        await expect(page.locator("#reference-dialog-title")).toHaveText("Add block reference");
        await expect(page.locator("#reference-dialog-label")).toHaveText("Reference URL");
        await expect(page.locator("#reference-dialog-input")).toHaveAttribute("placeholder", "/documents/{id}#block-{blockId}");
        await page.locator("#reference-dialog-input").fill(targetLink);
        await page.locator("#reference-dialog").getByRole("button", { name: "Insert reference" }).click();
        await expect(page.locator("#reference-dialog")).toBeHidden();
        await waitForSaved(page);

        let saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Source text");
        expect(saved.content.blocks[0].references).toHaveLength(1);
        await expect(sourceParagraph).toHaveText("Source text");
        await expect(sourceParagraph.locator("d-reference")).toHaveCount(1);
        const reference = sourceParagraph.locator("d-reference");
        await expect(reference).toHaveAttribute("data-document-id", String(targetDocument.id));
        await expect(reference).toHaveAttribute("data-block-id", targetBlockId);

        expect(saved.content.blocks[0].text).toBe("Source text");
        expect(saved.content.blocks[0].references).toEqual([{
            start: 0,
            end: "Source text".length,
            documentId: targetDocument.id,
            blockId: targetBlockId,
        }]);

        await sourceParagraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.locator('.ribbon-link-button[data-link-kind="reference"]').click();
        await expect(sourceParagraph.locator("d-reference")).toHaveCount(0);
        await expect(sourceParagraph).toHaveText("Source text");
        await waitForSaved(page);
        saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Source text");
        expect(saved.content.blocks[0].references ?? []).toEqual([]);
    } finally {
        for (const documentToDelete of [documentState, targetDocument]) {
            const response = await request.get(`/documents/${documentToDelete.slug}`);
            if (response.ok()) await deleteDocument(request, await response.json());
        }
    }
});

test("reference wraps the selected word and appends its marker", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright reference position ${Date.now()}`);
    const targetDocument = await createDocument(request, `Playwright reference position target ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("First second third");
        await paragraph.evaluate((element) => {
            element.focus();
            const textNode = element.firstChild;
            const range = document.createRange();
            range.setStart(textNode, "First ".length);
            range.setEnd(textNode, "First second".length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });

        const targetBlockId = targetDocument.content.blocks[0].id;
        await page.locator('.ribbon-link-button[data-link-kind="reference"]').click();
        await expect(page.locator("#reference-dialog")).toBeVisible();
        await page.locator("#reference-dialog-input").fill(`/documents/${targetDocument.id}#block-${targetBlockId}`);
        await page.locator("#reference-dialog").getByRole("button", { name: "Insert reference" }).click();
        await waitForSaved(page);

        await expect(paragraph).toHaveText("First second third");
        await expect(paragraph.locator("d-reference")).toHaveCount(1);
        await expect(paragraph.locator("d-reference")).toHaveText("second");
        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].references).toEqual([{
            start: "First ".length,
            end: "First second".length,
            documentId: targetDocument.id,
            blockId: targetBlockId,
        }]);
        const markerPosition = await paragraph.evaluate((element) => {
            const marker = element.querySelector("d-reference");
            const range = document.createRange();
            range.selectNodeContents(element);
            range.setEndBefore(marker);
            return range.toString().length;
        });
        expect(markerPosition).toBe("First ".length);
    } finally {
        for (const documentToDelete of [documentState, targetDocument]) {
            const response = await request.get(`/documents/${documentToDelete.slug}`);
            if (response.ok()) await deleteDocument(request, await response.json());
        }
    }
});

test("ribbon formatting buttons persist selected marks", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright ribbon formatting ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        const sourceText = "Formatted text";
        await paragraph.focus();
        await paragraph.fill(sourceText);
        await paragraph.selectText();

        for (const format of ["bold", "italic", "highlight"]) {
            await page.locator(`.ribbon-format-button[data-format="${format}"]`).click();
        }
        await expect(paragraph.locator("d-bold")).toHaveText(sourceText);
        await expect(paragraph.locator("d-italic")).toHaveText(sourceText);
        await expect(paragraph.locator("d-highlight")).toHaveText(sourceText);
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].marks).toEqual(expect.arrayContaining([
            { start: 0, end: sourceText.length, style: "bold" },
            { start: 0, end: sourceText.length, style: "italic" },
            { start: 0, end: sourceText.length, style: "highlight" },
        ]));
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("ribbon case buttons transform the selected text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright ribbon case ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("hello world");
        await paragraph.focus();
        await paragraph.selectText();
        await page.locator('.ribbon-format-button[data-caps="upper"]').click();
        await expect(paragraph).toHaveText("HELLO WORLD");

        await paragraph.focus();
        await paragraph.selectText();
        await page.locator('.ribbon-format-button[data-caps="lower"]').click();
        await expect(paragraph).toHaveText("hello world");

        await paragraph.focus();
        await paragraph.selectText();
        await page.locator('.ribbon-format-button[data-caps="title"]').click();
        await expect(paragraph).toHaveText("Hello World");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Hello World");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("ribbon undo and redo restore the latest paragraph edit", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright ribbon history ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("First version");
        await page.locator("#file-save").click();
        await waitForSaved(page);

        await paragraph.focus();
        await paragraph.fill("Second version");
        await page.locator("#undo").click();
        await expect(paragraph).toHaveText("First version");
        await page.locator("#redo").click();
        await expect(paragraph).toHaveText("Second version");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});








test("ribbon split button splits at the current caret", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright split button ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Alpha Beta");
        await paragraph.press("Home");
        for (let index = 0; index < 6; index += 1) await paragraph.press("ArrowRight");

        const paragraphRow = paragraph.locator("xpath=..");
        await page.locator("#split-paragraph").click();
        await expect(page.locator(".paragraph")).toHaveCount(2);
        await expect(page.locator(".paragraph").nth(0)).toHaveText("Alpha");
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Beta");
        await waitForSaved(page);
        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Alpha", "Beta"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("ribbon split button preserves Enter boundary and selection semantics", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright split button boundaries ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Full text");
        await paragraph.press("Home");
        await page.locator("#split-paragraph").click();

        let paragraphs = page.locator(".paragraph");
        await expect(paragraphs).toHaveCount(2);
        await expect(paragraphs.nth(0)).toHaveText("");
        await expect(paragraphs.nth(1)).toHaveText("Full text");

        await paragraphs.nth(1).press("End");
        await page.locator("#split-paragraph").click();
        paragraphs = page.locator(".paragraph");
        await expect(paragraphs).toHaveCount(3);
        await expect(paragraphs.nth(0)).toHaveText("");
        await expect(paragraphs.nth(1)).toHaveText("Full text");
        await expect(paragraphs.nth(2)).toHaveText("");

        await paragraphs.nth(1).evaluate((element) => {
            const textNode = element.firstChild;
            const range = document.createRange();
            range.setStart(textNode, "Full ".length);
            range.setEnd(textNode, "Full text".length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.focus();
        });
        await page.locator("#split-paragraph").click();
        paragraphs = page.locator(".paragraph");
        await expect(paragraphs).toHaveCount(4);
        await expect(paragraphs.nth(0)).toHaveText("");
        await expect(paragraphs.nth(1)).toHaveText("Full");
        await expect(paragraphs.nth(2)).toHaveText("");
        await expect(paragraphs.nth(3)).toHaveText("");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["", "Full", "", ""]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("ribbon split keeps the new paragraph after the active block", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright split position ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.focus();
        await firstParagraph.fill("First");
        await firstParagraph.press("End");
        await firstParagraph.press("Enter");

        const activeParagraph = page.locator(".paragraph").nth(1);
        await activeParagraph.focus();
        await activeParagraph.fill("Alpha Beta");
        await activeParagraph.press("Home");
        for (let index = 0; index < 6; index += 1) await activeParagraph.press("ArrowRight");
        await page.locator("#split-paragraph").click();

        await expect(page.locator(".paragraph")).toHaveCount(3);
        await expect(page.locator(".paragraph").nth(0)).toHaveText("First");
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Alpha");
        await expect(page.locator(".paragraph").nth(2)).toHaveText("Beta");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("ribbon merge buttons only affect adjacent paragraph blocks", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright merge buttons ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.focus();
        await firstParagraph.fill("One");
        await firstParagraph.press("End");
        await firstParagraph.press("Enter");
        const secondParagraph = page.locator(".paragraph").nth(1);
        await secondParagraph.focus();
        await secondParagraph.fill("Two");
        await secondParagraph.press("End");
        await secondParagraph.press("Enter");
        const thirdParagraph = page.locator(".paragraph").nth(2);
        await thirdParagraph.focus();
        await thirdParagraph.fill("Three");

        const middleRow = page.locator(".paragraph").nth(1).locator("xpath=..");
        await page.locator(".paragraph").nth(1).focus();
        await expect(page.locator('[data-merge-direction="above"]')).toBeEnabled();
        await expect(page.locator('[data-merge-direction="below"]')).toBeEnabled();

        await page.locator('[data-merge-direction="below"]').click();
        await expect(page.locator(".paragraph")).toHaveCount(2);
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Two Three");

        await page.locator('[data-merge-direction="above"]').click();
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("One Two Three");
        await expect(page.locator('[data-merge-direction="above"]')).toBeDisabled();
        await expect(page.locator('[data-merge-direction="below"]')).toBeDisabled();
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["One Two Three"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("referenced paragraphs cannot split or merge", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright referenced paragraph lock ${Date.now()}`);

    try {
        const current = await (await request.get(`/documents/${documentState.slug}`)).json();
        const referencedBlock = current.content.blocks[0];
        referencedBlock.text = "Referenced";
        const sourceBlock = {
            id: `paragraph-source-${Date.now()}`,
            type: "paragraph",
            text: "Source",
            references: [{
                start: 0,
                end: "Source".length,
                documentId: documentState.id,
                blockId: referencedBlock.id,
            }],
        };
        const trailingBlock = {
            id: `paragraph-trailing-${Date.now()}`,
            type: "paragraph",
            text: "Trailing",
        };
        const patch = await request.patch(`/documents/${documentState.slug}/blocks`, {
            data: {
                revision: current.revision,
                blocks: [sourceBlock, referencedBlock, trailingBlock],
                replaceAll: true,
            },
        });
        expect(patch.ok()).toBeTruthy();

        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraphs = page.locator(".paragraph");
        const targetParagraph = paragraphs.nth(1);
        await targetParagraph.focus();
        await expect(page.locator("#split-paragraph")).toBeDisabled();
        await expect(page.locator('[data-merge-direction="above"]')).toBeDisabled();

        await targetParagraph.press("Home");
        await page.keyboard.type("Changed");
        await expect(targetParagraph).toHaveText("Referenced");
        await targetParagraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Referenced");
        await expect(page.locator('.ribbon-format-button[data-caps="upper"]')).toBeDisabled();
        await expect(page.locator('.ribbon-format-button[data-format="bold"]')).toBeEnabled();

        await targetParagraph.press("End");
        await page.keyboard.press("Enter");
        await expect(page.locator(".paragraph")).toHaveCount(3);
        await expect(paragraphs.nth(1)).toHaveText("Referenced");

        await targetParagraph.press("Home");
        await page.keyboard.press("Backspace");
        await expect(page.locator(".paragraph")).toHaveCount(3);
        await expect(paragraphs.nth(1)).toHaveText("Referenced");

        await targetParagraph.press("End");
        await page.keyboard.press("Delete");
        await expect(page.locator(".paragraph")).toHaveCount(3);
        await expect(paragraphs.nth(1)).toHaveText("Referenced");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("external references lock the target paragraph in the UI and API", async ({ page, request }) => {
    let targetDocument = await createDocument(request, `Playwright external reference target ${Date.now()}`);
    const sourceDocument = await createDocument(request, `Playwright external reference source ${Date.now()}`);

    try {
        const targetBlock = { ...targetDocument.content.blocks[0], text: "Target" };
        const targetSetup = await request.patch(`/documents/${targetDocument.slug}/blocks`, {
            data: { revision: targetDocument.revision, blocks: [targetBlock], replaceAll: true },
        });
        expect(targetSetup.ok()).toBeTruthy();
        targetDocument = await targetSetup.json();

        const sourceBlock = sourceDocument.content.blocks[0];
        sourceBlock.text = "Source";
        sourceBlock.references = [{
            start: 0,
            end: "Source".length,
            documentId: targetDocument.id,
            blockId: targetDocument.content.blocks[0].id,
        }];
        const sourcePatch = await request.patch(`/documents/${sourceDocument.slug}/blocks`, {
            data: { revision: sourceDocument.revision, blocks: [sourceBlock], replaceAll: true },
        });
        expect(sourcePatch.ok()).toBeTruthy();

        await page.goto(`/documents/${targetDocument.slug}`);
        await waitForSaved(page);
        const targetParagraph = page.locator(".paragraph").first();
        await targetParagraph.focus();
        await expect(page.locator("#split-paragraph")).toBeDisabled();
        await targetParagraph.press("Home");
        await page.keyboard.type("Changed ");
        await expect(targetParagraph).toHaveText("Target");

        const currentTarget = await (await request.get(`/documents/${targetDocument.slug}`)).json();
        const changedBlock = { ...currentTarget.content.blocks[0], text: "Changed" };
        const targetPatch = await request.patch(`/documents/${targetDocument.slug}/blocks`, {
            data: { revision: currentTarget.revision, blocks: [changedBlock], replaceAll: true },
        });
        expect(targetPatch.status()).toBe(400);

        const formattedBlock = {
            ...currentTarget.content.blocks[0],
            marks: [{ start: 0, end: "Target".length, style: "bold" }],
        };
        const formatPatch = await request.patch(`/documents/${targetDocument.slug}/blocks`, {
            data: { revision: currentTarget.revision, blocks: [formattedBlock], replaceAll: true },
        });
        expect(formatPatch.ok()).toBeTruthy();
    } finally {
        for (const documentToDelete of [sourceDocument, targetDocument]) {
            const response = await request.get(`/documents/${documentToDelete.slug}`);
            if (response.ok()) await deleteDocument(request, await response.json());
        }
    }
});

test("incoming references modal lists and removes source references", async ({ page, request }) => {
    const targetDocument = await createDocument(request, `Playwright incoming reference target ${Date.now()}`);
    const sourceDocument = await createDocument(request, `Playwright incoming reference source ${Date.now()}`);

    try {
        const sourceBlock = sourceDocument.content.blocks[0];
        sourceBlock.text = "Source";
        sourceBlock.references = [{
            start: 0,
            end: "Source".length,
            documentId: targetDocument.id,
            blockId: targetDocument.content.blocks[0].id,
        }];
        const sourcePatch = await request.patch(`/documents/${sourceDocument.slug}/blocks`, {
            data: { revision: sourceDocument.revision, blocks: [sourceBlock], replaceAll: true },
        });
        expect(sourcePatch.ok()).toBeTruthy();

        await page.goto(`/documents/${targetDocument.slug}`);
        await waitForSaved(page);
        await page.locator(".paragraph").first().focus();
        await expect(page.locator("#incoming-references")).toBeEnabled();
        await page.locator("#incoming-references").click();
        await expect(page.locator("#incoming-references-modal")).toBeVisible();
        await expect(page.locator(".incoming-reference-item a")).toHaveText(sourceDocument.title);
        await page.locator('.incoming-reference-remove[aria-label^="Remove reference"]').click();
        await expect(page.locator(".incoming-references-empty")).toHaveText("No incoming references.");

        const sourceSaved = await (await request.get(`/documents/${sourceDocument.slug}`)).json();
        expect(sourceSaved.content.blocks[0].links ?? []).toEqual([]);
        const targetSaved = await (await request.get(`/documents/${targetDocument.slug}`)).json();
        expect(targetSaved.referencedBlockIds ?? []).toEqual([]);
    } finally {
        for (const documentToDelete of [sourceDocument, targetDocument]) {
            const response = await request.get(`/documents/${documentToDelete.slug}`);
            if (response.ok()) await deleteDocument(request, await response.json());
        }
    }
});

test("formatting offsets follow edits, splits, and merged paragraphs", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright metadata offsets ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("plain bold");
        await page.evaluate(() => {
            const paragraph = document.querySelector(".paragraph");
            const textNode = paragraph.firstChild;
            const range = document.createRange();
            range.setStart(textNode, 6);
            range.setEnd(textNode, 10);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await page.locator('.ribbon-format-button[data-format="bold"]').click();
        await waitForSaved(page);

        await paragraph.press("Home");
        await page.keyboard.type("X");
        await waitForSaved(page);
        let saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].marks).toContainEqual({ start: 7, end: 11, style: "bold" });

        await paragraph.press("Home");
        await page.keyboard.press("Delete");
        await waitForSaved(page);
        saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].marks).toContainEqual({ start: 6, end: 10, style: "bold" });

        await page.evaluate(() => {
            const paragraph = document.querySelector(".paragraph");
            const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
            let textNode = walker.nextNode();
            let offset = 8;
            while (textNode && offset > textNode.textContent.length) {
                offset -= textNode.textContent.length;
                textNode = walker.nextNode();
            }
            const range = document.createRange();
            range.setStart(textNode, offset);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            paragraph.focus();
        });
        await page.keyboard.press("Enter");
        await waitForSaved(page);
        saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.marks ?? [])).toEqual([
            [{ start: 6, end: 8, style: "bold" }],
            [{ start: 0, end: 2, style: "bold" }],
        ]);

        await page.locator(".paragraph").nth(1).press("Home");
        await page.keyboard.press("Backspace");
        await waitForSaved(page);
        saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks).toHaveLength(1);
        expect(saved.content.blocks[0].marks).toEqual([
            { start: 6, end: 8, style: "bold" },
            { start: 9, end: 11, style: "bold" },
        ]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});

test("paste preserves only editor custom formatting", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright paste ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        const blockId = await paragraph.getAttribute("data-block-id");
        await paragraph.evaluate((element, values) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", `<d-bold>Custom bold</d-bold> <d-link href="/documents/${values.documentId}#block-${values.blockId}">Internal link</d-link>`);
            clipboard.setData("text/plain", "Custom bold Internal link");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        }, { documentId: documentState.id, blockId });
        await expect(paragraph.locator("d-bold")).toHaveText("Custom bold");
        await expect(paragraph.locator("d-link")).toHaveText("Internal link");
        await waitForSaved(page);
        await page.reload();
        await waitForSaved(page);
        const plainParagraph = page.locator(".paragraph").first();
        await plainParagraph.focus();
        await plainParagraph.fill("");
        await plainParagraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", "<strong><a href=\"https://example.com\">External link</a></strong>");
            clipboard.setData("text/plain", "External link");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        });
        await expect(plainParagraph).toHaveText("External link");
        await expect(plainParagraph.locator("a, strong, b, d-bold, d-link")).toHaveCount(0);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});

test("paste preserves whitespace between adjacent formatted words", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright formatted whitespace ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        await paragraph.evaluate((element) => {
            element.focus();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", "<d-bold>Alpha</d-bold> <d-italic>Beta</d-italic>");
            clipboard.setData("text/plain", "Alpha Beta");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        });

        await expect(paragraph).toHaveText("Alpha Beta");
        await expect(paragraph.locator("d-bold")).toHaveText("Alpha");
        await expect(paragraph.locator("d-italic")).toHaveText("Beta");
        await paragraph.selectText();
        await page.keyboard.press("Control+C");
        const copied = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const item = items[0];
            return item && item.types.includes("text/html")
                ? await (await item.getType("text/html")).text()
                : "";
        });
        expect(copied).toContain("</d-bold> <d-italic>");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Alpha Beta");
        expect(saved.content.blocks[0].marks).toEqual(expect.arrayContaining([
            { start: 0, end: 5, style: "bold" },
            { start: 6, end: 10, style: "italic" },
        ]));
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("paste into a new paragraph preserves formatting and supports undo redo", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright paragraph paste ${Date.now()}`);
    const clipboardValues = {
        html: "<d-bold><d-italic><d-underline><d-strike><d-highlight>Formatted paste</d-highlight></d-strike></d-underline></d-italic></d-bold>",
        text: "Formatted paste",
    };

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.focus();
        await firstParagraph.fill("Source paragraph");
        await firstParagraph.press("End");
        await firstParagraph.press("Enter");
        await expect(page.locator(".paragraph")).toHaveCount(2);

        const newParagraph = page.locator(".paragraph").nth(1);
        await newParagraph.evaluate((element, values) => {
            element.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", values.html);
            clipboard.setData("text/plain", values.text);
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        }, clipboardValues);
        await expect(newParagraph.locator("d-bold")).toHaveText("Formatted paste");
        await expect(newParagraph.locator("d-italic")).toHaveText("Formatted paste");
        await expect(newParagraph.locator("d-underline")).toHaveText("Formatted paste");
        await expect(newParagraph.locator("d-strike")).toHaveText("Formatted paste");
        await expect(newParagraph.locator("d-highlight")).toHaveText("Formatted paste");

        await page.keyboard.press("Control+Z");
        await expect(newParagraph).toHaveText("");
        await page.keyboard.press("Control+Shift+Z");
        await expect(newParagraph.locator("d-bold")).toHaveText("Formatted paste");
        await waitForSaved(page);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});

test("paste with multiple source paragraphs creates multiple blocks", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright multi paragraph paste ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        await paragraph.evaluate((element) => {
            element.focus();
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            const clipboard = new DataTransfer();
            clipboard.setData("text/html", "<p><d-bold>First source paragraph</d-bold></p>\n\n<p> </p>\n<p><d-italic>Second source paragraph</d-italic></p>");
            clipboard.setData("text/plain", "First source paragraph\n\n\nSecond source paragraph");
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: clipboard }));
        });

        await expect(page.locator(".paragraph")).toHaveCount(2);
        await expect(page.locator(".paragraph").nth(0)).toHaveText("First source paragraph");
        await expect(page.locator(".paragraph").nth(0).locator("d-bold")).toHaveText("First source paragraph");
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Second source paragraph");
        await expect(page.locator(".paragraph").nth(1).locator("d-italic")).toHaveText("Second source paragraph");

        await page.keyboard.press("Control+Z");
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});

test("double-click selects only the word without trailing space", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright word selection ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        await paragraph.focus();
        await paragraph.fill("Alpha beta");
        await paragraph.dblclick({ position: { x: 24, y: 20 } });

        await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe("Alpha");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});
