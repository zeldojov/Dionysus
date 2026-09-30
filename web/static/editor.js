const editor = document.querySelector("#editor");
const saveState = document.querySelector("#save-state");
const revisionLabel = document.querySelector("#document-revision");
const documentTitle = document.querySelector("#document-title");
const undoButton = document.querySelector("#undo");
const redoButton = document.querySelector("#redo");
const selectionToolbar = document.querySelector("#selection-toolbar");
const linkDialog = document.querySelector("#link-dialog");
const linkDialogForm = document.querySelector("#link-dialog-form");
const linkDialogInput = document.querySelector("#link-dialog-input");
const linkDialogReference = document.querySelector("#link-dialog-reference");
const referencePreview = document.querySelector("#reference-preview");
const referencePreviewText = document.querySelector("#reference-preview-text");
const linkDialogError = document.querySelector("#link-dialog-error");
const documentSizeLimit = document.querySelector("#document-size-limit");
const documentBlockLimit = document.querySelector("#document-block-limit");
const editorSidebar = document.querySelector("#editor-sidebar");
const sidebarToggle = document.querySelector("#sidebar-toggle");
const sidebarResizeHandle = document.querySelector("#sidebar-resize-handle");
const sidebarFilesFilter = document.querySelector("#sidebar-files-filter");
const sidebarFilesList = document.querySelector("#sidebar-files-list");
const sidebarHistoryList = document.querySelector("#sidebar-history-list");
const { mergeMetadataRanges, normalizeBlockWhitespace, removeMetadataRange, splitRanges } = window.EditorTransforms;

for (const tagName of ["d-paragraph", "d-bold", "d-italic", "d-underline", "d-strike", "d-highlight", "d-subscript", "d-superscript", "d-link", "d-reference"]) {
    customElements.define(tagName, class extends HTMLElement { });
}

const state = {
    documentId: null,
    title: "Untitled document",
    slug: null,
    content: null,
    syncedContent: null,
    revision: 0,
    saveTimer: null,
    saveInFlight: false,
    saveQueued: false,
    undoStack: [],
    redoStack: [],
    lastOperation: "Initial document",
    contentDirty: false,
    activeBlockId: null,
    pointerDownBlockId: null,
    suppressClickBlockId: null,
    copiedBlockId: null,
    copyResetTimer: null,
    historySuppressed: false,
    pendingLink: null,
    savedSelection: null,
};

document.addEventListener("mouseup", () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
        const anchorElement = selection.anchorNode instanceof Element
            ? selection.anchorNode
            : selection.anchorNode?.parentElement;
        state.suppressClickBlockId = anchorElement?.closest(".paragraph")?.dataset.blockId ?? null;
    }
    state.pointerDownBlockId = null;
});

const historyLimit = 100;
const safetySaveDelay = 2000;
const maxDocumentRequestBytes = 1 << 20;
const maxDocumentBlockCount = 10000;
const maxParagraphRunes = 5000;
const maxParagraphMarks = 50;
const maxParagraphLinks = 20;
let sidebarCollapseTimer = null;
let sidebarDocuments = [];
let sidebarShown = localStorage.getItem("dionysus:sidebarShown") !== "false";
let sidebarResizeState = null;
let referencePreviewTimer = null;
let activeReference = null;
const referencePreviewCache = new Map();

document.addEventListener("DOMContentLoaded", initialize);
document.addEventListener("keydown", handleHistoryShortcut);
document.addEventListener("keydown", handleLinkModifierKey);
document.addEventListener("keyup", handleLinkModifierKey);
window.addEventListener("blur", clearLinkModifier);
document.addEventListener("selectionchange", handleSelectionChange);
document.addEventListener("mousedown", handleToolbarMouseDown);
document.addEventListener("click", handleSidebarOutsideClick);
document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
window.addEventListener("pagehide", flushPendingSave);
applySidebarState();
undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
selectionToolbar.addEventListener("click", handleToolbarClick);
selectionToolbar.addEventListener("focusout", handleToolbarFocusOut);
linkDialogForm.addEventListener("submit", handleLinkDialogSubmit);
linkDialog.addEventListener("click", (event) => {
    if (event.target === linkDialog) closeLinkDialog();
});
document.addEventListener("keydown", handleLinkDialogKeydown);
document.querySelector("#link-dialog-close").addEventListener("click", closeLinkDialog);
document.querySelector("#link-dialog-cancel").addEventListener("click", closeLinkDialog);
sidebarToggle.addEventListener("click", toggleSidebar);
sidebarFilesFilter.addEventListener("input", () => renderSidebarFiles(sidebarFilesFilter.value));
sidebarResizeHandle.addEventListener("pointerdown", handleSidebarResizeStart);
sidebarResizeHandle.addEventListener("keydown", handleSidebarResizeKeydown);
editorSidebar.addEventListener("focusout", handleSidebarFocusOut);
for (const tab of editorSidebar.querySelectorAll("[data-sidebar-tab]")) {
    tab.addEventListener("click", () => selectSidebarTab(tab.dataset.sidebarTab));
}

function handleLinkModifierKey(event) {
    if (event.key === "Control" || event.key === "Meta") {
        document.body.classList.toggle("link-modifier-active", event.type === "keydown");
    }
}

function clearLinkModifier() {
    document.body.classList.remove("link-modifier-active");
}

async function initialize() {
    setSaveState("Loading", "loading");
    resetSidebarWidth();

    try {
        const pathIdentifier = getPathIdentifier();
        const lastSlug = localStorage.getItem("dionysus:lastDocumentSlug");
        const documentState = pathIdentifier
            ? await loadDocument(pathIdentifier)
            : lastSlug
                ? await loadDocument(lastSlug)
                : await createDocument();

        state.documentId = documentState.id;
        state.title = documentState.title;
        state.slug = documentState.slug;
        const recoveredContent = readRecovery(documentState.id);
        state.syncedContent = cloneContent(documentState.content);
        state.content = recoveredContent ?? documentState.content;
        state.revision = documentState.revision;
        updateDocumentLimitMeters();
        state.undoStack = [];
        state.redoStack = [];
        state.contentDirty = false;
        state.activeBlockId = state.content.blocks[0]?.id ?? null;
        documentTitle.value = documentState.title;
        localStorage.setItem("dionysus:lastDocumentSlug", documentState.slug);
        history.replaceState(null, "", `/documents/${encodeURIComponent(documentState.slug)}${window.location.hash}`);
        const repairedLegacyOffsets = repairLegacyOffsetBlocks(state.content);
        render();
        focusHashTarget();
        updateHistoryButtons();
        loadFiles();
        if (recoveredContent || repairedLegacyOffsets) {
            queueSave();
        } else {
            setSaveState("Saved", "saved");
        }
    } catch (error) {
        console.error(error);
        setSaveState("Unable to load", "error");
    }
}

documentTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        documentTitle.blur();
    }
});
documentTitle.addEventListener("blur", renameDocument);

async function createDocument() {
    const response = await fetch("/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled document" }),
    });
    if (!response.ok) {
        throw new Error(`Create document failed: ${response.status}`);
    }
    return response.json();
}

async function loadDocument(identifier) {
    const response = await fetch(`/documents/${encodeURIComponent(identifier)}`);
    if (!response.ok) {
        throw new Error(`Load document failed: ${response.status}`);
    }
    return response.json();
}

async function loadFiles() {
    try {
        const response = await fetch("/documents");
        if (!response.ok) throw new Error(`Load documents failed: ${response.status}`);
        sidebarDocuments = await response.json();
        renderSidebarFiles(sidebarFilesFilter.value);
    } catch (error) {
        console.error(error);
        renderSidebarEmpty(sidebarFilesList, "Unable to load documents");
    }
}

function renderSidebarFiles(query = "") {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const documents = sidebarDocuments.filter((documentSummary) => matchesFileTitle(documentSummary.title, normalizedQuery));
    sidebarFilesList.replaceChildren();
    for (const documentSummary of documents) {
        const link = document.createElement("a");
        link.className = "sidebar-file";
        link.href = `/documents/${encodeURIComponent(documentSummary.slug)}`;
        link.setAttribute("role", "listitem");
        link.classList.toggle("is-current", documentSummary.slug === state.slug);
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "description";
        const title = document.createElement("span");
        title.className = "sidebar-file-title";
        title.textContent = documentSummary.title;
        link.append(icon, title);
        sidebarFilesList.append(link);
    }
    if (documents.length === 0) {
        renderSidebarEmpty(sidebarFilesList, normalizedQuery ? "No matching documents" : "No documents yet");
    }
}

function matchesFileTitle(title, query) {
    if (!query) return true;
    const normalizedTitle = title.toLocaleLowerCase();
    if (normalizedTitle.includes(query)) return true;
    let queryIndex = 0;
    for (const character of normalizedTitle) {
        if (character === query[queryIndex]) queryIndex += 1;
        if (queryIndex === query.length) return true;
    }
    return false;
}

function toggleSidebar() {
    window.clearTimeout(sidebarCollapseTimer);
    sidebarCollapseTimer = null;
    if (editorSidebar.classList.contains("is-overlay")) {
        closeTemporarySidebar();
        return;
    }
    if (!sidebarShown) {
        sidebarShown = true;
        localStorage.setItem("dionysus:sidebarShown", "true");
        applySidebarState();
        return;
    }
    sidebarShown = !sidebarShown;
    localStorage.setItem("dionysus:sidebarShown", String(sidebarShown));
    applySidebarState();
}

function resetSidebarWidth() {
    editorSidebar.style.removeProperty("--sidebar-width");
    editorSidebar.classList.remove("is-resizing");
}

function getSidebarWidth() {
    return editorSidebar.getBoundingClientRect().width;
}

function getSidebarDefaultWidth() {
    return Number.parseFloat(getComputedStyle(editorSidebar).getPropertyValue("--sidebar-default-width")) || 280;
}

function setSidebarWidth(width) {
    const boundedWidth = Math.max(getSidebarDefaultWidth(), Math.min(520, width));
    editorSidebar.style.setProperty("--sidebar-width", `${boundedWidth}px`);
}

function handleSidebarResizeStart(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizeState = { startX: event.clientX, startWidth: getSidebarWidth() };
    editorSidebar.classList.add("is-resizing");
    sidebarResizeHandle.setPointerCapture(event.pointerId);
    sidebarResizeHandle.addEventListener("pointermove", handleSidebarResizeMove);
    sidebarResizeHandle.addEventListener("pointerup", handleSidebarResizeEnd, { once: true });
    sidebarResizeHandle.addEventListener("pointercancel", handleSidebarResizeEnd, { once: true });
}

function handleSidebarResizeMove(event) {
    if (!sidebarResizeState) return;
    setSidebarWidth(sidebarResizeState.startWidth + event.clientX - sidebarResizeState.startX);
}

function handleSidebarResizeEnd() {
    sidebarResizeState = null;
    editorSidebar.classList.remove("is-resizing");
    sidebarResizeHandle.removeEventListener("pointermove", handleSidebarResizeMove);
}

function handleSidebarResizeKeydown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    const width = event.key === "Home"
        ? getSidebarDefaultWidth()
        : getSidebarWidth() + (event.key === "ArrowRight" ? 20 : -20);
    setSidebarWidth(width);
}

function handleSidebarFocusOut(event) {
    if (!event.relatedTarget || editorSidebar.contains(event.relatedTarget)) return;
    closeTemporarySidebar();
}

function handleSidebarOutsideClick(event) {
    if (!editorSidebar.classList.contains("is-overlay")) return;
    if (editorSidebar.contains(event.target) || sidebarToggle.contains(event.target)) return;
    window.clearTimeout(sidebarCollapseTimer);
    sidebarCollapseTimer = window.setTimeout(() => {
        sidebarCollapseTimer = null;
        closeTemporarySidebar();
    }, 200);
}

function selectSidebarTab(tabName) {
    if (editorSidebar.classList.contains("is-hidden")) {
        editorSidebar.classList.remove("is-hidden");
        editorSidebar.classList.add("is-overlay");
        updateSidebarToggle();
    }
    for (const tab of editorSidebar.querySelectorAll("[data-sidebar-tab]")) {
        const active = tab.dataset.sidebarTab === tabName;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
    }
    for (const panel of editorSidebar.querySelectorAll("[data-sidebar-panel]")) {
        panel.hidden = panel.dataset.sidebarPanel !== tabName;
    }
}

function applySidebarState() {
    document.documentElement.classList.toggle("sidebar-hidden", !sidebarShown);
    editorSidebar.classList.toggle("is-hidden", !sidebarShown);
    editorSidebar.classList.remove("is-overlay");
    updateSidebarToggle();
}

function closeTemporarySidebar() {
    if (!editorSidebar.classList.contains("is-overlay")) return;
    window.clearTimeout(sidebarCollapseTimer);
    sidebarCollapseTimer = null;
    editorSidebar.classList.remove("is-overlay");
    editorSidebar.classList.add("is-hidden");
    updateSidebarToggle();
}

function updateSidebarToggle() {
    const temporary = editorSidebar.classList.contains("is-overlay");
    const visible = sidebarShown || temporary;
    sidebarToggle.setAttribute("aria-expanded", String(visible));
    sidebarToggle.setAttribute("aria-label", sidebarShown ? "Hide sidebar" : "Show sidebar");
    sidebarToggle.title = sidebarShown ? "Hide sidebar" : "Show sidebar";
    sidebarToggle.querySelector(".material-symbols-outlined").textContent = visible
        ? "left_panel_close"
        : "left_panel_open";
}

function renderSidebarEmpty(container, message) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = message;
    container.replaceChildren(empty);
}

function getPathIdentifier() {
    const match = window.location.pathname.match(/^\/documents\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function focusHashTarget() {
    const targetID = decodeURIComponent(window.location.hash.slice(1));
    if (!targetID) {
        return;
    }

    const target = document.getElementById(targetID);
    if (target) {
        target.scrollIntoView({ block: "center" });
        target.focus();
    }
}

function render(focusBlockId = null, cursorOffset = null) {
    editor.replaceChildren();

    if (focusBlockId !== null) {
        state.activeBlockId = focusBlockId;
    }
    if (!state.content.blocks.some((block) => block.id === state.activeBlockId)) {
        state.activeBlockId = state.content.blocks[0]?.id ?? null;
    }

    for (const block of state.content.blocks) {
        const paragraph = document.createElement("d-paragraph");
        paragraph.className = "paragraph";
        const isActive = block.id === state.activeBlockId;
        paragraph.classList.toggle("is-active", isActive);
        paragraph.classList.toggle("paragraph-justify", block.align === "justify");
        paragraph.style.textAlign = block.align || "left";
        paragraph.contentEditable = String(isActive);
        paragraph.tabIndex = 0;
        paragraph.setAttribute("aria-readonly", String(!isActive));
        paragraph.dataset.blockId = block.id;
        paragraph.id = `block-${block.id}`;
        renderParagraphContent(paragraph, block);
        paragraph.addEventListener("mousedown", (event) => {
            if (event.button === 0 && state.activeBlockId !== block.id) {
                state.pointerDownBlockId = block.id;
            }
        });
        paragraph.addEventListener("click", (event) => {
            if (state.suppressClickBlockId === block.id) {
                state.suppressClickBlockId = null;
                return;
            }
            if (state.activeBlockId !== block.id) {
                const clientX = event.clientX;
                const clientY = event.clientY;
                setTimeout(() => {
                    if (state.activeBlockId === block.id) {
                        return;
                    }
                    const selection = window.getSelection();
                    const hasSelection = selection && !selection.isCollapsed
                        && paragraph.contains(selection.anchorNode)
                        && paragraph.contains(selection.focusNode);
                    if (!hasSelection) {
                        activateBlock(block.id, getCaretOffsetFromPoint(paragraph, clientX, clientY));
                    }
                }, 0);
            }
        });
        paragraph.addEventListener("focus", () => {
            if (state.activeBlockId !== block.id && state.pointerDownBlockId !== block.id) {
                activateBlock(block.id, paragraph.textContent.length);
            }
        });
        paragraph.addEventListener("input", handleInput);
        paragraph.addEventListener("blur", handleParagraphBlur);
        paragraph.addEventListener("beforeinput", handleBeforeInput);
        paragraph.addEventListener("copy", handleCopy);
        paragraph.addEventListener("paste", handlePaste);
        paragraph.addEventListener("keydown", handleKeydown);
        paragraph.addEventListener("dblclick", handleDoubleClick);

        const row = document.createElement("div");
        row.className = "paragraph-row";

        const paragraphTools = document.createElement("div");
        paragraphTools.className = "paragraph-tools";
        const alignmentTools = document.createElement("div");
        alignmentTools.className = "paragraph-align-tools";
        for (const alignment of ["left", "center", "right", "justify"]) {
            const alignmentButton = document.createElement("button");
            alignmentButton.className = "paragraph-align-button";
            alignmentButton.type = "button";
            alignmentButton.setAttribute("aria-label", `Align ${alignment}`);
            alignmentButton.title = `Align ${alignment}`;
            alignmentButton.setAttribute("aria-pressed", String((block.align || "left") === alignment));
            const alignmentIcon = document.createElement("span");
            alignmentIcon.className = "material-symbols-outlined";
            alignmentIcon.setAttribute("aria-hidden", "true");
            alignmentIcon.textContent = `format_align_${alignment}`;
            alignmentButton.append(alignmentIcon);
            alignmentButton.addEventListener("click", () => applyParagraphAlignment(block.id, alignment));
            alignmentTools.append(alignmentButton);
        }

        const splitButton = document.createElement("button");
        splitButton.className = "paragraph-split-button";
        splitButton.type = "button";
        splitButton.setAttribute("aria-label", "Split paragraph");
        splitButton.title = "Split paragraph";
        const splitIcon = document.createElement("span");
        splitIcon.className = "material-symbols-outlined";
        splitIcon.setAttribute("aria-hidden", "true");
        splitIcon.textContent = "height";
        splitButton.append(splitIcon);
        let splitPosition = null;
        splitButton.addEventListener("mousedown", (event) => {
            event.preventDefault();
            splitPosition = getSelectionPosition(paragraph);
        });
        splitButton.addEventListener("click", () => {
            const position = splitPosition ?? getSelectionPosition(paragraph);
            const currentBlock = findBlock(block.id);
            splitPosition = null;
            if (!position || !currentBlock) return;
            splitParagraph(currentBlock, position.start, position.end);
        });

        const mergeAboveButton = createMergeButton("above", block, paragraph);
        const mergeBelowButton = createMergeButton("below", block, paragraph);

        const copyLinkButton = document.createElement("button");
        copyLinkButton.className = "copy-link-floating";
        copyLinkButton.type = "button";
        copyLinkButton.setAttribute("aria-label", "Copy link");
        copyLinkButton.title = "Copy link";
        const copyIcon = document.createElement("span");
        copyIcon.className = "material-symbols-outlined";
        copyIcon.setAttribute("aria-hidden", "true");
        copyIcon.textContent = state.copiedBlockId === block.id ? "assignment_turned_in" : "assignment";
        copyLinkButton.append(copyIcon);
        copyLinkButton.addEventListener("click", () => copyParagraphLink(block, copyLinkButton));

        const paragraphMetrics = document.createElement("div");
        paragraphMetrics.className = "paragraph-metrics";
        paragraphMetrics.setAttribute("role", "status");
        paragraphMetrics.setAttribute("aria-live", "polite");
        updateParagraphMetrics(paragraphMetrics, block);

        const paragraphActions = document.createElement("div");
        paragraphActions.className = "paragraph-actions";
        paragraphActions.append(alignmentTools, splitButton, mergeAboveButton, mergeBelowButton, copyLinkButton);
        paragraphTools.append(paragraphActions);
        row.append(paragraph, paragraphTools, paragraphMetrics);
        row.classList.toggle("is-active", isActive);
        editor.append(row);
    }

    if (focusBlockId !== null) {
        const paragraph = findParagraph(focusBlockId);
        if (paragraph) {
            focusAt(paragraph, cursorOffset ?? paragraph.textContent.length);
        }
    }
}

function activateBlock(blockId, cursorOffset = null) {
    state.activeBlockId = blockId;
    for (const paragraph of editor.querySelectorAll(".paragraph")) {
        const isActive = paragraph.dataset.blockId === blockId;
        paragraph.classList.toggle("is-active", isActive);
        paragraph.contentEditable = String(isActive);
        paragraph.setAttribute("aria-readonly", String(!isActive));
        paragraph.parentElement?.classList.toggle("is-active", isActive);
    }
    if (cursorOffset !== null) {
        const paragraph = findParagraph(blockId);
        if (paragraph) {
            focusAt(paragraph, cursorOffset);
        }
    }
}

function updateParagraphMetrics(metricsElement, block) {
    const characterCount = Array.from(block.text).length;
    const wordCount = block.text.trim() === "" ? 0 : block.text.trim().split(/\s+/u).length;
    const markCount = block.marks?.length ?? 0;
    const linkCount = block.links?.length ?? 0;
    metricsElement.textContent = `${characterCount.toLocaleString("sr-Latn")} / ${maxParagraphRunes.toLocaleString("sr-Latn")} znakova · ${wordCount.toLocaleString("sr-Latn")} reči · ${markCount} / ${maxParagraphMarks} formatiranja · ${linkCount} / ${maxParagraphLinks} linkova`;
}

function createMergeButton(direction, block, paragraph) {
    const button = document.createElement("button");
    button.className = "paragraph-merge-button";
    button.classList.add(`paragraph-merge-${direction}`);
    button.type = "button";
    button.setAttribute("aria-label", `Merge with ${direction}`);
    button.title = `Merge with ${direction}`;
    button.disabled = !canMergeParagraph(block, direction, paragraph, false);
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = direction === "above" ? "vertical_align_top" : "vertical_align_bottom";
    button.append(icon);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => mergeParagraph(block.id, direction));
    return button;
}

function canMergeParagraph(block, direction, paragraph = findParagraph(block.id), requireDOM = true) {
    const index = state.content.blocks.indexOf(block);
    const adjacentIndex = direction === "above" ? index - 1 : index + 1;
    if (index < 0 || adjacentIndex < 0 || adjacentIndex >= state.content.blocks.length) {
        return false;
    }

    const adjacentBlock = state.content.blocks[adjacentIndex];
    const adjacentParagraph = adjacentBlock && findParagraph(adjacentBlock.id);
    if (!adjacentBlock) {
        return false;
    }
    if (!requireDOM) {
        return true;
    }
    return paragraph?.tagName === "D-PARAGRAPH"
        && adjacentParagraph?.tagName === "D-PARAGRAPH";
}

function mergeParagraph(blockId, direction) {
    const block = findBlock(blockId);
    if (!block || !canMergeParagraph(block, direction)) {
        return;
    }

    const index = state.content.blocks.indexOf(block);
    const adjacentIndex = direction === "above" ? index - 1 : index + 1;
    const adjacentBlock = state.content.blocks[adjacentIndex];
    const target = direction === "above" ? adjacentBlock : block;
    const source = direction === "above" ? block : adjacentBlock;
    const targetLength = target.text.length;

    recordHistory(`Paragraph merge ${direction}`);
    target.text += ` ${source.text}`;
    target.marks = mergeMetadataRanges(target.marks, source.marks, targetLength + 1);
    target.links = mergeMetadataRanges(target.links, source.links, targetLength + 1);
    state.content.blocks.splice(direction === "above" ? index : adjacentIndex, 1);
    const cursorOffset = normalizeBlockWhitespace(target, targetLength + 1);
    render(target.id, cursorOffset);
    queueSave();
}

function applyParagraphAlignment(blockId, alignment) {
    const block = findBlock(blockId);
    const paragraph = findParagraph(blockId);
    if (!block || !paragraph || (block.align || "left") === alignment) return;

    recordHistory(`Paragraph alignment: ${alignment}`);
    if (alignment === "left") {
        delete block.align;
    } else {
        block.align = alignment;
    }
    paragraph.style.textAlign = alignment;
    paragraph.classList.toggle("paragraph-justify", alignment === "justify");
    for (const button of paragraph.parentElement.querySelectorAll(".paragraph-align-button")) {
        button.setAttribute("aria-pressed", String(button.title === `Align ${alignment}`));
    }
    queueSave();
}

function renderParagraphContent(paragraph, block) {
    const boundaries = new Set([0, block.text.length]);
    for (const range of [...(block.marks ?? []), ...(block.links ?? [])]) {
        boundaries.add(range.start);
        boundaries.add(range.end);
    }
    const points = [...boundaries].sort((left, right) => left - right);

    for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        if (start === end) {
            continue;
        }
        const text = block.text.slice(start, end);
        const marks = (block.marks ?? []).filter((mark) => mark.start <= start && mark.end >= end);
        const link = (block.links ?? []).find((candidate) => candidate.start <= start && candidate.end >= end);
        let node = document.createTextNode(text);
        for (const mark of marks) {
            const element = document.createElement(markElement(mark.style));
            element.append(node);
            node = element;
        }
        if (link) {
            const linkElement = document.createElement(link.reference ? "d-reference" : "d-link");
            linkElement.setAttribute("href", `/documents/${encodeURIComponent(link.documentId)}#block-${encodeURIComponent(link.blockId)}`);
            linkElement.contentEditable = "true";
            linkElement.addEventListener("click", handleParagraphLinkClick);
            if (link.reference) {
                linkElement.addEventListener("mouseenter", () => showReferencePreview(linkElement));
                linkElement.addEventListener("mouseleave", scheduleHideReferencePreview);
                linkElement.addEventListener("focus", () => showReferencePreview(linkElement));
                linkElement.addEventListener("blur", scheduleHideReferencePreview);
            }
            linkElement.append(node);
            node = linkElement;
        }
        paragraph.append(node);
    }
}

referencePreview.addEventListener("mouseenter", () => window.clearTimeout(referencePreviewTimer));
referencePreview.addEventListener("mouseleave", scheduleHideReferencePreview);

function showReferencePreview(reference) {
    window.clearTimeout(referencePreviewTimer);
    activeReference = reference;
    referencePreviewText.textContent = "Loading...";
    referencePreview.hidden = false;
    positionReferencePreview(reference);

    const target = parseParagraphLink(reference.getAttribute("href") ?? "");
    if (!target) return;
    const cacheKey = `${target.documentId}:${target.blockId}`;
    if (referencePreviewCache.has(cacheKey)) {
        referencePreviewText.textContent = referencePreviewCache.get(cacheKey);
        positionReferencePreview(reference);
        return;
    }

    loadDocument(target.documentId).then((documentState) => {
        const block = documentState.content.blocks.find((candidate) => candidate.id === target.blockId);
        const text = block?.text || "Empty paragraph";
        referencePreviewCache.set(cacheKey, text);
        if (activeReference === reference) {
            referencePreviewText.textContent = text;
            positionReferencePreview(reference);
        }
    }).catch(() => {
        if (activeReference === reference) referencePreviewText.textContent = "Unable to load paragraph";
    });
}

function positionReferencePreview(reference) {
    const bounds = reference.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12));
    const top = bounds.bottom + 10;
    referencePreview.style.left = `${left}px`;
    referencePreview.style.top = `${top}px`;
    referencePreview.style.width = `${width}px`;
}

function scheduleHideReferencePreview() {
    window.clearTimeout(referencePreviewTimer);
    referencePreviewTimer = window.setTimeout(() => {
        activeReference = null;
        referencePreview.hidden = true;
    }, 140);
}

function handleParagraphLinkClick(event) {
    const href = event.currentTarget.getAttribute("href");
    if (!href) {
        event.preventDefault();
        return;
    }

    if (event.currentTarget.tagName === "D-REFERENCE") {
        event.preventDefault();
        window.location.assign(href);
        return;
    }

    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (event.shiftKey) {
            window.open(href, "_blank", "noopener");
        } else {
            window.location.assign(href);
        }
        return;
    }
    event.preventDefault();
}

function handleCopy(event) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return;
    }

    const range = selection.getRangeAt(0);
    const paragraph = event.currentTarget;
    if (!paragraph.contains(range.commonAncestorContainer)) {
        return;
    }

    const container = document.createElement("div");
    container.append(range.cloneContents());
    event.clipboardData.setData("text/plain", range.toString());
    event.clipboardData.setData("text/html", container.innerHTML);
    event.preventDefault();
}

const pasteEditorTags = new Set(["D-BOLD", "D-ITALIC", "D-UNDERLINE", "D-STRIKE", "D-HIGHLIGHT", "D-SUBSCRIPT", "D-SUPERSCRIPT", "D-LINK", "D-REFERENCE"]);

function handlePaste(event) {
    const clipboard = event.clipboardData;
    if (!clipboard) {
        return;
    }

    const html = clipboard.getData("text/html");
    const plainText = clipboard.getData("text/plain");
    if (!html) {
        insertPastedContent(event.currentTarget, plainText);
        event.preventDefault();
        return;
    }

    const source = new DOMParser().parseFromString(html, "text/html");
    const hasEditorElements = Array.from(source.body.querySelectorAll("*"))
        .some((element) => pasteEditorTags.has(element.tagName));
    if (!hasEditorElements) {
        insertPastedContent(event.currentTarget, plainText);
        event.preventDefault();
        return;
    }

    const fragment = document.createDocumentFragment();
    appendPastedNodes(source.body, fragment);
    const lines = getPastedTextLines(plainText);
    if (lines.length > 1) {
        insertPastedContent(event.currentTarget, joinPastedLines(splitFragmentByLines(fragment, lines)));
    } else {
        insertPastedContent(event.currentTarget, fragment);
    }
    event.preventDefault();
}

function appendPastedNodes(source, target, root = true) {
    for (const node of source.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (root && /^[\s]*$/.test(node.textContent) && /[\r\n]/.test(node.textContent)) {
                continue;
            }
            target.append(document.createTextNode(node.textContent));
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
        }

        if (node.tagName === "BR") {
            continue;
        }

        if (pasteEditorTags.has(node.tagName)) {
            if ((node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") && !parseParagraphLink(node.getAttribute("href") ?? "")) {
                appendPastedNodes(node, target);
                continue;
            }

            const element = document.createElement(node.tagName.toLowerCase());
            if (node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") {
                const link = parseParagraphLink(node.getAttribute("href"));
                element.setAttribute("href", `/documents/${encodeURIComponent(link.documentId)}#block-${encodeURIComponent(link.blockId)}`);
            }
            appendPastedNodes(node, element, false);
            target.append(element);
        } else {
            const childFragment = document.createDocumentFragment();
            appendPastedNodes(node, childFragment, false);
            if (childFragment.textContent.trim() !== "") {
                for (const child of childFragment.childNodes) target.append(child);
            }
        }
    }
}

function getPastedTextLines(value) {
    return value.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
}

function splitFragmentByLines(fragment, lines) {
    const lineFragments = lines.map(() => document.createDocumentFragment());
    let lineIndex = 0;
    let lineOffset = 0;

    function appendNode(node, target) {
        if (lineIndex >= lines.length) {
            return;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            let offset = 0;
            while (offset < node.textContent.length && lineIndex < lines.length) {
                const remaining = lines[lineIndex].length - lineOffset;
                const length = Math.min(remaining, node.textContent.length - offset);
                if (length > 0) {
                    target.append(document.createTextNode(node.textContent.slice(offset, offset + length)));
                    offset += length;
                    lineOffset += length;
                }
                if (lineOffset === lines[lineIndex].length) {
                    lineIndex += 1;
                    lineOffset = 0;
                    target = lineFragments[lineIndex];
                }
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        if (pasteEditorTags.has(node.tagName)) {
            if ((node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") && !parseParagraphLink(node.getAttribute("href") ?? "")) {
                for (const child of node.childNodes) appendNode(child, target);
                return;
            }
            const element = document.createElement(node.tagName.toLowerCase());
            if (node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") {
                const link = parseParagraphLink(node.getAttribute("href"));
                element.setAttribute("href", `/documents/${encodeURIComponent(link.documentId)}#block-${encodeURIComponent(link.blockId)}`);
            }
            const startChildren = element.childNodes.length;
            for (const child of node.childNodes) appendNode(child, element);
            if (element.childNodes.length > startChildren) {
                target.append(element);
            }
            return;
        }

        for (const child of node.childNodes) appendNode(child, target);
    }

    for (const node of fragment.childNodes) appendNode(node, lineFragments[lineIndex]);
    return lineFragments;
}

function joinPastedLines(lines) {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lines.length; index += 1) {
        for (const node of lines[index].childNodes) fragment.append(node);
        if (index < lines.length - 1) fragment.append(document.createElement("br"));
    }
    return fragment;
}

function insertPastedContent(paragraph, content) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return;
    }

    const range = selection.getRangeAt(0);
    if (!paragraph.contains(range.commonAncestorContainer)) {
        return;
    }

    const parts = typeof content === "string"
        ? splitTextPaste(content)
        : splitFragmentPaste(content);
    if (parts.length > 1) {
        insertPastedBlocks(paragraph, parts, range, selection);
        return;
    }

    insertPastedFragment(paragraph, parts[0], range, selection);
    const block = findBlock(paragraph.dataset.blockId);
    const position = getSelectionPosition(paragraph);
    if (block && position) {
        render(block.id, position.end);
    }
}

function splitTextPaste(value) {
    return value.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "").map((line) => {
        const fragment = document.createDocumentFragment();
        fragment.append(document.createTextNode(line));
        return fragment;
    });
}

function splitFragmentPaste(fragment) {
    const parts = [document.createDocumentFragment()];
    for (const node of fragment.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
            parts.push(document.createDocumentFragment());
        } else {
            parts[parts.length - 1].append(node.cloneNode(true));
        }
    }
    return parts.filter((part) => part.textContent.trim() !== "");
}

function insertPastedFragment(paragraph, fragment, range, selection, suppressHistory = false) {
    range.deleteContents();
    range.insertNode(fragment);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const previousSuppression = state.historySuppressed;
    state.historySuppressed = suppressHistory;
    paragraph.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    state.historySuppressed = previousSuppression;
}

function insertPastedBlocks(paragraph, parts, range, selection) {
    const start = getTextOffset(paragraph, range.startContainer, range.startOffset);
    const partLengths = parts.map((part) => part.textContent.length);
    insertPastedFragment(paragraph, parts[0], range, selection);

    let currentParagraph = paragraph;
    for (let index = 1; index < parts.length; index += 1) {
        const block = findBlock(currentParagraph.dataset.blockId);
        if (!block) {
            return;
        }
        const splitAt = index === 1
            ? start + partLengths[0]
            : partLengths[index - 1];
        const nextBlock = splitParagraph(block, splitAt, block.text.length, false);
        currentParagraph = findParagraph(nextBlock.id);
        const nextRange = document.createRange();
        nextRange.selectNodeContents(currentParagraph);
        nextRange.collapse(true);
        const nextSelection = window.getSelection();
        nextSelection.removeAllRanges();
        nextSelection.addRange(nextRange);
        insertPastedFragment(currentParagraph, parts[index], nextRange, nextSelection, true);
    }
}

function markElement(style) {
    return {
        bold: "d-bold",
        italic: "d-italic",
        underline: "d-underline",
        strike: "d-strike",
        highlight: "d-highlight",
        subscript: "d-subscript",
        superscript: "d-superscript",
    }[style] ?? "span";
}

function handleInput(event) {
    const paragraph = event.currentTarget;
    const block = findBlock(paragraph.dataset.blockId);
    if (!block) {
        return;
    }

    if (!state.historySuppressed) {
        recordHistory(event.inputType === "insertFromPaste" ? "Text paste" : "Text edit");
    }
    state.contentDirty = true;
    block.text = paragraph.textContent.replace(/[\r\n]/g, "");
    const metadata = readInlineMetadata(paragraph);
    block.marks = metadata.marks;
    block.links = metadata.links;
    const paragraphMetrics = paragraph.parentElement?.querySelector(".paragraph-metrics");
    if (paragraphMetrics) {
        updateParagraphMetrics(paragraphMetrics, block);
    }
    const cursorOffset = getSelectionPosition(paragraph)?.start ?? block.text.length;
    if (paragraph.textContent !== block.text) {
        render(block.id, cursorOffset);
    }
    repairLegacyOffsetBlocks(state.content);
    if (event.inputType === "insertFromPaste") {
        saveImmediately();
    } else {
        scheduleSafetySave();
    }
}

function handleParagraphBlur(event) {
    const paragraph = event.currentTarget;
    if (!paragraph.isConnected) {
        return;
    }
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && (
        paragraph.parentElement?.contains(relatedTarget)
        || selectionToolbar.contains(relatedTarget)
    )) {
        return;
    }
    window.setTimeout(() => normalizeParagraphOnBlur(paragraph), 0);
}

function normalizeParagraphOnBlur(paragraph) {
    if (!paragraph.isConnected || paragraph.contains(document.activeElement)) {
        return;
    }
    if (paragraph.parentElement?.contains(document.activeElement) || selectionToolbar.contains(document.activeElement)) {
        return;
    }
    const block = findBlock(paragraph.dataset.blockId);
    if (!block) {
        return;
    }

    const normalizedText = normalizeParagraphText(block.text);
    if (normalizedText === block.text) {
        return;
    }

    let start = 0;
    while (start < block.text.length && start < normalizedText.length && block.text[start] === normalizedText[start]) {
        start += 1;
    }
    let oldEnd = block.text.length;
    let newEnd = normalizedText.length;
    while (oldEnd > start && newEnd > start && block.text[oldEnd - 1] === normalizedText[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
    }

    recordHistory("Text normalization");
    block.marks = remapRangesForTextChange(block.marks, start, oldEnd, newEnd - start);
    block.links = remapRangesForTextChange(block.links, start, oldEnd, newEnd - start);
    block.text = normalizedText;
    render(block.id);
    queueSave();
}

function normalizeParagraphText(value) {
    let normalized = value.replace(/\s+/g, " ").trim();
    normalized = normalized.replace(/\s+([,.?!])/g, "$1");
    normalized = normalized.replace(/([,.?!])(?=[^\s,.?!])/g, "$1 ");
    return normalized.replace(/(^|[.!?]\s+)(\p{L})/gu, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function handleDoubleClick(event) {
    const paragraph = event.currentTarget;
    const position = getSelectionPosition(paragraph);
    if (!position || position.start === position.end) {
        return;
    }

    const text = paragraph.textContent;
    let start = position.start;
    let end = position.end;
    while (start < end && /\s/.test(text[start])) {
        start += 1;
    }
    while (end > start && /\s/.test(text[end - 1])) {
        end -= 1;
    }
    selectOffsets(paragraph, start, end);
}

function handleBeforeInput(event) {
    if (event.inputType !== "insertParagraph") {
        return;
    }

    const paragraph = event.currentTarget;
    const block = findBlock(paragraph.dataset.blockId);
    const position = getSelectionPosition(paragraph);
    if (!block || !position) {
        return;
    }

    event.preventDefault();
    splitParagraph(block, position.start, position.end);
}

function readInlineMetadata(paragraph) {
    const marks = [];
    const links = [];
    let offset = 0;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
        const length = textNode.textContent.length;
        const start = offset;
        const end = offset + length;
        let markElement = textNode.parentElement;
        while (markElement && markElement !== paragraph) {
            const style = {
                STRONG: "bold", B: "bold", EM: "italic", I: "italic", U: "underline",
                S: "strike", STRIKE: "strike", DEL: "strike",
                SUB: "subscript", SUP: "superscript",
                "D-BOLD": "bold", "D-ITALIC": "italic", "D-UNDERLINE": "underline",
                "D-STRIKE": "strike", "D-HIGHLIGHT": "highlight",
                "D-SUBSCRIPT": "subscript", "D-SUPERSCRIPT": "superscript",
            }[markElement.tagName];
            if (style) marks.push({ start, end, style });
            if (markElement.style.backgroundColor) marks.push({ start, end, style: "highlight" });
            markElement = markElement.parentElement;
        }
        const linkElement = textNode.parentElement.closest("d-link, d-reference");
        if (linkElement) {
            const target = parseParagraphLink(linkElement.getAttribute("href") ?? "");
            if (target) links.push({
                start,
                end,
                documentId: target.documentId,
                blockId: target.blockId,
                ...(linkElement.tagName === "D-REFERENCE" ? { reference: true } : {}),
            });
        }
        offset = end;
        textNode = walker.nextNode();
    }
    return { marks: mergeRanges(marks), links: mergeRanges(links) };
}

function mergeRanges(ranges) {
    return ranges.filter((range, index, values) => index === values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(range)));
}

function repairLegacyOffsetBlocks(content) {
    let repaired = false;
    for (let index = 0; index < content.blocks.length; index += 1) {
        const block = content.blocks[index];
        for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
            const reference = content.blocks[previousIndex];
            if (block.text !== reference.text || !hasShiftedMetadata(block, reference)) {
                continue;
            }

            block.marks = cloneRanges(reference.marks);
            block.links = cloneRanges(reference.links);
            repaired = true;
            break;
        }
    }
    return repaired;
}

function hasShiftedMetadata(block, reference) {
    const currentMarks = block.marks ?? [];
    const currentLinks = block.links ?? [];
    const referenceMarks = reference.marks ?? [];
    const referenceLinks = reference.links ?? [];
    if (currentMarks.length + currentLinks.length === 0
        || currentMarks.length !== referenceMarks.length
        || currentLinks.length !== referenceLinks.length) {
        return false;
    }

    return JSON.stringify(currentMarks) === JSON.stringify(shiftRanges(referenceMarks))
        && JSON.stringify(currentLinks) === JSON.stringify(shiftRanges(referenceLinks));
}

function shiftRanges(ranges) {
    return ranges.map((range) => ({ ...range, start: range.start + 1, end: range.end + 1 }));
}

function cloneRanges(ranges) {
    return (ranges ?? []).map((range) => ({ ...range }));
}

function normalizeContentMetadata(content) {
    for (const block of content.blocks) {
        block.marks = normalizeRanges(block.marks, (range) => range.style);
        block.links = normalizeRanges(block.links, (range) => `${range.documentId}:${range.blockId}`);
        if (block.marks.length === 0) delete block.marks;
        if (block.links.length === 0) delete block.links;
    }
}

function normalizeRanges(ranges, identity) {
    const sorted = cloneRanges(ranges).sort((left, right) => left.start - right.start || left.end - right.end);
    const normalized = [];
    for (const range of sorted) {
        const previous = normalized[normalized.length - 1];
        if (previous && identity(previous) === identity(range) && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            normalized.push(range);
        }
    }
    return normalized;
}

function handleSelectionChange() {
    const capsMenu = selectionToolbar.querySelector(".caps-menu");
    if (capsMenu) closeCapsMenu(capsMenu);
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        selectionToolbar.hidden = true;
        return;
    }
    const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    const paragraph = anchorElement?.closest(".paragraph");
    if (!paragraph || !paragraph.contains(selection.focusNode)) {
        selectionToolbar.hidden = true;
        return;
    }
    const position = getSelectionPosition(paragraph);
    if (!position || position.start === position.end) {
        selectionToolbar.hidden = true;
        return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    state.savedSelection = {
        blockId: paragraph.dataset.blockId,
        start: position.start,
        end: position.end,
    };
    selectionToolbar.hidden = false;
    const toolbarWidth = selectionToolbar.offsetWidth;
    const toolbarHeight = selectionToolbar.offsetHeight;
    const centeredLeft = rect.left + rect.width / 2 - toolbarWidth / 2;
    const left = Math.min(Math.max(8, centeredLeft), window.innerWidth - toolbarWidth - 8);
    const top = Math.max(8, rect.top - toolbarHeight - 10);
    selectionToolbar.style.left = `${left + window.scrollX}px`;
    selectionToolbar.style.top = `${top + window.scrollY}px`;
    updateToolbarState(paragraph, position);
}

function updateToolbarState(paragraph, position) {
    const block = findBlock(paragraph.dataset.blockId);
    for (const button of selectionToolbar.querySelectorAll("button[data-format]")) {
        const format = button.dataset.format;
        const active = block && position && format !== "clear" && (
            format === "link"
                ? block.links?.some((link) => link.start <= position.start && link.end >= position.end)
                : block.marks?.some((mark) => mark.style === format && mark.start <= position.start && mark.end >= position.end)
        );
        button.setAttribute("aria-pressed", String(Boolean(active)));
        if (format === "link") {
            const icon = button.querySelector(".material-symbols-outlined");
            if (icon) {
                icon.textContent = active ? "link_off" : "link";
            }
            button.title = active ? "Remove link" : "Link";
        }
    }
}

function handleToolbarMouseDown(event) {
    if (selectionToolbar.contains(event.target)) {
        event.preventDefault();
        const button = event.target.closest("button");
        if (button?.dataset.format !== "caps") {
            restoreSavedSelection();
        }
    }
}

function restoreSavedSelection() {
    const savedSelection = state.savedSelection;
    if (!savedSelection) return;
    const paragraph = findParagraph(savedSelection.blockId);
    if (paragraph) {
        selectOffsets(paragraph, savedSelection.start, savedSelection.end);
    }
}

function handleToolbarFocusOut(event) {
    const capsMenu = event.target.closest(".caps-menu");
    if (!capsMenu || capsMenu.contains(event.relatedTarget)) return;
    closeCapsMenu(capsMenu);
}

function closeCapsMenu(capsMenu) {
    const capsButton = capsMenu.querySelector("[data-format=\"caps\"]");
    const menu = capsMenu.querySelector(".caps-options");
    if (!capsButton || !menu) return;
    capsButton.setAttribute("aria-expanded", "false");
    menu.hidden = true;
}

function handleToolbarClick(event) {
    const button = event.target.closest("button[data-format], button[data-caps]");
    if (!button) return;
    if (button.dataset.format === "caps") {
        const menu = button.parentElement.querySelector(".caps-options");
        const expanded = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!expanded));
        menu.hidden = expanded;
        return;
    }
    if (button.dataset.caps) {
        restoreSavedSelection();
        applyCaseTransform(button.dataset.caps);
        return;
    }
    restoreSavedSelection();
    const selection = window.getSelection();
    const anchorElement = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement;
    const paragraph = anchorElement?.closest(".paragraph");
    if (!paragraph) return;
    const block = findBlock(paragraph.dataset.blockId);
    const position = getSelectionPosition(paragraph);
    if (!block || !position) return;
    if (button.dataset.format === "clear") {
        recordHistory("Formatting cleared");
        block.marks = removeRanges(block.marks ?? [], position.start, position.end);
        render();
        const updatedParagraph = findParagraph(block.id);
        selectOffsets(updatedParagraph, position.start, position.end);
        queueSave();
        handleSelectionChange();
        return;
    }
    if (button.dataset.format === "link") {
        const linkActive = block.links?.some((link) => link.start <= position.start && link.end >= position.end);
        if (linkActive) {
            recordHistory("Link removed");
            block.links = removeRanges(block.links, position.start, position.end);
            render();
            const updatedParagraph = findParagraph(block.id);
            selectOffsets(updatedParagraph, position.start, position.end);
            queueSave();
            handleSelectionChange();
            return;
        }
        createLink(paragraph, position);
        return;
    }
    const format = button.dataset.format;
    const active = block.marks?.some((mark) => mark.style === format && mark.start <= position.start && mark.end >= position.end);
    recordHistory(`Formatting: ${format}`);
    const sameFormat = (block.marks ?? []).filter((mark) => mark.style === format);
    const otherFormats = (block.marks ?? []).filter((mark) => mark.style !== format);
    block.marks = [...otherFormats, ...removeRanges(sameFormat, position.start, position.end)];
    if (!active) {
        block.marks.push({ start: position.start, end: position.end, style: format });
    }
    render(block.id, position.end);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.end);
    queueSave();
    handleSelectionChange();
}

function applyCaseTransform(caseType) {
    const selection = window.getSelection();
    const anchorElement = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement;
    const paragraph = anchorElement?.closest(".paragraph");
    const block = paragraph && findBlock(paragraph.dataset.blockId);
    const position = paragraph && getSelectionPosition(paragraph);
    if (!block || !position || position.start === position.end) {
        return;
    }

    const selectedText = block.text.slice(position.start, position.end);
    const transformedText = caseType === "upper"
        ? selectedText.toUpperCase()
        : caseType === "lower"
            ? selectedText.toLowerCase()
            : selectedText.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (match) => match.toUpperCase());
    recordHistory(`Text case: ${caseType}`);
    block.text = block.text.slice(0, position.start) + transformedText + block.text.slice(position.end);
    block.marks = remapRangesForTextChange(block.marks, position.start, position.end, transformedText.length);
    block.links = remapRangesForTextChange(block.links, position.start, position.end, transformedText.length);
    render(block.id, position.start + transformedText.length);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.start + transformedText.length);
    queueSave();
    const capsButton = selectionToolbar.querySelector("[data-format=\"caps\"]");
    const menu = capsButton?.parentElement.querySelector(".caps-options");
    if (capsButton && menu) {
        capsButton.setAttribute("aria-expanded", "false");
        menu.hidden = true;
    }
    handleSelectionChange();
}

function remapRangesForTextChange(ranges, start, end, replacementLength) {
    const delta = replacementLength - (end - start);
    return (ranges ?? []).flatMap((range) => {
        const mapOffset = (offset, isEnd) => {
            if (offset <= start) return offset;
            if (offset >= end) return offset + delta;
            return start + (isEnd ? replacementLength : 0);
        };
        const mapped = { ...range, start: mapOffset(range.start, false), end: mapOffset(range.end, true) };
        return mapped.start < mapped.end ? [mapped] : [];
    });
}

function removeRanges(ranges, start, end) {
    const remaining = [];
    for (const range of ranges) {
        if (range.end <= start || range.start >= end) {
            remaining.push(range);
            continue;
        }
        if (range.start < start) {
            remaining.push({ ...range, end: start });
        }
        if (range.end > end) {
            remaining.push({ ...range, start: end });
        }
    }
    return remaining;
}

function handleKeydown(event) {
    const paragraph = event.currentTarget;
    const block = findBlock(paragraph.dataset.blockId);
    const position = getSelectionPosition(paragraph);
    if (!block || !position) {
        return;
    }

    if (event.key === "Enter" || event.code === "Enter") {
        event.preventDefault();
        splitParagraph(block, position.start, position.end);
        return;
    }

    if (event.key === "Backspace") {
        event.preventDefault();
        backspace(block, position.start, position.end);
        return;
    }

    if (event.key === "Delete") {
        event.preventDefault();
        deleteForward(block, position.start, position.end);
        return;
    }

    if (event.key === "Home") {
        event.preventDefault();
        focusAt(paragraph, 0);
        return;
    }

    if (event.key === "End") {
        event.preventDefault();
        focusAt(paragraph, block.text.length);
    }
}

function splitParagraph(block, start, end, record = true) {
    const index = state.content.blocks.indexOf(block);
    if (index < 0) {
        return null;
    }
    if (record) {
        recordHistory("Paragraph split");
    }
    const before = block.text.slice(0, start).replace(/\s+$/, "");
    const originalAfter = block.text.slice(end);
    const after = originalAfter.replace(/^\s+/, "");
    const afterStart = end + originalAfter.length - after.length;
    const [beforeMarks, afterMarks] = splitRanges(block.marks, before.length, afterStart);
    const [beforeLinks, afterLinks] = splitRanges(block.links, before.length, afterStart);
    const newBlock = {
        id: createBlockId(),
        type: "paragraph",
        text: after,
        ...(block.align ? { align: block.align } : {}),
        marks: afterMarks,
        links: afterLinks,
    };

    block.text = before;
    block.marks = beforeMarks;
    block.links = beforeLinks;
    normalizeBlockWhitespace(block);
    normalizeBlockWhitespace(newBlock);
    state.content.blocks.splice(index + 1, 0, newBlock);
    render(newBlock.id, 0);
    if (record) {
        queueSave();
    }
    return newBlock;
}

function backspace(block, start, end) {
    if (start !== end) {
        recordHistory("Text delete");
        block.text = block.text.slice(0, start) + block.text.slice(end);
        removeMetadataRange(block, start, end);
        render(block.id, normalizeBlockWhitespace(block, start));
        queueSave();
        return;
    }

    if (start > 0) {
        recordHistory("Text delete");
        block.text = block.text.slice(0, start - 1) + block.text.slice(start);
        removeMetadataRange(block, start - 1, start);
        render(block.id, normalizeBlockWhitespace(block, start - 1));
        queueSave();
        return;
    }

    const index = state.content.blocks.indexOf(block);
    if (index === 0) {
        return;
    }

    const previous = state.content.blocks[index - 1];
    recordHistory("Paragraph merge above");
    const previousLength = previous.text.length;
    previous.text += ` ${block.text}`;
    previous.marks = mergeMetadataRanges(previous.marks, block.marks, previousLength + 1);
    previous.links = mergeMetadataRanges(previous.links, block.links, previousLength + 1);
    const cursorOffset = normalizeBlockWhitespace(previous, previousLength + 1);
    state.content.blocks.splice(index, 1);
    render(previous.id, cursorOffset);
    queueSave();
}

function deleteForward(block, start, end) {
    if (start !== end) {
        recordHistory("Text delete");
        block.text = block.text.slice(0, start) + block.text.slice(end);
        removeMetadataRange(block, start, end);
        render(block.id, normalizeBlockWhitespace(block, start));
        queueSave();
        return;
    }

    if (start < block.text.length) {
        recordHistory("Text delete");
        block.text = block.text.slice(0, start) + block.text.slice(start + 1);
        removeMetadataRange(block, start, start + 1);
        render(block.id, normalizeBlockWhitespace(block, start));
        queueSave();
        return;
    }

    const index = state.content.blocks.indexOf(block);
    if (index === state.content.blocks.length - 1) {
        return;
    }

    const next = state.content.blocks[index + 1];
    recordHistory("Paragraph merge below");
    block.text += ` ${next.text}`;
    block.marks = mergeMetadataRanges(block.marks, next.marks, start + 1);
    block.links = mergeMetadataRanges(block.links, next.links, start + 1);
    const cursorOffset = normalizeBlockWhitespace(block, start + 1);
    state.content.blocks.splice(index + 1, 1);
    render(block.id, cursorOffset);
    queueSave();
}

function getSelectionPosition(paragraph) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !paragraph.contains(selection.focusNode)) {
        return null;
    }

    const range = selection.getRangeAt(0);
    return {
        start: getTextOffset(paragraph, range.startContainer, range.startOffset),
        end: getTextOffset(paragraph, range.endContainer, range.endOffset),
    };
}

function getTextOffset(paragraph, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
        let result = offset;
        let node = container.previousSibling;
        while (node) {
            result += node.textContent.length;
            node = node.previousSibling;
        }

        let parent = container.parentNode;
        while (parent && parent !== paragraph) {
            node = parent.previousSibling;
            while (node) {
                result += node.textContent.length;
                node = node.previousSibling;
            }
            parent = parent.parentNode;
        }
        return result;
    }

    let result = 0;
    for (let index = 0; index < offset; index += 1) {
        result += container.childNodes[index]?.textContent.length ?? 0;
    }

    let node = container;
    while (node && node !== paragraph) {
        const parent = node.parentNode;
        if (!parent) {
            break;
        }
        let sibling = node.previousSibling;
        while (sibling) {
            result += sibling.textContent.length;
            sibling = sibling.previousSibling;
        }
        node = parent;
    }
    return result;
}

function getCaretOffsetFromPoint(paragraph, clientX, clientY) {
    const documentPosition = document.caretPositionFromPoint?.(clientX, clientY);
    if (documentPosition && paragraph.contains(documentPosition.offsetNode)) {
        return getTextOffset(paragraph, documentPosition.offsetNode, documentPosition.offset);
    }

    const range = document.caretRangeFromPoint?.(clientX, clientY);
    if (range && paragraph.contains(range.startContainer)) {
        return getTextOffset(paragraph, range.startContainer, range.startOffset);
    }

    return null;
}

function focusAt(paragraph, offset) {
    paragraph.focus();
    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    moveRangeToOffset(range, paragraph, offset);
    selection.removeAllRanges();
    selection.addRange(range);
}

function selectOffsets(paragraph, start, end) {
    const startRange = document.createRange();
    startRange.selectNodeContents(paragraph);
    moveRangeToOffset(startRange, paragraph, start);
    const endRange = document.createRange();
    endRange.selectNodeContents(paragraph);
    moveRangeToOffset(endRange, paragraph, end);

    const range = document.createRange();
    range.setStart(startRange.startContainer, startRange.startOffset);
    range.setEnd(endRange.startContainer, endRange.startOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

function moveRangeToOffset(range, paragraph, offset) {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let textNode = walker.nextNode();

    while (textNode) {
        if (remaining <= textNode.textContent.length) {
            range.setStart(textNode, remaining);
            range.collapse(true);
            return;
        }
        remaining -= textNode.textContent.length;
        textNode = walker.nextNode();
    }

    range.selectNodeContents(paragraph);
    range.collapse(false);
}

function findBlock(id) {
    return state.content.blocks.find((block) => block.id === id);
}

function findParagraph(id) {
    return editor.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
}

function createBlockId() {
    return `paragraph-${crypto.randomUUID()}`;
}

function createLink(paragraph, position = getSelectionPosition(paragraph)) {
    if (!position || position.start === position.end) {
        setSaveState("Select text first", "error");
        return;
    }

    state.pendingLink = { blockId: paragraph.dataset.blockId, position };
    linkDialogInput.value = "";
    linkDialogReference.checked = false;
    linkDialogError.hidden = true;
    linkDialog.hidden = false;
    linkDialogInput.focus();
}

function handleLinkDialogSubmit(event) {
    event.preventDefault();
    const target = parseParagraphLink(linkDialogInput.value.trim());
    if (!target) {
        linkDialogError.hidden = false;
        linkDialogInput.focus();
        return;
    }

    const pendingLink = { ...state.pendingLink, asReference: linkDialogReference.checked };
    closeLinkDialog();
    const paragraph = pendingLink && findParagraph(pendingLink.blockId);
    const block = paragraph && findBlock(pendingLink.blockId);
    const position = pendingLink?.position;
    if (!paragraph || !block || !position) return;
    if (pendingLink.asReference) {
        addParagraphReference(block, position, target);
        return;
    }
    recordHistory("Paragraph link added");
    block.links = [
        ...(block.links ?? []),
        { start: position.start, end: position.end, documentId: target.documentId, blockId: target.blockId },
    ];
    render(block.id, position.end);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.end);
    queueSave();
    handleSelectionChange();
}

function addParagraphReference(block, position, target) {
    const insertionPoint = position.end;
    recordHistory("Paragraph reference added");
    block.text = `${block.text.slice(0, insertionPoint)}*${block.text.slice(insertionPoint)}`;
    block.marks = remapRangesForTextChange(block.marks ?? [], insertionPoint, insertionPoint, 1);
    block.links = remapRangesForTextChange(block.links ?? [], insertionPoint, insertionPoint, 1);
    block.links.push({
        start: insertionPoint,
        end: insertionPoint + 1,
        documentId: target.documentId,
        blockId: target.blockId,
        reference: true,
    });
    render(block.id, insertionPoint);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.end);
    queueSave();
    handleSelectionChange();
}

function closeLinkDialog() {
    linkDialog.hidden = true;
    state.pendingLink = null;
    linkDialogError.hidden = true;
}

function handleLinkDialogKeydown(event) {
    if (event.key === "Escape" && !linkDialog.hidden) {
        event.preventDefault();
        closeLinkDialog();
    }
}

function parseParagraphLink(value) {
    try {
        const url = new URL(value, window.location.origin);
        if (url.origin !== window.location.origin) {
            return null;
        }

        const documentMatch = url.pathname.match(/^\/documents\/([^/]+)$/);
        const blockID = decodeURIComponent(url.hash.slice(1));
        if (!documentMatch || !blockID.startsWith("block-")) {
            return null;
        }

        return {
            documentId: decodeURIComponent(documentMatch[1]),
            blockId: blockID.slice("block-".length),
        };
    } catch (error) {
        return null;
    }
}

async function copyParagraphLink(block, button) {
    const value = `/documents/${state.documentId}#block-${block.id}`;
    state.copiedBlockId = block.id;
    setCopyButtonState(button, true);
    clearTimeout(state.copyResetTimer);
    try {
        await copyText(value);
        state.copyResetTimer = window.setTimeout(() => {
            state.copiedBlockId = null;
            setCopyButtonState(button, false);
        }, 1500);
    } catch (error) {
        console.error(error);
        state.copiedBlockId = null;
        setCopyButtonState(button, false);
        setSaveState("Unable to copy link", "error");
    }
}

function setCopyButtonState(button, copied) {
    const icon = button.querySelector(".material-symbols-outlined");
    if (icon) {
        icon.textContent = copied ? "assignment_turned_in" : "assignment";
    }
    button.classList.toggle("is-copied", copied);
    button.title = copied ? "Copied" : "Copy link";
}

async function copyText(value) {
    if (navigator.clipboard?.writeText) {
        try {
            await Promise.race([
                navigator.clipboard.writeText(value),
                new Promise((_, reject) => window.setTimeout(() => reject(new Error("Clipboard write timed out")), 500)),
            ]);
            return;
        } catch (error) {
            console.warn("Clipboard API unavailable, using fallback", error);
        }
    }

    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "true");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    if (!document.execCommand("copy")) {
        throw new Error("Copy command failed");
    }
    input.remove();
}

function queueSave() {
    state.contentDirty = true;
    normalizeContentMetadata(state.content);
    updateDocumentLimitMeters();
    setSaveState("Unsaved", "unsaved");
    state.saveQueued = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
        state.saveQueued = false;
        save();
    }, 700);
}

function saveImmediately() {
    state.contentDirty = true;
    normalizeContentMetadata(state.content);
    updateDocumentLimitMeters();
    setSaveState("Unsaved", "unsaved");
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.saveQueued = false;
    save();
}

function scheduleSafetySave() {
    state.contentDirty = true;
    normalizeContentMetadata(state.content);
    updateDocumentLimitMeters();
    setSaveState("Unsaved", "unsaved");
    state.saveQueued = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
        state.saveTimer = null;
        state.saveQueued = false;
        save();
    }, safetySaveDelay);
}

function handleDocumentVisibilityChange() {
    if (document.visibilityState === "hidden") {
        flushPendingSave();
    }
}

function flushPendingSave() {
    if (!state.saveQueued || !state.content) {
        return;
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.saveQueued = false;
    save();
}

function updateDocumentLimitMeters(payload = null) {
    if (!state.content) return;
    const serialized = payload ?? JSON.stringify({ content: state.content, revision: state.revision });
    updateLimitMeter(documentSizeLimit, new Blob([serialized]).size, maxDocumentRequestBytes,
        (value, maximum, percent) => `Size ${formatByteSize(value)} / ${formatByteSize(maximum)} · ${percent}%`);
    updateLimitMeter(documentBlockLimit, state.content.blocks.length, maxDocumentBlockCount,
        (value, maximum, percent) => `Blocks ${value.toLocaleString()} / ${maximum.toLocaleString()} · ${percent}%`);
}

function updateLimitMeter(label, value, maximum, formatLabel) {
    const meter = label.closest(".limit-meter");
    const track = meter.querySelector(".limit-meter-track");
    const percent = Math.round(value / maximum * 100);
    label.textContent = formatLabel(value, maximum, percent);
    meter.dataset.limitLevel = percent >= 90 ? "danger" : percent >= 70 ? "warning" : "safe";
    meter.title = label.textContent;
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", label.textContent);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(maximum));
    track.setAttribute("aria-valuenow", String(value));
    track.firstElementChild.style.width = `${Math.min(100, Math.max(0, value / maximum * 100))}%`;
}

function formatByteSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function save() {
    if (state.saveInFlight || !state.content) {
        state.saveQueued = true;
        return;
    }

    state.saveInFlight = true;
    setSaveState("Saving", "saving");
    const contentToSave = cloneContent(state.content);
    const revisionAtStart = state.revision;
    const blockSave = getBlockSavePayload(contentToSave, revisionAtStart);
    const payload = JSON.stringify(blockSave);
    updateDocumentLimitMeters(JSON.stringify({ content: contentToSave, revision: revisionAtStart }));

    try {
        const response = await fetch(`/documents/${state.documentId}/blocks`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: payload,
        });

        if (response.status === 409) {
            await recoverFromConflict();
            return;
        }
        if (!response.ok) {
            throw new Error(`Save failed: ${response.status}`);
        }

        const saved = await response.json();
        state.syncedContent = cloneContent(saved.content);
        if (sameContent(state.content, contentToSave)) {
            state.content = saved.content;
        }
        state.revision = saved.revision;
        localStorage.removeItem(recoveryKey());
        if (sameContent(state.content, contentToSave)) {
            state.contentDirty = false;
            setSaveState("Saved", "saved");
        }
    } catch (error) {
        console.error(error);
        setSaveState("Save failed", "error");
    } finally {
        state.saveInFlight = false;
        revisionLabel.textContent = `Revision ${state.revision}`;
        updateHistoryButtons();
        if (state.saveQueued || !sameContent(state.content, contentToSave)) {
            queueSave();
        }
    }
}

function getBlockSavePayload(content, revision) {
    const previous = state.syncedContent;
    if (!previous || previous.blocks.length !== content.blocks.length
        || previous.blocks.some((block, index) => block.id !== content.blocks[index]?.id)) {
        return { revision, blocks: content.blocks, replaceAll: true };
    }

    const changedBlocks = content.blocks.filter((block, index) =>
        JSON.stringify(block) !== JSON.stringify(previous.blocks[index])
    );
    return { revision, blocks: changedBlocks, replaceAll: false };
}

async function recoverFromConflict() {
    localStorage.setItem(recoveryKey(), JSON.stringify(state.content));
    const latest = await loadDocument(state.slug);
    state.revision = latest.revision;
    state.syncedContent = cloneContent(latest.content);
    setSaveState("Conflict recovered", "error");
    state.saveQueued = true;
}

function recoveryKey(documentId = state.documentId) {
    return `dionysus:recovery:${documentId}`;
}

function readRecovery(documentId) {
    const value = localStorage.getItem(recoveryKey(documentId));
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        console.error(error);
        localStorage.removeItem(recoveryKey(documentId));
        return null;
    }
}

function recordHistory(operation = "Edit") {
    if (!state.content) {
        return;
    }

    state.undoStack.push({ content: cloneContent(state.content), operation });
    state.lastOperation = operation;
    if (state.undoStack.length > historyLimit) {
        state.undoStack.shift();
    }
    state.redoStack = [];
    updateHistoryButtons();
}

function undo() {
    if (state.undoStack.length === 0) {
        return;
    }

    const entry = state.undoStack.pop();
    state.redoStack.push({ content: cloneContent(state.content), operation: `Undo: ${entry.operation}` });
    state.content = entry.content;
    state.lastOperation = `Undo: ${entry.operation}`;
    render();
    updateHistoryButtons();
    queueSave();
}

function redo() {
    if (state.redoStack.length === 0) {
        return;
    }

    const entry = state.redoStack.pop();
    state.undoStack.push({ content: cloneContent(state.content), operation: `Redo: ${entry.operation}` });
    state.content = entry.content;
    state.lastOperation = `Redo: ${entry.operation}`;
    render();
    updateHistoryButtons();
    queueSave();
}

function handleHistoryShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
        return;
    }

    event.preventDefault();
    if (event.shiftKey) {
        redo();
    } else {
        undo();
    }
}

function updateHistoryButtons() {
    undoButton.disabled = state.undoStack.length === 0;
    redoButton.disabled = state.redoStack.length === 0;
    renderHistoryPanel();
}

function renderHistoryPanel() {
    if (!sidebarHistoryList || !state.content) return;
    sidebarHistoryList.replaceChildren();
    const entries = [
        ...state.undoStack.map((entry) => ({ ...entry, kind: "undo" })),
        { content: state.content, operation: state.lastOperation, kind: "current" },
        ...[...state.redoStack].reverse().map((entry) => ({ ...entry, kind: "redo" })),
    ];

    if (entries.length === 1) {
        renderSidebarEmpty(sidebarHistoryList, "No changes yet");
        return;
    }

    for (const [index, entry] of entries.entries()) {
        const button = document.createElement("button");
        button.className = "history-preview";
        button.type = "button";
        button.classList.toggle("is-current", entry.kind === "current");
        button.setAttribute("aria-label", entry.kind === "current" ? "Current version" : `Restore version ${index + 1}`);
        button.addEventListener("click", () => restoreHistorySnapshot(entry.content));

        const header = document.createElement("span");
        header.className = "history-preview-header";
        const label = document.createElement("strong");
        label.textContent = entry.operation ?? "Edit";
        const stateLabel = document.createElement("small");
        stateLabel.textContent = entry.kind === "undo" ? "Earlier" : entry.kind === "redo" ? "Later" : "Active";
        header.append(label, stateLabel);

        const preview = document.createElement("span");
        preview.className = "history-preview-text";
        preview.textContent = contentPreview(entry.content);
        button.append(header, preview);
        sidebarHistoryList.append(button);
    }
}

function contentPreview(content) {
    const text = (content.blocks ?? [])
        .map((block) => block.text.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" / ");
    return text ? text.slice(0, 120) : "Empty document";
}

function restoreHistorySnapshot(target) {
    if (sameContent(state.content, target)) return;

    while (state.undoStack.length > 0 && !sameContent(state.content, target)) {
        undo();
    }
    while (state.redoStack.length > 0 && !sameContent(state.content, target)) {
        redo();
    }
}

function cloneContent(content) {
    return JSON.parse(JSON.stringify(content));
}

function sameContent(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function renameDocument() {
    const title = documentTitle.value.trim();
    if (!title || title === state.title) {
        documentTitle.value = state.title;
        return;
    }

    setSaveState("Renaming", "saving");
    try {
        const response = await fetch(`/documents/${state.documentId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, revision: state.revision }),
        });
        if (!response.ok) {
            throw new Error(`Rename failed: ${response.status}`);
        }

        const renamed = await response.json();
        state.title = renamed.title;
        state.slug = renamed.slug;
        state.revision = renamed.revision;
        documentTitle.value = renamed.title;
        localStorage.setItem("dionysus:lastDocumentSlug", renamed.slug);
        history.replaceState(null, "", `/documents/${encodeURIComponent(renamed.slug)}`);
        revisionLabel.textContent = `Revision ${state.revision}`;
        setSaveState("Saved", "saved");
    } catch (error) {
        console.error(error);
        documentTitle.value = state.title;
        setSaveState("Rename failed", "error");
    }
}

function setSaveState(label, stateName) {
    saveState.textContent = label;
    saveState.dataset.state = stateName;
    if (state.content) {
        revisionLabel.textContent = `Revision ${state.revision}`;
    }
}