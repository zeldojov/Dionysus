const { test, expect } = require("@playwright/test");

async function createDocument(request, title) {
    const response = await request.post("/documents", { data: { title } });
    expect(response.ok()).toBeTruthy();
    return response.json();
}

async function deleteDocument(request, documentState) {
    await request.delete(`/documents/${documentState.slug}?revision=${documentState.revision}`);
}

test.describe("d-paragraph contract", () => {
    test("exposes the expected element and initial DOM contract", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph contract ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const paragraph = page.locator("d-paragraph").first();

            await expect(paragraph).toHaveCount(1);
            await expect(paragraph).toHaveClass(/paragraph/);
            await expect(paragraph).toHaveAttribute("data-block-id", documentState.content.blocks[0].id);
            await expect(paragraph).toHaveAttribute("id", `block-${documentState.content.blocks[0].id}`);
            await expect(paragraph).toHaveAttribute("tabindex", "0");
            await expect(paragraph).toHaveAttribute("contenteditable", "false");
            await expect(paragraph).toHaveAttribute("aria-readonly", "true");
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("render binds the model and applies paragraph state", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph set block ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = {
                    id: "paragraph-contract",
                    type: "paragraph",
                    text: "Rendered by contract",
                    align: "center",
                };

                element.render(block);

                return {
                    blockReferenceIsStored: element.block === block,
                    blockId: element.blockId,
                    elementId: element.id,
                    text: element.textContent,
                    textAlign: element.style.textAlign,
                    isJustified: element.classList.contains("paragraph-justify"),
                };
            });

            expect(result).toEqual({
                blockReferenceIsStored: true,
                blockId: "paragraph-contract",
                elementId: "block-paragraph-contract",
                text: "Rendered by contract",
                textAlign: "center",
                isJustified: false,
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("render creates text, marks, links, and references from block metadata", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph render ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = {
                    id: "render-block",
                    type: "paragraph",
                    text: "Bold link ref",
                    marks: [{ start: 0, end: 4, style: "bold" }],
                    links: [{ start: 5, end: 9, url: "/documents/target" }],
                    references: [{ start: 10, end: 13, documentId: "document-2", blockId: "block-2" }],
                };
                element.render(block);

                return {
                    text: element.textContent,
                    bold: element.querySelector("d-bold")?.textContent,
                    link: {
                        text: element.querySelector("d-link")?.textContent,
                        href: element.querySelector("d-link")?.getAttribute("href"),
                    },
                    reference: {
                        text: element.querySelector("d-reference")?.textContent,
                        documentId: element.querySelector("d-reference")?.dataset.documentId,
                        blockId: element.querySelector("d-reference")?.dataset.blockId,
                    },
                };
            });

            expect(result).toEqual({
                text: "Bold link ref",
                bold: "Bold",
                link: { text: "link", href: "/documents/target" },
                reference: { text: "ref", documentId: "document-2", blockId: "block-2" },
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("setAlignment updates the block and emits block-change", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph alignment ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = { id: "alignment-block", type: "paragraph", text: "Aligned" };
                const changes = [];
                element.addEventListener("block-change", (event) => {
                    changes.push({
                        reason: event.detail.reason,
                        alignment: event.detail.alignment,
                        blockId: event.detail.block.id,
                    });
                });
                element.render(block);
                const changed = element.setAlignment("justify");
                const restored = element.setAlignment("left");

                return {
                    changed,
                    restored,
                    blockAlign: block.align ?? null,
                    textAlign: element.style.textAlign,
                    isJustified: element.classList.contains("paragraph-justify"),
                    changes,
                };
            });

            expect(result).toEqual({
                changed: true,
                restored: true,
                blockAlign: null,
                textAlign: "left",
                isJustified: false,
                changes: [
                    { reason: "alignment", alignment: "justify", blockId: "alignment-block" },
                    { reason: "alignment", alignment: "left", blockId: "alignment-block" },
                ],
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("render applies every supported alignment", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph alignment render ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                return ["left", "right", "center", "justify"].map((alignment) => {
                    element.render({
                        id: `alignment-${alignment}`,
                        type: "paragraph",
                        text: "Aligned",
                        align: alignment,
                    });
                    return {
                        alignment,
                        textAlign: element.style.textAlign,
                        isJustified: element.classList.contains("paragraph-justify"),
                    };
                });
            });

            expect(result).toEqual([
                { alignment: "left", textAlign: "left", isJustified: false },
                { alignment: "right", textAlign: "right", isJustified: false },
                { alignment: "center", textAlign: "center", isJustified: false },
                { alignment: "justify", textAlign: "justify", isJustified: true },
            ]);
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("setAlignment does nothing when the requested alignment is already active", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph alignment no-op ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = { id: "alignment-no-op", type: "paragraph", text: "Aligned" };
                let changeCount = 0;
                element.addEventListener("block-change", () => {
                    changeCount += 1;
                });
                element.render(block);
                const changed = element.setAlignment("left");

                return {
                    changed,
                    blockAlign: block.align ?? null,
                    textAlign: element.style.textAlign,
                    changeCount,
                };
            });

            expect(result).toEqual({
                changed: false,
                blockAlign: null,
                textAlign: "left",
                changeCount: 0,
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("setText updates the block and emits block-change", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph text ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = { id: "text-block", type: "paragraph", text: "Old" };
                const changes = [];
                element.addEventListener("block-change", (event) => {
                    changes.push({
                        reason: event.detail.reason,
                        blockText: event.detail.block.text,
                    });
                });
                element.render(block);
                const changed = element.setText("New\ntext");
                const unchanged = element.setText("Newtext");

                return {
                    changed,
                    unchanged,
                    blockText: block.text,
                    changes,
                };
            });

            expect(result).toEqual({
                changed: true,
                unchanged: false,
                blockText: "Newtext",
                changes: [{ reason: "text", blockText: "Newtext" }],
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("transformText applies case changes and remaps inline ranges", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph case ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = {
                    id: "case-block",
                    type: "paragraph",
                    text: "hello world",
                    marks: [{ start: 0, end: 5, style: "bold" }],
                    links: [{ start: 6, end: 11, url: "https://example.com/" }],
                    references: [{ start: 0, end: 5, documentId: "document-2", blockId: "block-2" }],
                };
                const reasons = [];
                element.addEventListener("block-change", (event) => reasons.push(event.detail.reason));
                element.render(block);
                const upper = element.transformText(0, 11, (text) => text.toUpperCase());
                const title = element.transformText(0, 11, (text) => text.toLowerCase()
                    .replace(/(^|[\s-])\p{L}/gu, (match) => match.toUpperCase()));

                return { upper, title, block, reasons };
            });

            expect(result).toEqual({
                upper: { changed: true, end: 11 },
                title: { changed: true, end: 11 },
                block: {
                    id: "case-block",
                    type: "paragraph",
                    text: "Hello World",
                    marks: [{ start: 0, end: 5, style: "bold" }],
                    links: [{ start: 6, end: 11, url: "https://example.com/" }],
                    references: [{ start: 0, end: 5, documentId: "document-2", blockId: "block-2" }],
                },
                reasons: ["text", "text"],
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("mark APIs update the block and emit changes", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph marks ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = { id: "marks-block", type: "paragraph", text: "Bold text" };
                const reasons = [];
                element.addEventListener("block-change", (event) => reasons.push(event.detail.reason));
                element.render(block);
                const added = element.toggleMark("bold", 0, 4);
                const removed = element.toggleMark("bold", 0, 4);
                element.toggleMark("italic", 0, 4);
                const cleared = element.clearMarks(0, 4);

                return { added, removed, cleared, marks: block.marks, reasons };
            });

            expect(result).toEqual({
                added: true,
                removed: false,
                cleared: true,
                marks: [],
                reasons: ["marks", "marks", "marks", "marks"],
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("link APIs add and remove external links", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph links ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = { id: "links-block", type: "paragraph", text: "Link" };
                element.render(block);
                const added = element.addLink(0, 4, "https://example.com/");
                const removed = element.removeLink(0, 4);

                return { added, removed, links: block.links };
            });

            expect(result).toEqual({ added: true, removed: true, links: [] });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("reference APIs add and remove block references", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph references ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = { id: "references-block", type: "paragraph", text: "Ref" };
                element.render(block);
                const added = element.addReference(0, 3, "document-2", "block-2");
                const removed = element.removeReference(0, 3);

                return { added, removed, references: block.references };
            });

            expect(result).toEqual({ added: true, removed: true, references: [] });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("syncContentFromDOM updates text and inline metadata", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph sync ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                const block = { id: "sync-block", type: "paragraph", text: "Old" };
                element.render(block);
                element.innerHTML = `<d-bold>Bold</d-bold><d-link href="https://example.com/"> link</d-link>` +
                    `<d-reference data-document-id="document-2" data-block-id="block-2"> ref</d-reference>`;
                const sync = element.syncContentFromDOM();

                return { sync, block };
            });

            expect(result).toEqual({
                sync: { textChanged: true },
                block: {
                    id: "sync-block",
                    type: "paragraph",
                    text: "Bold link ref",
                    marks: [{ start: 0, end: 4, style: "bold" }],
                    links: [{ start: 4, end: 9, url: "https://example.com/" }],
                    references: [{ start: 9, end: 13, documentId: "document-2", blockId: "block-2" }],
                },
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("render replaces existing content and rejects unsupported mark styles", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph render errors ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                element.textContent = "stale content";
                element.render({ id: "clean-block", type: "paragraph", text: "Fresh" });
                const cleanRender = element.textContent;

                let errorMessage = null;
                try {
                    element.render({
                        id: "invalid-block",
                        type: "paragraph",
                        text: "Bad",
                        marks: [{ start: 0, end: 3, style: "unsupported" }],
                    });
                } catch (error) {
                    errorMessage = error.message;
                }

                return { cleanRender, errorMessage };
            });

            expect(result).toEqual({
                cleanRender: "Fresh",
                errorMessage: "Unsupported paragraph mark style: unsupported",
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("setActive and setEditing control the public state attributes", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph state ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const paragraph = page.locator("d-paragraph").first();

            await paragraph.evaluate((element) => {
                element.setActive(true);
                element.setEditing(true);
            });
            await expect(paragraph).toHaveClass(/is-active/);
            await expect(paragraph).toHaveAttribute("contenteditable", "true");
            await expect(paragraph).toHaveAttribute("aria-readonly", "false");

            await paragraph.evaluate((element) => {
                element.setActive(false);
                element.setEditing(false);
            });
            await expect(paragraph).not.toHaveClass(/is-active/);
            await expect(paragraph).toHaveAttribute("contenteditable", "false");
            await expect(paragraph).toHaveAttribute("aria-readonly", "true");
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("blockId setter updates and clears the element identity", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph identity ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                element.blockId = "next-block";
                const updated = {
                    blockId: element.dataset.blockId,
                    id: element.id,
                };

                element.blockId = null;
                return {
                    updated,
                    clearedBlockId: element.dataset.blockId ?? null,
                    clearedId: element.id,
                };
            });

            expect(result).toEqual({
                updated: {
                    blockId: "next-block",
                    id: "block-next-block",
                },
                clearedBlockId: null,
                clearedId: "",
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });

    test("focusAt places the caret at the requested text offset", async ({ page, request }) => {
        const documentState = await createDocument(request, `D paragraph caret ${Date.now()}`);

        try {
            await page.goto(`/documents/${documentState.slug}`);
            const result = await page.locator("d-paragraph").first().evaluate((element) => {
                element.textContent = "Caret target";
                element.setEditing(true);
                element.focusAt(5);

                const selection = window.getSelection();
                const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
                return {
                    activeElementIsParagraph: document.activeElement === element,
                    selectedText: selection?.toString() ?? "",
                    caretOffset: range?.startOffset ?? null,
                    caretContainerText: range?.startContainer?.textContent ?? null,
                };
            });

            expect(result).toEqual({
                activeElementIsParagraph: true,
                selectedText: "",
                caretOffset: 5,
                caretContainerText: "Caret target",
            });
        } finally {
            await deleteDocument(request, documentState);
        }
    });
});
