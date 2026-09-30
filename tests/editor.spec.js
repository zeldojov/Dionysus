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

test("paragraph autosave runs when editing loses focus", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright blur autosave ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.fill("Saved on blur");
        await expect(page.locator("#save-state")).toHaveText("Unsaved");
        await page.locator("#document-title").focus();
        await expect(page.locator("#save-state")).toHaveText("Saved", { timeout: 5000 });
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

test("editor sidebar switches files and restores history previews", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright sidebar ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        await expect(page.locator("#editor-sidebar")).toBeVisible();
        await expect(page.locator(".sidebar-file.is-current .sidebar-file-title")).toHaveText(documentState.title);
        await expect(page.locator(".workspace")).toHaveCSS("margin-left", "312px");

        await page.locator("#sidebar-toggle").click();
        await expect(page.locator("#editor-sidebar")).toHaveClass(/is-hidden/);
        await expect(page.locator('[data-sidebar-tab="files"]')).toBeVisible();
        await expect(page.locator('[data-sidebar-tab="history"]')).toBeVisible();
        await expect(page.evaluate(() => localStorage.getItem("dionysus:sidebarShown"))).resolves.toBe("false");
        await expect(page.locator(".workspace")).toHaveCSS("margin-left", "84px");
        await page.locator("#sidebar-toggle").click();
        await expect(page.locator("#editor-sidebar")).not.toHaveClass(/is-hidden|is-overlay/);
        await expect(page.locator(".workspace")).toHaveCSS("margin-left", "312px");
        await page.locator("#sidebar-toggle").click();
        await expect(page.locator("#editor-sidebar")).toHaveClass(/is-hidden/);
        await page.locator('[data-sidebar-tab="history"]').click();
        await expect(page.locator("#editor-sidebar")).toHaveClass(/is-overlay/);
        await expect(page.locator("#editor-sidebar")).toHaveCSS("width", "280px");
        await expect(page.locator("#editor-sidebar")).toHaveCSS("z-index", "30");
        await expect(page.locator(".workspace")).toHaveCSS("margin-left", "84px");
        await expect(page.locator("#sidebar-history")).toBeVisible();
        await page.locator("#editor").click();
        await expect(page.locator("#editor-sidebar")).toHaveClass(/is-hidden/);
        await page.locator("#sidebar-toggle").click();
        await expect(page.locator("#editor-sidebar")).not.toHaveClass(/is-hidden|is-overlay/);
        await expect(page.evaluate(() => localStorage.getItem("dionysus:sidebarShown"))).resolves.toBe("true");
        await expect(page.locator(".workspace")).toHaveCSS("margin-left", "312px");

        await page.locator('[data-sidebar-tab="history"]').click();
        await expect(page.locator("#sidebar-history")).toBeVisible();
        const paragraph = page.locator(".paragraph").first();
        await paragraph.fill("History preview text");
        await waitForSaved(page);
        await page.locator('[data-sidebar-tab="history"]').click();
        await expect(page.locator(".history-preview")).toHaveCount(2);
        await page.locator(".history-preview").first().click();
        await expect(paragraph).toHaveText("");
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
            documentId: documentState.id,
            blockId,
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
        await expect(page.locator(".paragraph").nth(1)).toHaveText("");
        const trimmedSplit = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(trimmedSplit.content.blocks.map((block) => block.text)).toEqual(["AlphaBetaLink", ""]);
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

test("typing a trailing space preserves it in the paragraph text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright trailing space ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
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
        let saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks).toHaveLength(1);
        expect(saved.content.blocks[0].text).toBe("AlphBetaLink");
        expect(saved.content.blocks[0].marks).toEqual([{ start: 0, end: 8, style: "bold" }]);
        expect(saved.content.blocks[0].links).toEqual([{
            start: 8,
            end: 12,
            documentId: documentState.id,
            blockId,
        }]);

        await page.keyboard.press("Control+Z");
        await expect(paragraph).toHaveText("AlphaBetaLink");

        await paragraph.press("Home");
        for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await page.locator(".paragraph").nth(1).press("Home");
        await page.keyboard.press("Backspace");
        await waitForSaved(page);

        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveJSProperty("tagName", "D-PARAGRAPH");
        await expect(page.locator(".paragraph").first()).toHaveText("Alpha BetaLink");
        await expect(page.locator(".paragraph").first().locator("d-bold")).toHaveText(["Alpha", "Beta"]);
        await expect(page.locator(".paragraph").first().locator("d-link")).toHaveText("Link");
        const domResult = await page.evaluate(() => ({
            activeBlockId: document.activeElement?.dataset.blockId,
            text: document.querySelector(".paragraph")?.textContent,
            html: document.querySelector(".paragraph")?.innerHTML,
        }));
        saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        await test.info().attach("backspace-merge-result.json", {
            body: JSON.stringify({ dom: domResult, saved: saved.content.blocks }, null, 2),
            contentType: "application/json",
        });
        expect(domResult.activeBlockId).toBe(saved.content.blocks[0].id);
        expect(saved.content.blocks).toHaveLength(1);
        expect(saved.content.blocks[0].marks).toEqual([
            { start: 0, end: 5, style: "bold" },
            { start: 6, end: 10, style: "bold" },
        ]);
        expect(saved.content.blocks[0].links).toEqual([{
            start: 10,
            end: 14,
            documentId: documentState.id,
            blockId,
        }]);

        await page.keyboard.press("Control+Z");
        await expect(page.locator(".paragraph")).toHaveCount(2);
        await page.keyboard.press("Control+Shift+Z");
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await waitForSaved(page);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("Delete updates and joins paragraph blocks through DOM, metadata, persistence, and history", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright delete character ${Date.now()}`);

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
            documentId: documentState.id,
            blockId,
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
        await expect(page.locator(".paragraph").first()).toHaveText("Alpha BetaLink");
        await expect(page.locator(".paragraph").first().locator("d-bold")).toHaveText(["Alpha", "Beta"]);
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
        expect(saved.content.blocks[0].marks).toEqual([
            { start: 0, end: 5, style: "bold" },
            { start: 6, end: 10, style: "bold" },
        ]);
        expect(saved.content.blocks[0].links).toEqual([{
            start: 10,
            end: 14,
            documentId: documentState.id,
            blockId,
        }]);

        await page.keyboard.press("Control+Z");
        await expect(page.locator(".paragraph")).toHaveCount(2);
        await page.keyboard.press("Control+Shift+Z");
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await waitForSaved(page);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
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

        await firstParagraph.press("Home");
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

test("revision conflict preserves local content", async ({ browser, request }) => {
    const documentState = await createDocument(request, `Playwright conflict ${Date.now()}`);
    const firstPage = await browser.newPage();
    const secondPage = await browser.newPage();

    try {
        await firstPage.goto(`/documents/${documentState.slug}`);
        await secondPage.goto(`/documents/${documentState.slug}`);
        await waitForSaved(firstPage);
        await waitForSaved(secondPage);

        await firstPage.locator(".paragraph").first().fill("Server version");
        await waitForSaved(firstPage);

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

test("sidebar resize uses the default width for each document load", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright sidebar resize ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const sidebar = page.locator("#editor-sidebar");
        const resizeHandle = page.locator("#sidebar-resize-handle");
        await expect(sidebar).toHaveCSS("width", "280px");

        const handleBounds = await resizeHandle.boundingBox();
        if (!handleBounds) throw new Error("Sidebar resize handle is not visible");
        const startX = handleBounds.x + handleBounds.width / 2;
        const startY = handleBounds.y + handleBounds.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 100, startY);
        await page.mouse.up();

        await expect(sidebar).toHaveCSS("width", "380px");
        await expect(page.evaluate(() => localStorage.getItem("dionysus:sidebarWidth"))).resolves.toBeNull();

        await page.reload();
        await waitForSaved(page);
        await expect(page.locator("#editor-sidebar")).toHaveCSS("width", "280px");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("selected paragraph text links to another paragraph", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright links ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.fill("Open target");
        await firstParagraph.press("End");
        await firstParagraph.press("Enter");

        const paragraphs = page.locator(".paragraph");
        const targetParagraph = paragraphs.nth(1);
        await targetParagraph.fill("Target paragraph");
        await waitForSaved(page);

        const targetBlockId = await targetParagraph.getAttribute("data-block-id");
        const targetRow = targetParagraph.locator("xpath=..");
        const copyLinkButton = targetRow.getByRole("button", { name: "Copy link" });
        await copyLinkButton.click();
        await expect(copyLinkButton.locator(".material-symbols-outlined")).toHaveText("assignment_turned_in");
        const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
        expect(copiedLink).toBe(`/documents/${documentState.id}#block-${targetBlockId}`);

        await firstParagraph.selectText();
        await expect(page.locator("#selection-toolbar")).toBeVisible();
        await page.locator("#selection-toolbar").getByRole("button", { name: "Link", exact: true }).click();
        await expect(page.locator("#link-dialog")).toBeVisible();
        await page.locator("#link-dialog-input").fill(copiedLink);
        await page.locator("#link-dialog").getByRole("button", { name: "Insert link" }).click();
        await waitForSaved(page);

        const link = firstParagraph.locator("d-link");
        await expect(link).toHaveAttribute("href", `/documents/${documentState.id}#block-${targetBlockId}`);
        await link.click();
        await expect(page).toHaveURL(new RegExp(`/documents/${documentState.slug}$`));
        await link.click({ modifiers: ["Control"] });
        await expect(page).toHaveURL(new RegExp(`#block-${targetBlockId}$`));
        await expect(page.locator(`#block-${targetBlockId}`)).toBeFocused();

        const response = await request.get(`/documents/${documentState.slug}`);
        const saved = await response.json();
        expect(saved.content.blocks[0].links[0]).toEqual({
            start: 0,
            end: "Open target".length,
            documentId: documentState.id,
            blockId: targetBlockId,
        });
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});

test("selection toolbar reflects visibility, active marks, and partial clear state", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright toolbar contract ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        const toolbar = page.locator("#selection-toolbar");
        const sourceText = "Alpha beta";
        await paragraph.fill(sourceText);
        await paragraph.selectText();
        await expect(toolbar).toBeVisible();

        for (const label of ["Bold", "Italic", "Underline", "Strikethrough", "Highlight", "Subscript", "Superscript"]) {
            await expect(toolbar.locator(`button[aria-label="${label}"]`)).toHaveAttribute("aria-pressed", "false");
        }
        await expect(toolbar.locator('button[aria-label="Link"]')).toHaveAttribute("aria-pressed", "false");

        await paragraph.evaluate((element) => {
            const textNode = element.firstChild;
            const range = document.createRange();
            range.setStart(textNode, 0);
            range.setEnd(textNode, 5);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange"));
        });
        await expect(toolbar).toBeVisible();
        await toolbar.locator('button[aria-label="Bold"]').dispatchEvent("click");
        await expect(toolbar.locator('button[aria-label="Bold"]')).toHaveAttribute("aria-pressed", "true");

        await paragraph.selectText();
        await expect(toolbar.locator('button[aria-label="Bold"]')).toHaveAttribute("aria-pressed", "false");
        await paragraph.click();
        await page.evaluate(() => {
            const selection = window.getSelection();
            selection.collapseToStart();
            document.dispatchEvent(new Event("selectionchange"));
        });
        await expect(toolbar).toBeHidden();

        await paragraph.selectText();
        await paragraph.evaluate((element) => {
            const textNode = element.querySelector("d-bold").firstChild;
            const range = document.createRange();
            range.setStart(textNode, 0);
            range.setEnd(textNode, 2);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event("selectionchange"));
        });
        await expect(toolbar).toBeVisible();
        await toolbar.locator('button[aria-label="Clear formatting"]').dispatchEvent("click");
        await expect(paragraph).toHaveText(sourceText);
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe(sourceText);
        expect(saved.content.blocks[0].marks).toEqual([
            { start: 2, end: 5, style: "bold" },
        ]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("selection toolbar link button toggles a selection link off", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright toolbar link toggle ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.fill("Linked text");
        await paragraph.selectText();
        const blockId = await paragraph.getAttribute("data-block-id");

        const linkButton = page.locator('#selection-toolbar button[aria-label="Link"]');
        await linkButton.click();
        await page.locator("#link-dialog-input").fill(`/documents/${documentState.id}#block-${blockId}`);
        await page.locator("#link-dialog").getByRole("button", { name: "Insert link" }).click();
        await expect(paragraph.locator("d-link")).toHaveText("Linked text");
        await expect(linkButton).toHaveAttribute("aria-pressed", "true");

        await linkButton.click();
        await expect(paragraph.locator("d-link")).toHaveCount(0);
        await expect(linkButton).toHaveAttribute("aria-pressed", "false");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Linked text");
        expect(saved.content.blocks[0].links ?? []).toEqual([]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("text selection opens formatting toolbar and persists bold mark", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright formatting ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
        await paragraph.fill("Formatted text");
        await paragraph.selectText();
        await expect(page.locator("#selection-toolbar")).toBeVisible();
        await page.locator('#selection-toolbar button[aria-label="Bold"]').click();
        await expect(page.locator('#selection-toolbar button[aria-label="Bold"]')).toHaveAttribute("aria-pressed", "true");
        await page.locator('#selection-toolbar button[aria-label="Italic"]').click();
        await page.locator('#selection-toolbar button[aria-label="Underline"]').click();
        await page.locator('#selection-toolbar button[aria-label="Strikethrough"]').click();
        await page.locator('#selection-toolbar button[aria-label="Highlight"]').click();
        await expect(page.locator('#selection-toolbar button[aria-label="Highlight"]')).toHaveAttribute("aria-pressed", "true");
        await waitForSaved(page);

        await expect(paragraph.locator("d-bold, strong, b")).toHaveText("Formatted text");
        await expect(paragraph.locator("d-italic")).toHaveText("Formatted text");
        await expect(paragraph.locator("d-underline")).toHaveText("Formatted text");
        await expect(paragraph.locator("d-strike")).toHaveText("Formatted text");
        await expect(paragraph.locator("d-highlight, mark, span[style*='background'], b[style*='background']")).toHaveText("Formatted text");
        await paragraph.selectText();
        await page.keyboard.press("Control+C");
        const copiedMarkup = await page.evaluate(async () => {
            const items = await navigator.clipboard.read();
            const item = items[0];
            const html = item && item.types.includes("text/html") ? await (await item.getType("text/html")).text() : "";
            const text = item && item.types.includes("text/plain") ? await (await item.getType("text/plain")).text() : "";
            return { html, text };
        });
        expect(copiedMarkup.text).toBe("Formatted text");
        for (const tagName of ["d-bold", "d-italic", "d-underline", "d-strike", "d-highlight"]) {
            expect(copiedMarkup.html).toContain(`<${tagName}>`);
        }
        const response = await request.get(`/documents/${documentState.slug}`);
        const saved = await response.json();
        expect(saved.content.blocks[0].marks).toEqual(expect.arrayContaining([
            { start: 0, end: "Formatted text".length, style: "bold" },
            { start: 0, end: "Formatted text".length, style: "highlight" },
            { start: 0, end: "Formatted text".length, style: "italic" },
            { start: 0, end: "Formatted text".length, style: "underline" },
            { start: 0, end: "Formatted text".length, style: "strike" },
        ]));

        await page.locator('#selection-toolbar button[aria-label="Highlight"]').click();
        await waitForSaved(page);
        const unhighlighted = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(unhighlighted.content.blocks[0].marks).toEqual([
            { start: 0, end: "Formatted text".length, style: "bold" },
            { start: 0, end: "Formatted text".length, style: "italic" },
            { start: 0, end: "Formatted text".length, style: "underline" },
            { start: 0, end: "Formatted text".length, style: "strike" },
        ]);

        await page.locator('#selection-toolbar button[aria-label="Clear formatting"]').click();
        await waitForSaved(page);
        const cleared = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(cleared.content.blocks[0].marks ?? []).toEqual([]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) {
            await deleteDocument(request, await response.json());
        }
    }
});

test("link dialog adds a superscript reference without linking selected text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright reference ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const sourceParagraph = page.locator(".paragraph").first();
        await sourceParagraph.fill("Source text");
        await sourceParagraph.press("End");
        await sourceParagraph.press("Enter");
        const targetParagraph = page.locator(".paragraph").nth(1);
        await targetParagraph.fill("Reference target");
        await waitForSaved(page);

        const targetBlockId = await targetParagraph.getAttribute("data-block-id");
        const targetURL = `/documents/${documentState.id}#block-${targetBlockId}`;
        await sourceParagraph.selectText();
        await page.locator('#selection-toolbar button[aria-label="Link"]').click();
        await page.locator("#link-dialog-reference").check();
        await page.locator("#link-dialog-input").fill(targetURL);
        await page.locator("#link-dialog").getByRole("button", { name: "Insert link" }).click();

        await expect(sourceParagraph).toHaveText("Source text*");
        await expect(sourceParagraph.locator("d-reference")).toHaveText("*");
        await expect(sourceParagraph.locator("d-reference")).toHaveCSS("text-decoration-line", "none");
        await expect(sourceParagraph.locator("d-reference").first()).not.toContainText("Source text");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe("Source text*");
        expect(saved.content.blocks[0].links).toEqual([{
            start: "Source text".length,
            end: "Source text".length + 1,
            documentId: documentState.id,
            blockId: targetBlockId,
            reference: true,
        }]);
        await page.reload();
        await waitForSaved(page);
        const reference = page.locator(".paragraph").first().locator("d-reference");
        await expect(reference).toHaveText("*");
        await expect(reference).toHaveCSS("cursor", "pointer");
        await reference.hover();
        await expect(page.locator("#reference-preview")).toBeVisible();
        await expect(page.locator("#reference-preview-text")).toHaveText("Reference target");
        await reference.click({ modifiers: ["Control", "Shift"] });
        await expect(page).toHaveURL(new RegExp(`#block-${targetBlockId}$`));
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("subscript and superscript format selected text without changing source text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright script formatting ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        const sourceText = "H2 x2";
        await paragraph.fill(sourceText);
        await paragraph.selectText();

        await page.locator('#selection-toolbar button[aria-label="Subscript"]').click();
        await expect(paragraph.locator("d-subscript")).toHaveText(sourceText);
        await expect(paragraph).toHaveText(sourceText);

        await paragraph.selectText();
        await page.locator('#selection-toolbar button[aria-label="Superscript"]').click();
        await expect(paragraph.locator("d-superscript")).toHaveText(sourceText);
        await expect(paragraph).toHaveText(sourceText);
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe(sourceText);
        expect(saved.content.blocks[0].marks).toEqual(expect.arrayContaining([
            { start: 0, end: sourceText.length, style: "subscript" },
            { start: 0, end: sourceText.length, style: "superscript" },
        ]));
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("caps submenu transforms selected text and preserves formatting", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright caps ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.fill("hello world");
        await paragraph.selectText();
        await page.locator('#selection-toolbar button[aria-label="Bold"]').click();
        await paragraph.selectText();

        const capsButton = page.locator('#selection-toolbar button[aria-label="Change case"]');
        await capsButton.click();
        await expect(page.locator(".caps-options")).toBeVisible();
        await paragraph.selectText();
        await expect(page.locator(".caps-options")).toBeHidden();
        await capsButton.click();
        await page.locator('.caps-options button[data-caps="upper"]').click();
        await expect(paragraph).toHaveText("HELLO WORLD");
        await expect(paragraph.locator("d-bold")).toHaveText("HELLO WORLD");

        await paragraph.selectText();
        await capsButton.click();
        await page.locator('.caps-options button[data-caps="lower"]').click();
        await expect(paragraph).toHaveText("hello world");

        await paragraph.selectText();
        await capsButton.click();
        await page.locator('.caps-options button[data-caps="title"]').click();
        await expect(paragraph).toHaveText("Hello World");
        await expect(paragraph.locator("d-bold")).toHaveText("Hello World");
        await waitForSaved(page);

        await page.keyboard.press("Control+Z");
        await expect(paragraph).toHaveText("hello world");
        await page.keyboard.press("Control+Shift+Z");
        await expect(paragraph).toHaveText("Hello World");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("paragraph alignment persists without changing source text", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright alignment ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        const paragraphRow = paragraph.locator("..");
        const initialLayout = await paragraph.evaluate((element) => {
            const row = element.parentElement;
            const tools = row.querySelector(".paragraph-tools");
            return {
                paddingRight: getComputedStyle(element).paddingRight,
                toolsOpacity: getComputedStyle(tools).opacity,
                toolsRight: tools.getBoundingClientRect().right,
                rowRight: row.getBoundingClientRect().right,
                toolsBottom: tools.getBoundingClientRect().bottom,
                paragraphTop: element.getBoundingClientRect().top,
            };
        });
        expect(initialLayout.paddingRight).toBe("12px");
        expect(initialLayout.toolsOpacity).toBe("0");
        expect(initialLayout.toolsRight).toBeCloseTo(initialLayout.rowRight - 25, 0);
        expect(initialLayout.toolsBottom).toBeLessThanOrEqual(initialLayout.paragraphTop + 1);
        const sourceText = "psihologije psihologije";
        await paragraph.fill(sourceText);
        await paragraph.selectText();
        await expect.poll(() => paragraph.evaluate((element) => getComputedStyle(element.parentElement.querySelector(".paragraph-tools")).opacity)).toBe("1");

        await paragraphRow.locator('.paragraph-align-button[title="Align justify"]').click();
        await expect(paragraph).toHaveCSS("text-align", "justify");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks[0].text).toBe(sourceText);
        expect(saved.content.blocks[0].align).toBe("justify");

        await paragraph.selectText();
        await paragraphRow.locator('.paragraph-align-button[title="Align center"]').click();
        await expect(paragraph).toHaveCSS("text-align", "center");
        await waitForSaved(page);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("paragraph toolbar button splits at the current caret", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright split button ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const paragraph = page.locator(".paragraph").first();
        await paragraph.fill("Alpha Beta");
        await paragraph.press("Home");
        for (let index = 0; index < 6; index += 1) await paragraph.press("ArrowRight");

        const paragraphRow = paragraph.locator("xpath=..");
        await paragraphRow.getByRole("button", { name: "Split paragraph" }).click();
        await expect(page.locator(".paragraph")).toHaveCount(2);
        await expect(page.locator(".paragraph").nth(0)).toHaveText("Alpha");
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Beta");
        await waitForSaved(page);
        await page.locator('[data-sidebar-tab="history"]').click();
        await expect(page.locator(".history-preview-header strong").filter({ hasText: "Paragraph split" })).toHaveCount(2);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["Alpha", "Beta"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("paragraph toolbar split keeps the new paragraph after the active block", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright split position ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.fill("First");
        await firstParagraph.press("End");
        await firstParagraph.press("Enter");

        const activeParagraph = page.locator(".paragraph").nth(1);
        await activeParagraph.fill("Alpha Beta");
        await activeParagraph.press("Home");
        for (let index = 0; index < 6; index += 1) await activeParagraph.press("ArrowRight");
        await activeParagraph.locator("xpath=..").getByRole("button", { name: "Split paragraph" }).click();

        await expect(page.locator(".paragraph")).toHaveCount(3);
        await expect(page.locator(".paragraph").nth(0)).toHaveText("First");
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Alpha");
        await expect(page.locator(".paragraph").nth(2)).toHaveText("Beta");
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("paragraph toolbar merges only adjacent paragraph blocks", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright merge buttons ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);
        const firstParagraph = page.locator(".paragraph").first();
        await firstParagraph.fill("One");
        await firstParagraph.press("End");
        await firstParagraph.press("Enter");
        const secondParagraph = page.locator(".paragraph").nth(1);
        await secondParagraph.fill("Two");
        await secondParagraph.press("End");
        await secondParagraph.press("Enter");
        await page.locator(".paragraph").nth(2).fill("Three");

        const middleRow = page.locator(".paragraph").nth(1).locator("xpath=..");
        await page.locator(".paragraph").nth(1).focus();
        await expect(middleRow.getByRole("button", { name: "Merge with above" })).toBeEnabled();
        await expect(middleRow.getByRole("button", { name: "Merge with below" })).toBeEnabled();
        await expect(page.locator(".paragraph").first().locator("xpath=..").getByRole("button", { name: "Merge with above" })).toBeDisabled();
        await expect(page.locator(".paragraph").nth(2).locator("xpath=..").getByRole("button", { name: "Merge with below" })).toBeDisabled();

        await middleRow.getByRole("button", { name: "Merge with below" }).click();
        await expect(page.locator(".paragraph")).toHaveCount(2);
        await expect(page.locator(".paragraph").nth(1)).toHaveText("Two Three");

        await page.locator(".paragraph").nth(1).locator("xpath=..").getByRole("button", { name: "Merge with above" }).click();
        await expect(page.locator(".paragraph")).toHaveCount(1);
        await expect(page.locator(".paragraph").first()).toHaveText("One Two Three");
        await waitForSaved(page);

        const saved = await (await request.get(`/documents/${documentState.slug}`)).json();
        expect(saved.content.blocks.map((block) => block.text)).toEqual(["One Two Three"]);
    } finally {
        const response = await request.get(`/documents/${documentState.slug}`);
        if (response.ok()) await deleteDocument(request, await response.json());
    }
});

test("formatting offsets follow edits, splits, and merged paragraphs", async ({ page, request }) => {
    const documentState = await createDocument(request, `Playwright metadata offsets ${Date.now()}`);

    try {
        await page.goto(`/documents/${documentState.slug}`);
        await waitForSaved(page);

        const paragraph = page.locator(".paragraph").first();
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
        await page.locator('#selection-toolbar button[aria-label="Bold"]').click();
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
        await page.locator('[data-sidebar-tab="history"]').click();
        await expect(page.locator(".history-preview-header strong").filter({ hasText: "Text paste" })).toHaveCount(2);

        await page.reload();
        await waitForSaved(page);
        const plainParagraph = page.locator(".paragraph").first();
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
