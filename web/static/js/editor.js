const editor = document.querySelector("#editor");
const saveState = document.querySelector("#save-state");
const revisionLabel = document.querySelector("#document-revision");
const documentTitle = document.querySelector("#document-title");
const fileNewButton = document.querySelector("#file-new");
const fileOpenButton = document.querySelector("#file-open");
const fileSaveButton = document.querySelector("#file-save");
const fileSaveAsButton = document.querySelector("#file-save-as");
const undoButton = document.querySelector("#undo");
const redoButton = document.querySelector("#redo");
const linkDialog = document.querySelector("#link-dialog");
const linkDialogForm = document.querySelector("#link-dialog-form");
const linkDialogInput = document.querySelector("#link-dialog-input");
const referenceDialog = document.querySelector("#reference-dialog");
const referenceDialogForm = document.querySelector("#reference-dialog-form");
const referenceDialogInput = document.querySelector("#reference-dialog-input");
const linkDialogError = document.querySelector("#link-dialog-error");
const referenceDialogError = document.querySelector("#reference-dialog-error");
const documentSizeLimit = document.querySelector("#document-size-limit");
const documentBlockLimit = document.querySelector("#document-block-limit");
const paragraphMetricsStatus = document.querySelector("#paragraph-metrics-status");
const revisionModal = document.querySelector("#revision-modal");
const revisionList = document.querySelector("#revision-list");
const revisionModalClose = document.querySelector("#revision-modal-close");
const incomingReferencesButton = document.querySelector("#incoming-references");
const incomingReferencesModal = document.querySelector("#incoming-references-modal");
const incomingReferencesList = document.querySelector("#incoming-references-list");
const { mergeMetadataRanges, normalizeBlockWhitespace, removeMetadataRange, splitRanges } = window.EditorTransforms;
const { createDocument: createDocumentRequest, loadDocument: loadDocumentRequest,
    loadIncomingReferences, removeIncomingReference, renameDocument: renameDocumentRequest, updateBlocks } = window.EditorAPI;

for (const tagName of ["d-bold", "d-italic", "d-underline", "d-strike", "d-highlight", "d-color", "d-subscript", "d-superscript"]) {
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
    referencedBlockIds: new Set(),
    undoStack: [],
    redoStack: [],
    lastOperation: "Initial document",
    lastOperationAt: Date.now(),
    contentDirty: false,
    activeBlockId: null,
    editingBlockId: null,
    pointerDownBlockId: null,
    suppressClickBlockId: null,
    copiedBlockId: null,
    copyResetTimer: null,
    historySuppressed: false,
    pendingLink: null,
    linkDialogMode: "link",
    savedSelection: null,
    hasTextSelection: false,
    selectionPointerDown: false,
    doubleClickSelectionPending: false,
    rendering: false,
};

document.addEventListener("mouseup", () => {
    const selectionWasInProgress = state.selectionPointerDown;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
        const anchorElement = selection.anchorNode instanceof Element
            ? selection.anchorNode
            : selection.anchorNode?.parentElement;
        state.suppressClickBlockId = anchorElement?.closest(".paragraph")?.dataset.blockId ?? null;
    }
    state.pointerDownBlockId = null;
    state.selectionPointerDown = false;
    if (selectionWasInProgress) {
        window.setTimeout(handleSelectionChange, 0);
    }
});

const historyLimit = 100;
const safetySaveDelay = 2000;
const maxDocumentRequestBytes = 1 << 20;
const maxDocumentBlockCount = 10000;
const maxParagraphRunes = 5000;
const maxParagraphMarks = 50;
const maxParagraphLinks = 20;
const maxParagraphReferences = 20;
const selectionHighlightName = "dionysus-selection";
let visibleHistory = [];

document.addEventListener("DOMContentLoaded", initialize);
document.addEventListener("keydown", handleHistoryShortcut);
document.addEventListener("keydown", handleLinkModifierKey);
document.addEventListener("keyup", handleLinkModifierKey);
window.addEventListener("blur", clearLinkModifier);
document.addEventListener("selectionchange", handleSelectionChange);
document.addEventListener("mousedown", handleToolbarMouseDown);
document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
window.addEventListener("pagehide", flushPendingSave);
undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
document.querySelector("#history-revisions").addEventListener("click", openHistoryPicker);
revisionModalClose.addEventListener("click", closeRevisionModal);
revisionList.addEventListener("click", handleRevisionModalClick);
revisionModal.addEventListener("click", handleRevisionModalBackdropClick);
bindRibbonToolbar();
linkDialogForm.addEventListener("submit", handleLinkDialogSubmit);
referenceDialogForm.addEventListener("submit", handleLinkDialogSubmit);
linkDialog.addEventListener("click", handleLinkDialogBackdropClick);
referenceDialog.addEventListener("click", handleLinkDialogBackdropClick);
document.addEventListener("keydown", handleLinkDialogKeydown);
document.querySelector("#link-dialog-close").addEventListener("click", closeLinkDialog);
document.querySelector("#link-dialog-cancel").addEventListener("click", closeLinkDialog);
document.querySelector("#reference-dialog-close").addEventListener("click", closeLinkDialog);
document.querySelector("#reference-dialog-cancel").addEventListener("click", closeLinkDialog);
document.querySelector("#incoming-references-close").addEventListener("click", closeIncomingReferences);
incomingReferencesModal.addEventListener("click", handleIncomingReferencesModalClick);
document.addEventListener("keydown", handleRevisionModalKeydown);

function bindRibbonToolbar() {
    fileNewButton.addEventListener("click", createDocumentFromToolbar);
    fileOpenButton.addEventListener("click", openDocumentsFromToolbar);
    fileSaveButton.addEventListener("click", saveImmediately);
    fileSaveAsButton.addEventListener("click", saveDocumentAs);
    for (const button of document.querySelectorAll(".ribbon-format-button")) {
        button.addEventListener("click", handleFormatButtonClick);
    }
    for (const button of document.querySelectorAll(".ribbon-link-button")) {
        button.addEventListener("click", handleLinkButtonClick);
    }
    for (const button of document.querySelectorAll(".ribbon-align-button")) {
        button.addEventListener("click", handleAlignmentButtonClick);
    }
    document.querySelector("#split-paragraph").addEventListener("click", handleSplitButtonClick);
    for (const button of document.querySelectorAll("[data-merge-direction]")) {
        button.addEventListener("click", handleMergeButtonClick);
    }
    document.querySelector("#copy-block-reference").addEventListener("click", handleCopyReferenceButtonClick);
    incomingReferencesButton.addEventListener("click", handleIncomingReferencesButtonClick);
}

function openDocumentsFromToolbar() {
    window.location.assign("/");
}

function handleFormatButtonClick(event) {
    const button = event.currentTarget;
    restoreSavedSelection();
    if (button.dataset.caps) {
        applyCaseTransform(button.dataset.caps);
    } else if (button.dataset.format === "clear") {
        clearSelectedFormatting();
    } else {
        applyTextFormat(button.dataset.format);
    }
}

function handleLinkButtonClick(event) {
    const button = event.currentTarget;
    let context = getSelectionContext({ requireEditing: true });
    const savedSelection = state.savedSelection;
    if (savedSelection) {
        const savedParagraph = findParagraph(savedSelection.blockId);
        const savedBlock = findBlock(savedSelection.blockId);
        const savedContext = savedParagraph && savedBlock ? {
            paragraph: savedParagraph,
            block: savedBlock,
            position: { start: savedSelection.start, end: savedSelection.end },
        } : null;
        if (savedContext && selectionHasLink(savedContext, button.dataset.linkKind)) {
            context = savedContext;
        }
    }
    if (context && !selectionHasLink(context, button.dataset.linkKind) && state.savedSelection) {
        restoreSavedSelection();
        context = getSelectionContext({ requireEditing: true });
    }
    if (!context) {
        restoreSavedSelection();
        context = getSelectionContext({ requireEditing: true });
    }
    if (!context) return;
    if (selectionHasLink(context, button.dataset.linkKind)) {
        removeSelectedLink(context, button.dataset.linkKind);
        return;
    }
    createLink(context.paragraph, context.position, button.dataset.linkKind);
}

function handleAlignmentButtonClick(event) {
    const blockId = state.editingBlockId;
    const paragraph = blockId ? findParagraph(blockId) : null;
    const alignment = event.currentTarget.dataset.alignment;
    if (!paragraph || (paragraph.block.align || "left") === alignment) return;

    recordHistory(`Paragraph alignment: ${alignment}`);
    paragraph.setAlignment(alignment);
}

function handleParagraphBlockChange(event) {
    const changedBlock = event.detail?.block;
    const blockIndex = changedBlock && state.content?.blocks.findIndex((block) => block.id === changedBlock.id);
    if (blockIndex !== undefined && blockIndex >= 0) {
        state.content.blocks[blockIndex] = changedBlock;
    }
    updateRibbonAlignmentAvailability();
    queueSave();
}

function handleSplitButtonClick() {
    if (state.hasTextSelection) restoreSavedSelection();
    const block = state.editingBlockId ? findBlock(state.editingBlockId) : null;
    const paragraph = block ? findParagraph(block.id) : null;
    const position = paragraph ? getSelectionPosition(paragraph) : null;
    if (block && position) splitParagraph(block, position.start, position.end);
}

function handleMergeButtonClick(event) {
    const blockId = state.editingBlockId;
    if (blockId) mergeParagraph(blockId, event.currentTarget.dataset.mergeDirection);
}

function handleCopyReferenceButtonClick(event) {
    const block = state.activeBlockId ? findBlock(state.activeBlockId) : null;
    if (block) copyParagraphLink(block, event.currentTarget);
}

function handleIncomingReferencesButtonClick() {
    openIncomingReferences();
}

function handleRevisionModalBackdropClick(event) {
    if (event.target === revisionModal) closeRevisionModal();
}

function handleLinkDialogBackdropClick(event) {
    if (event.target === linkDialog || event.target === referenceDialog) closeLinkDialog();
}

function handleIncomingReferencesModalClick(event) {
    if (event.target === incomingReferencesModal) {
        closeIncomingReferences();
        return;
    }
    const removeButton = event.target.closest("[data-incoming-reference-id]");
    if (removeButton) removeIncomingReferenceFromModal(removeButton);
}

function handleRevisionModalKeydown(event) {
    if (event.key === "Escape" && !revisionModal.hidden) closeRevisionModal();
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

    try {
        const pathIdentifier = getPathIdentifier();
        const lastSlug = localStorage.getItem("dionysus:lastDocumentSlug");
        const documentState = pathIdentifier
            ? await loadDocument(pathIdentifier)
            : lastSlug
                ? await loadDocument(lastSlug)
                : await createDocument();

        applyDocumentState(documentState);
    } catch (error) {
        console.error(error);
        setSaveState("Unable to load", "error");
    }
}

function applyDocumentState(documentState) {
    state.documentId = documentState.id;
    state.title = documentState.title;
    state.slug = documentState.slug;
    const recoveredContent = readRecovery(documentState.id);
    state.syncedContent = cloneContent(documentState.content);
    state.content = recoveredContent ?? documentState.content;
    state.revision = documentState.revision;
    state.referencedBlockIds = new Set(documentState.referencedBlockIds ?? []);
    updateDocumentLimitMeters();
    state.undoStack = [];
    state.redoStack = [];
    state.lastOperation = "Initial document";
    state.lastOperationAt = Date.now();
    state.contentDirty = false;
    state.activeBlockId = null;
    state.editingBlockId = null;
    documentTitle.value = documentState.title;
    localStorage.setItem("dionysus:lastDocumentSlug", documentState.slug);
    history.replaceState(null, "", `/documents/${encodeURIComponent(documentState.slug)}${window.location.hash}`);
    const repairedLegacyOffsets = repairLegacyOffsetBlocks(state.content);
    render();
    focusHashTarget();
    updateHistoryButtons();
    if (recoveredContent || repairedLegacyOffsets) {
        queueSave();
    } else {
        setSaveState("Saved", "saved");
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
    return createDocumentRequest();
}

async function loadDocument(identifier) {
    return loadDocumentRequest(identifier);
}

function openHistoryPicker() {
    renderRevisionModal();
    revisionModal.hidden = false;
    document.body.classList.add("revision-modal-open");
    revisionModalClose.focus();
}

function closeRevisionModal() {
    revisionModal.hidden = true;
    document.body.classList.remove("revision-modal-open");
}

function renderRevisionModal() {
    const entries = getHistoryEntries().sort((left, right) => right.historyOrder - left.historyOrder);
    visibleHistory = entries;
    revisionList.replaceChildren();

    if (!entries.length) {
        const empty = document.createElement("p");
        empty.className = "revision-empty";
        empty.textContent = "No revisions yet";
        revisionList.append(empty);
        return;
    }

    for (const [index, entry] of entries.entries()) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = `revision-item${entry.kind === "current" ? " is-current" : ""}`;
        option.dataset.historyIndex = String(index);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(entry.kind === "current"));

        const header = document.createElement("span");
        header.className = "revision-item-header";
        const operation = document.createElement("strong");
        operation.textContent = entry.operation ?? "Edit";
        const status = document.createElement("span");
        status.textContent = formatHistoryStatus(entry);
        header.append(operation, status);

        const preview = document.createElement("div");
        preview.className = "revision-item-preview";
        const blocks = entry.content?.blocks ?? [];
        const previousEntry = entries.find((candidate) => candidate.historyOrder === entry.historyOrder - 1);
        let changedBlockCount = 0;
        if (blocks.length) {
            for (const block of blocks) {
                const previousBlock = previousEntry
                    && (previousEntry.content?.blocks ?? []).find((candidate) => candidate.id === block.id);
                const changedRanges = getRevisionChangedRanges(block, previousBlock, Boolean(previousEntry));
                if (!changedRanges.length) continue;

                const paragraph = document.createElement("div");
                paragraph.className = "revision-preview-paragraph";
                paragraph.setAttribute("aria-hidden", "true");
                renderParagraphContent(paragraph, block, changedRanges);
                preview.append(paragraph);
                changedBlockCount += 1;
            }
        }
        if (!changedBlockCount) {
            preview.textContent = blocks.length ? "No paragraph changes" : "Empty document";
        }
        option.append(header, preview);
        revisionList.append(option);
    }
}

function getRevisionChangedRanges(block, previousBlock, hasPreviousSnapshot) {
    if (!hasPreviousSnapshot) return [];
    if (!previousBlock) {
        return block.text.length ? [{ start: 0, end: block.text.length }] : [];
    }
    if (block.text === previousBlock.text && JSON.stringify(block.marks ?? []) === JSON.stringify(previousBlock.marks ?? [])
        && JSON.stringify(block.links ?? []) === JSON.stringify(previousBlock.links ?? [])
        && JSON.stringify(block.references ?? []) === JSON.stringify(previousBlock.references ?? [])) {
        return [];
    }

    let start = 0;
    while (start < block.text.length && start < previousBlock.text.length
        && block.text[start] === previousBlock.text[start]) {
        start += 1;
    }
    let end = block.text.length;
    let previousEnd = previousBlock.text.length;
    while (end > start && previousEnd > start && block.text[end - 1] === previousBlock.text[previousEnd - 1]) {
        end -= 1;
        previousEnd -= 1;
    }
    if (end > start) return [{ start, end }];

    const metadataRanges = [...(block.marks ?? []), ...(block.links ?? []), ...(block.references ?? []),
    ...(previousBlock.marks ?? []), ...(previousBlock.links ?? []), ...(previousBlock.references ?? [])]
        .map((range) => ({
            start: Math.max(0, Math.min(range.start, block.text.length)),
            end: Math.max(0, Math.min(range.end, block.text.length)),
        }))
        .filter((range) => range.end > range.start);
    return metadataRanges;
}

function handleRevisionModalClick(event) {
    const option = event.target.closest("[data-history-index]");
    if (!option) return;
    restoreHistorySnapshot(visibleHistory[Number(option.dataset.historyIndex)]);
    closeRevisionModal();
}

async function createDocumentFromToolbar() {
    const title = window.prompt("Document title", "Untitled document");
    if (title === null || !title.trim()) return;

    fileNewButton.disabled = true;
    try {
        const documentState = await createDocumentRequest(title.trim());
        localStorage.setItem("dionysus:lastDocumentSlug", documentState.slug);
        window.location.assign(`/documents/${encodeURIComponent(documentState.slug)}`);
    } catch (error) {
        console.error(error);
        fileNewButton.disabled = false;
        setSaveState("Unable to create", "error");
    }
}

async function saveDocumentAs() {
    const title = window.prompt("Save document as", `${state.title} copy`);
    if (title === null || !title.trim() || !state.content) return;

    try {
        const documentState = await createDocumentRequest(title.trim());
        await updateBlocks(documentState.id, {
            revision: documentState.revision,
            blocks: cloneContent(state.content).blocks,
            replaceAll: true,
        });

        localStorage.setItem("dionysus:lastDocumentSlug", documentState.slug);
        window.location.assign(`/documents/${encodeURIComponent(documentState.slug)}`);
    } catch (error) {
        console.error(error);
        setSaveState("Save as failed", "error");
    }
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
    state.rendering = true;
    editor.replaceChildren();
    state.rendering = false;

    if (focusBlockId !== null) {
        state.activeBlockId = focusBlockId;
    }
    if (state.activeBlockId !== null && !state.content.blocks.some((block) => block.id === state.activeBlockId)) {
        state.activeBlockId = state.content.blocks[0]?.id ?? null;
    }

    for (const block of state.content.blocks) {
        const paragraph = document.createElement("d-paragraph");
        const isActive = block.id === state.activeBlockId;
        const isEditing = block.id === state.editingBlockId;
        paragraph.render(block);
        paragraph.setActive(isActive);
        paragraph.setEditing(isEditing);
        paragraph.addEventListener("block-change", handleParagraphBlockChange);
        paragraph.addEventListener("mousedown", (event) => {
            if (event.button === 0) {
                state.pointerDownBlockId = block.id;
                state.activeBlockId = block.id;
                updateActiveParagraphMetrics();
                updateRibbonCopyAvailability();
                for (const activeParagraph of editor.querySelectorAll(".paragraph.is-active")) {
                    if (activeParagraph === paragraph) continue;
                    activeParagraph.classList.remove("is-active");
                }
                state.editingBlockId = block.id;
                paragraph.setEditing(true);
                paragraph.classList.add("is-active");
                updateRibbonAlignmentAvailability();
                updateRibbonCopyAvailability();
                updateRibbonParagraphAvailability();
            }
        });
        paragraph.addEventListener("click", (event) => {
            if (state.suppressClickBlockId === block.id) {
                state.suppressClickBlockId = null;
                return;
            }
        });
        paragraph.addEventListener("focus", () => {
            state.activeBlockId = block.id;
            state.editingBlockId = block.id;
            paragraph.setEditing(true);
            paragraph.setActive(true);
            updateActiveParagraphMetrics();
            updateRibbonAlignmentAvailability();
            updateRibbonCopyAvailability();
            updateRibbonParagraphAvailability();
        });
        paragraph.addEventListener("input", handleInput);
        paragraph.addEventListener("blur", handleParagraphBlur);
        paragraph.addEventListener("beforeinput", handleBeforeInput);
        paragraph.addEventListener("copy", handleCopy);
        paragraph.addEventListener("paste", handlePaste);
        paragraph.addEventListener("keydown", handleKeydown);
        paragraph.addEventListener("dblclick", handleDoubleClick);

        editor.append(paragraph);
    }

    updateRibbonAlignmentAvailability();
    updateRibbonCopyAvailability();
    updateRibbonParagraphAvailability();
    updateActiveParagraphMetrics();

    if (focusBlockId !== null) {
        const paragraph = findParagraph(focusBlockId);
        if (paragraph) {
            paragraph.focusAt(cursorOffset ?? paragraph.textContent.length);
        }
    }
}

function updateParagraphMetrics(metricsElement, block) {
    const characterCount = Array.from(block.text).length;
    const wordCount = block.text.trim() === "" ? 0 : block.text.trim().split(/\s+/u).length;
    const markCount = block.marks?.length ?? 0;
    const linkCount = block.links?.length ?? 0;
    const referenceCount = block.references?.length ?? 0;
    metricsElement.textContent = `${characterCount.toLocaleString("sr-Latn")} / ${maxParagraphRunes.toLocaleString("sr-Latn")} znakova · ${wordCount.toLocaleString("sr-Latn")} reči · ${markCount} / ${maxParagraphMarks} formatiranja · ${linkCount} / ${maxParagraphLinks} linkova · ${referenceCount} / ${maxParagraphReferences} referenci`;
}

function updateActiveParagraphMetrics() {
    if (!paragraphMetricsStatus) return;
    const block = state.activeBlockId ? findBlock(state.activeBlockId) : null;
    if (block) {
        updateParagraphMetrics(paragraphMetricsStatus, block);
    } else {
        paragraphMetricsStatus.textContent = "";
    }
}

function updateRibbonCopyAvailability() {
    const button = document.querySelector("#copy-block-reference");
    if (button) button.disabled = !state.activeBlockId || !findBlock(state.activeBlockId);
    incomingReferencesButton.disabled = !state.activeBlockId || !findBlock(state.activeBlockId);
}

async function openIncomingReferences(blockID = state.activeBlockId) {
    const block = blockID ? findBlock(blockID) : null;
    if (!block) return;

    incomingReferencesModal.hidden = false;
    incomingReferencesList.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "incoming-references-empty";
    loading.textContent = "Loading...";
    incomingReferencesList.append(loading);

    try {
        const references = await loadIncomingReferences(state.documentId, block.id);
        renderIncomingReferences(block.id, references);
    } catch (error) {
        incomingReferencesList.replaceChildren();
        const failure = document.createElement("p");
        failure.className = "incoming-references-empty";
        failure.textContent = "Unable to load incoming references.";
        incomingReferencesList.append(failure);
    }
}

function renderIncomingReferences(targetBlockID, references) {
    incomingReferencesList.replaceChildren();
    if (references.length === 0) {
        const empty = document.createElement("p");
        empty.className = "incoming-references-empty";
        empty.textContent = "No incoming references.";
        incomingReferencesList.append(empty);
        return;
    }

    for (const reference of references) {
        const item = document.createElement("div");
        item.className = "incoming-reference-item";
        const source = document.createElement("a");
        source.href = `/documents/${encodeURIComponent(reference.sourceSlug)}#block-${encodeURIComponent(reference.sourceBlockId)}`;
        source.textContent = reference.sourceDocument;
        source.title = `Open ${reference.sourceBlockId}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "incoming-reference-remove";
        remove.dataset.incomingReferenceId = String(reference.id);
        remove.dataset.targetBlockId = targetBlockID;
        remove.setAttribute("aria-label", `Remove reference from ${reference.sourceDocument}`);
        remove.title = "Remove reference";
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "link_off";
        remove.append(icon);
        item.append(source, remove);
        incomingReferencesList.append(item);
    }
}

async function removeIncomingReferenceFromModal(button) {
    button.disabled = true;
    try {
        await removeIncomingReference(state.documentId, button.dataset.targetBlockId, button.dataset.incomingReferenceId);
        const documentState = await loadDocument(state.slug);
        applyDocumentState(documentState);
        await openIncomingReferences(button.dataset.targetBlockId);
    } catch (error) {
        button.disabled = false;
    }
}

function closeIncomingReferences() {
    incomingReferencesModal.hidden = true;
}

function updateRibbonParagraphAvailability() {
    const block = state.editingBlockId ? findBlock(state.editingBlockId) : null;
    const paragraph = block ? findParagraph(block.id) : null;
    const canEdit = Boolean(block && paragraph);
    const splitButton = document.querySelector("#split-paragraph");
    if (splitButton) splitButton.disabled = !canEdit || isReferencedParagraph(block);
    for (const button of document.querySelectorAll("[data-merge-direction]")) {
        button.disabled = !canEdit || !canMergeParagraph(block, button.dataset.mergeDirection, paragraph);
    }
}

function isReferencedParagraph(block) {
    if (!block || !state.content) {
        return false;
    }
    return state.referencedBlockIds.has(block.id) || state.content.blocks.some((candidate) =>
        (candidate.references ?? []).some((reference) =>
            String(reference.documentId) === String(state.documentId)
            && reference.blockId === block.id
        )
    );
}

function canMergeParagraph(block, direction, paragraph = findParagraph(block.id), requireDOM = true) {
    if (!block || block.type !== "paragraph") {
        return false;
    }
    const index = state.content.blocks.indexOf(block);
    const adjacentIndex = direction === "above" ? index - 1 : index + 1;
    if (index < 0 || adjacentIndex < 0 || adjacentIndex >= state.content.blocks.length) {
        return false;
    }

    const adjacentBlock = state.content.blocks[adjacentIndex];
    const adjacentParagraph = adjacentBlock && findParagraph(adjacentBlock.id);
    if (!adjacentBlock || adjacentBlock.type !== "paragraph") {
        return false;
    }
    if (isReferencedParagraph(block) || isReferencedParagraph(adjacentBlock)) {
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

function updateRibbonAlignmentAvailability() {
    const activeBlock = state.activeBlockId ? findBlock(state.activeBlockId) : null;
    const canEdit = Boolean(state.editingBlockId && findBlock(state.editingBlockId));
    const alignment = activeBlock?.align || "left";
    for (const button of document.querySelectorAll(".ribbon-align-button")) {
        button.disabled = !canEdit;
        button.setAttribute("aria-pressed", String(Boolean(activeBlock && button.dataset.alignment === alignment)));
    }
}

function renderParagraphContent(paragraph, block, changedRanges = []) {
    const boundaries = new Set([0, block.text.length]);
    for (const range of [...(block.marks ?? []), ...(block.links ?? []), ...(block.references ?? []), ...changedRanges]) {
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
        const reference = (block.references ?? []).find((candidate) => candidate.start <= start && candidate.end >= end);

        let node = document.createTextNode(text);
        for (const mark of marks) {
            const element = document.createElement(markElement(mark.style));
            element.append(node);
            node = element;
        }
        if (link) {
            const linkElement = document.createElement("d-link");
            linkElement.setAttribute("href", getParagraphLinkHref(link));
            linkElement.append(node);
            node = linkElement;
        }
        if (reference) {
            const referenceElement = document.createElement("d-reference");
            referenceElement.dataset.documentId = reference.documentId;
            referenceElement.dataset.blockId = reference.blockId;
            referenceElement.append(node);
            node = referenceElement;
        }
        if (changedRanges.some((range) => range.start <= start && range.end >= end)) {
            const changeElement = document.createElement("d-change");
            changeElement.append(node);
            node = changeElement;
        }
        paragraph.append(node);
    }
}

function getParagraphLinkHref(link) {
    return link.url;
}

function getReferenceTarget(reference) {
    return {
        documentId: reference.dataset.documentId,
        blockId: reference.dataset.blockId,
    };
}

function getPastedLinkTarget(node) {
    if (node.tagName === "D-REFERENCE") {
        return parseReferenceLink(`/documents/${encodeURIComponent(node.dataset.documentId)}#block-${encodeURIComponent(node.dataset.blockId)}`);
    }
    return parseExternalLink(node.getAttribute("href") ?? "");
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

const pasteEditorTags = new Set(["D-BOLD", "D-ITALIC", "D-UNDERLINE", "D-STRIKE", "D-HIGHLIGHT", "D-COLOR", "D-SUBSCRIPT", "D-SUPERSCRIPT", "D-LINK", "D-REFERENCE"]);

function handlePaste(event) {
    const paragraph = event.currentTarget;
    if (isReferencedParagraph(findBlock(paragraph.dataset.blockId))) {
        event.preventDefault();
        return;
    }
    if (state.editingBlockId !== paragraph.dataset.blockId) {
        event.preventDefault();
        return;
    }
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
            if ((node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") && !getPastedLinkTarget(node)) {
                appendPastedNodes(node, target);
                continue;
            }

            const element = document.createElement(node.tagName.toLowerCase());
            if (node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") {
                const link = getPastedLinkTarget(node);
                if (node.tagName === "D-REFERENCE") {
                    element.dataset.documentId = link.documentId;
                    element.dataset.blockId = link.blockId;
                } else {
                    element.setAttribute("href", link.url);
                }
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
            if ((node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") && !getPastedLinkTarget(node)) {
                for (const child of node.childNodes) appendNode(child, target);
                return;
            }
            const element = document.createElement(node.tagName.toLowerCase());
            if (node.tagName === "D-LINK" || node.tagName === "D-REFERENCE") {
                const link = getPastedLinkTarget(node);
                element.dataset.documentId = link.documentId;
                element.dataset.blockId = link.blockId;
                if (node.tagName === "D-LINK") element.setAttribute("href", getParagraphLinkHref(link));
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
    if (isReferencedParagraph(findBlock(paragraph.dataset.blockId))) {
        return;
    }
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
        color: "d-color",
        subscript: "d-subscript",
        superscript: "d-superscript",
    }[style] ?? "span";
}

function handleInput(event) {
    const paragraph = event.currentTarget;
    const block = findBlock(paragraph.dataset.blockId);
    if (!block || state.editingBlockId !== block.id) {
        paragraph.textContent = block?.text ?? "";
        return;
    }
    if (isReferencedParagraph(block)) {
        const cursorOffset = getSelectionPosition(paragraph)?.start ?? block.text.length;
        render(block.id, cursorOffset);
        return;
    }

    if (!state.historySuppressed) {
        recordHistory(event.inputType === "insertFromPaste" ? "Text paste" : "Text edit");
    }
    state.contentDirty = true;
    const { textChanged } = paragraph.syncContentFromDOM();
    updateActiveParagraphMetrics();
    const cursorOffset = getSelectionPosition(paragraph)?.start ?? block.text.length;
    if (textChanged) {
        render(block.id, cursorOffset);
    }
    repairLegacyOffsetBlocks(state.content);
    queueSave();
}

function handleParagraphBlur(event) {
    const paragraph = event.currentTarget;
    const relatedTarget = event.relatedTarget;
    if (state.rendering) return;
    if (relatedTarget instanceof Node && paragraph.contains(relatedTarget)) {
        return;
    }
    paragraph.classList.remove("is-active");
    if (state.editingBlockId === paragraph.dataset.blockId) {
        normalizeParagraphOnBlur(paragraph);
        state.editingBlockId = null;
        state.activeBlockId = null;
        updateActiveParagraphMetrics();
        paragraph.contentEditable = "false";
        paragraph.setAttribute("aria-readonly", "true");
        updateRibbonAlignmentAvailability();
        updateRibbonCopyAvailability();
        updateRibbonParagraphAvailability();
    }
}

function normalizeParagraphOnBlur(paragraph, persist = true) {
    if (!paragraph.isConnected || paragraph.contains(document.activeElement)) {
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
    block.references = remapRangesForTextChange(block.references, start, oldEnd, newEnd - start);
    block.text = normalizedText;
    render(block.id);
    if (persist) queueSave();
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
        state.doubleClickSelectionPending = false;
        return;
    }
    const text = paragraph.textContent;
    let start = position.start;
    let end = position.end;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    selectOffsets(paragraph, start, end);
    state.doubleClickSelectionPending = false;
    handleSelectionChange();
}

function handleBeforeInput(event) {
    const paragraph = event.currentTarget;
    const block = findBlock(paragraph.dataset.blockId);
    const position = getSelectionPosition(paragraph);
    if (!block || !position) {
        return;
    }
    if (isReferencedParagraph(block)) {
        event.preventDefault();
        return;
    }

    if (state.editingBlockId !== block.id && event.inputType !== "insertParagraph") {
        event.preventDefault();
        return;
    }
    if (event.inputType !== "insertParagraph") {
        return;
    }

    event.preventDefault();
    splitParagraph(block, position.start, position.end);
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
            block.references = cloneRanges(reference.references);
            repaired = true;
            break;
        }
    }
    return repaired;
}

function hasShiftedMetadata(block, reference) {
    const currentMarks = block.marks ?? [];
    const currentLinks = block.links ?? [];
    const currentReferences = block.references ?? [];
    const referenceMarks = reference.marks ?? [];
    const referenceLinks = reference.links ?? [];
    if (currentMarks.length + currentLinks.length === 0
        || currentMarks.length !== referenceMarks.length
        || currentLinks.length !== referenceLinks.length
        || currentReferences.length !== (reference.references ?? []).length) {
        return false;
    }

    return JSON.stringify(currentMarks) === JSON.stringify(shiftRanges(referenceMarks))
        && JSON.stringify(currentLinks) === JSON.stringify(shiftRanges(referenceLinks))
        && JSON.stringify(currentReferences) === JSON.stringify(shiftRanges(reference.references ?? []));
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
        block.links = normalizeRanges(block.links, (range) => range.url);
        block.references = normalizeRanges(block.references);
        if (block.marks.length === 0) delete block.marks;
        if (block.links.length === 0) delete block.links;
        if (block.references.length === 0) delete block.references;
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
    if (state.doubleClickSelectionPending) {
        clearSavedSelectionHighlight();
        return;
    }
    updateRibbonFormatAvailability(false);
    const commandBarFocused = false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        if (!commandBarFocused) {
            state.hasTextSelection = false;
            clearSavedSelectionHighlight();
        }
        return;
    }
    const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    const paragraph = anchorElement?.closest(".paragraph");
    if (!paragraph || !paragraph.contains(selection.focusNode)) {
        if (!commandBarFocused) {
            state.hasTextSelection = false;
            clearSavedSelectionHighlight();
        }
        return;
    }
    const position = getSelectionPosition(paragraph);
    if (!position || position.start === position.end) {
        if (!commandBarFocused) {
            state.hasTextSelection = false;
            clearSavedSelectionHighlight();
        }
        return;
    }
    state.savedSelection = {
        blockId: paragraph.dataset.blockId,
        start: position.start,
        end: position.end,
    };
    state.hasTextSelection = true;
    updateSavedSelectionHighlight(paragraph, position);
    if (state.editingBlockId !== paragraph.dataset.blockId) {
        return;
    }
    updateRibbonFormatAvailability(true, paragraph, position);
    if (state.selectionPointerDown) {
        updateSavedSelectionHighlight(paragraph, position);
        return;
    }
    updateSavedSelectionHighlight(paragraph, position);
}

function updateSavedSelectionHighlight(paragraph, position) {
    if (!window.CSS?.highlights) return;
    const range = createRangeForOffsets(paragraph, position.start, position.end);
    if (!range) return;
    CSS.highlights.set(selectionHighlightName, new Highlight(range));
}

function restoreSavedSelectionHighlight() {
    const savedSelection = state.savedSelection;
    if (!state.hasTextSelection || !savedSelection) return;
    const paragraph = findParagraph(savedSelection.blockId);
    if (paragraph) {
        updateSavedSelectionHighlight(paragraph, savedSelection);
    }
}

function clearSavedSelectionHighlight() {
    window.CSS?.highlights?.delete(selectionHighlightName);
}

function getSelectionContext({ requireEditing = false } = {}) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    const paragraph = anchorElement?.closest(".paragraph");
    if (!paragraph || !paragraph.contains(selection.focusNode)) return null;
    const block = findBlock(paragraph.dataset.blockId);
    const position = getSelectionPosition(paragraph);
    if (!block || !position || position.start === position.end) return null;
    if (requireEditing && state.editingBlockId !== block.id) return null;
    return { selection, paragraph, block, position };
}

function isTextFormatActive(format) {
    const savedSelection = state.savedSelection;
    if (!state.hasTextSelection || !savedSelection || savedSelection.start === savedSelection.end) return false;
    const block = findBlock(savedSelection.blockId);
    return Boolean(block?.marks?.some((mark) => (
        mark.style === format
        && mark.start <= savedSelection.start
        && mark.end >= savedSelection.end
    )));
}

function updateRibbonFormatAvailability(enabled, paragraph = null, position = null) {
    const block = paragraph ? findBlock(paragraph.dataset.blockId) : null;
    for (const button of document.querySelectorAll(".ribbon-format-button")) {
        button.disabled = !enabled || Boolean(block && button.dataset.caps && isReferencedParagraph(block));
        const active = enabled && block && position
            && block.marks?.some((mark) => (
                mark.style === button.dataset.format
                && mark.start <= position.start
                && mark.end >= position.end
            ));
        button.setAttribute("aria-pressed", String(Boolean(active)));
    }
    for (const button of document.querySelectorAll(".ribbon-link-button")) {
        const linkKind = button.dataset.linkKind;
        const hasLink = Boolean(enabled && block && position && linkKind
            && selectionHasLink({ block, position }, linkKind));
        button.disabled = !enabled;
        button.setAttribute("aria-pressed", String(hasLink));
        if (linkKind) {
            const label = hasLink ? `Remove ${linkKind}` : `Add ${linkKind === "reference" ? "ref" : "link"}`;
            button.setAttribute("aria-label", label);
            button.title = label;
        }
    }
}

function selectionHasLink({ block, position }, linkType) {
    const ranges = linkType === "reference" ? block.references : block.links;
    return Boolean(ranges?.some((range) => linkType === "reference"
        ? range.start >= position.start && range.start <= position.end
        : range.start >= position.start && range.end <= position.end));
}

function handleToolbarMouseDown(event) {
    if (event.target.closest?.(".ribbon-format-button, .ribbon-link-button, .ribbon-align-button, .ribbon-copy-button, .ribbon-paragraph-button, .ribbon-history-button")) {
        event.preventDefault();
        if (state.hasTextSelection) restoreSavedSelection();
        return;
    }
    state.selectionPointerDown = event.button === 0
        && event.target instanceof Element
        && Boolean(event.target.closest(".paragraph"));
    state.doubleClickSelectionPending = event.button === 0 && event.detail === 2
        && event.target instanceof Element
        && Boolean(event.target.closest(".paragraph"));
    if (event.button === 0) {
        clearSavedSelectionHighlight();
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

function clearSelectedFormatting() {
    restoreSavedSelection();
    const context = getSelectionContext({ requireEditing: true });
    if (!context) return;
    const { paragraph, block, position } = context;
    recordHistory("Formatting cleared");
    paragraph.clearMarks(position.start, position.end);
    render();
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.end);
    queueSave();
    handleSelectionChange();
}

function removeSelectedLink(context, linkType) {
    const { paragraph, block, position } = context;
    const ranges = linkType === "reference" ? block.references : block.links;
    const selectedLink = ranges?.find((range) => linkType === "reference"
        ? range.start >= position.start && range.start <= position.end
        : range.start >= position.start && range.end <= position.end);
    if (!selectedLink) return;
    recordHistory(`Paragraph ${linkType} removed`);
    let selectionEnd = position.end;
    const removeStart = linkType === "reference" ? selectedLink.start : position.start;
    const removeEnd = linkType === "reference" ? selectedLink.end : position.end;
    if (linkType === "reference") {
        paragraph.removeReference(removeStart, removeEnd);
    } else {
        paragraph.removeLink(removeStart, removeEnd);
    }
    render(block.id, selectionEnd);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, selectionEnd);
    queueSave();
    handleSelectionChange();
}

function applyTextFormat(format) {
    restoreSavedSelection();
    const context = getSelectionContext({ requireEditing: true });
    if (!context) return;
    const { paragraph, block, position } = context;
    const active = block.marks?.some((mark) => mark.style === format && mark.start <= position.start && mark.end >= position.end);
    recordHistory(`Formatting: ${format} ${active ? "removed" : "added"}`);
    paragraph.toggleMark(format, position.start, position.end);
    render(block.id, position.end);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.end);
    queueSave();
    handleSelectionChange();
}

function applyCaseTransform(caseType) {
    const savedSelection = state.savedSelection;
    let paragraph = savedSelection && findParagraph(savedSelection.blockId);
    let block = savedSelection && findBlock(savedSelection.blockId);
    let position = savedSelection && {
        start: savedSelection.start,
        end: savedSelection.end,
    };
    if (savedSelection && state.editingBlockId !== savedSelection.blockId) return;
    if (!block || !position) {
        const selection = window.getSelection();
        const anchorElement = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
            ? selection.anchorNode
            : selection?.anchorNode?.parentElement;
        paragraph = anchorElement?.closest(".paragraph");
        block = paragraph && findBlock(paragraph.dataset.blockId);
        if (paragraph && state.editingBlockId !== paragraph.dataset.blockId) return;
        position = paragraph && getSelectionPosition(paragraph);
    }
    if (!block || !position || position.start === position.end) {
        return;
    }
    if (isReferencedParagraph(block)) {
        return;
    }

    const transform = caseType === "upper"
        ? (text) => text.toUpperCase()
        : caseType === "lower"
            ? (text) => text.toLowerCase()
            : (text) => text.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (match) => match.toUpperCase());
    recordHistory(`Text case: ${caseType}`);
    const result = paragraph.transformText(position.start, position.end, transform);
    if (!result?.changed) {
        return;
    }
    render(block.id, result.end);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, result.end);
    queueSave();
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

function handleKeydown(event) {
    const paragraph = event.currentTarget;
    const block = findBlock(paragraph.dataset.blockId);
    const position = getSelectionPosition(paragraph);
    if (!block || !position) {
        return;
    }

    if (isReferencedParagraph(block)
        && !event.ctrlKey && !event.metaKey
        && (event.key === "Enter" || event.key === "Backspace" || event.key === "Delete" || event.key.length === 1)) {
        event.preventDefault();
        return;
    }

    if (state.editingBlockId !== block.id && event.key !== "Enter" && event.key !== "Home" && event.key !== "End") {
        if (event.key === "Backspace" || event.key === "Delete" || event.key.length === 1) {
            event.preventDefault();
        }
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
    if (index < 0 || block.type !== "paragraph" || isReferencedParagraph(block)) {
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
    const [beforeReferences, afterReferences] = splitRanges(block.references, before.length, afterStart);
    const newBlock = {
        id: createBlockId(),
        type: "paragraph",
        text: after,
        ...(block.align ? { align: block.align } : {}),
        marks: afterMarks,
        links: afterLinks,
        references: afterReferences,
    };

    block.text = before;
    block.marks = beforeMarks;
    block.links = beforeLinks;
    block.references = beforeReferences;
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

    const linkAtCaret = (block.links ?? []).find((link) => link.start === start || link.end === start);
    const referenceAtCaret = (block.references ?? []).find((reference) => reference.start === start || reference.end === start);
    if (linkAtCaret || referenceAtCaret) {
        recordHistory("Link remove");
        if (referenceAtCaret) {
            block.references = (block.references ?? []).filter((reference) => reference !== referenceAtCaret);
        } else {
            block.links = (block.links ?? []).filter((link) => link !== linkAtCaret);
        }
        render(block.id, start);
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
    if (block.type !== "paragraph" || previous.type !== "paragraph"
        || isReferencedParagraph(block) || isReferencedParagraph(previous)) {
        return;
    }
    recordHistory("Paragraph merge above");
    const previousLength = previous.text.length;
    previous.text += ` ${block.text}`;
    previous.marks = mergeMetadataRanges(previous.marks, block.marks, previousLength + 1);
    previous.links = mergeMetadataRanges(previous.links, block.links, previousLength + 1);
    previous.references = mergeMetadataRanges(previous.references, block.references, previousLength + 1);
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
    if (block.type !== "paragraph" || next.type !== "paragraph"
        || isReferencedParagraph(block) || isReferencedParagraph(next)) {
        return;
    }
    recordHistory("Paragraph merge below");
    block.text += next.text;
    block.marks = mergeMetadataRanges(block.marks, next.marks, start);
    block.links = mergeMetadataRanges(block.links, next.links, start);
    block.references = mergeMetadataRanges(block.references, next.references, start);
    const cursorOffset = normalizeBlockWhitespace(block, start);
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
    const range = createRangeForOffsets(paragraph, start, end);
    if (!range) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

function createRangeForOffsets(paragraph, start, end) {
    const startRange = document.createRange();
    startRange.selectNodeContents(paragraph);
    moveRangeToOffset(startRange, paragraph, start);
    const endRange = document.createRange();
    endRange.selectNodeContents(paragraph);
    moveRangeToOffset(endRange, paragraph, end);
    const range = document.createRange();
    range.setStart(startRange.startContainer, startRange.startOffset);
    range.setEnd(endRange.startContainer, endRange.startOffset);
    return range;
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

function createLink(paragraph, position = getSelectionPosition(paragraph), linkType = "link") {
    if (!position || position.start === position.end) {
        setSaveState("Select text first", "error");
        return;
    }

    state.pendingLink = { blockId: paragraph.dataset.blockId, position };
    state.linkDialogMode = linkType === "reference" ? "reference" : "link";
    const dialog = state.linkDialogMode === "reference" ? referenceDialog : linkDialog;
    const input = state.linkDialogMode === "reference" ? referenceDialogInput : linkDialogInput;
    const error = state.linkDialogMode === "reference" ? referenceDialogError : linkDialogError;
    input.value = "";
    error.hidden = true;
    dialog.hidden = false;
    input.focus();
}

function handleLinkDialogSubmit(event) {
    event.preventDefault();
    const input = state.linkDialogMode === "reference" ? referenceDialogInput : linkDialogInput;
    const error = state.linkDialogMode === "reference" ? referenceDialogError : linkDialogError;
    const target = state.linkDialogMode === "reference"
        ? parseReferenceLink(input.value.trim())
        : parseExternalLink(input.value.trim());
    if (!target) {
        error.hidden = false;
        input.focus();
        return;
    }

    const pendingLink = { ...state.pendingLink, linkType: state.linkDialogMode };
    closeLinkDialog();
    const paragraph = pendingLink && findParagraph(pendingLink.blockId);
    const block = paragraph && findBlock(pendingLink.blockId);
    const position = pendingLink?.position;
    if (!paragraph || !block || !position) return;
    if (pendingLink.linkType === "reference") {
        addParagraphReference(block, position, target);
        return;
    }
    recordHistory("Paragraph link added");
    paragraph.addLink(position.start, position.end, target.url);
    render(block.id, position.end);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.end);
    queueSave();
    handleSelectionChange();
}

function addParagraphReference(block, position, target) {
    const paragraph = findParagraph(block.id);
    recordHistory("Paragraph reference added");
    paragraph.addReference(position.start, position.end, target.documentId, target.blockId);
    render(block.id, position.end);
    const updatedParagraph = findParagraph(block.id);
    selectOffsets(updatedParagraph, position.start, position.end);
    queueSave();
    handleSelectionChange();
}

function closeLinkDialog() {
    linkDialog.hidden = true;
    referenceDialog.hidden = true;
    state.pendingLink = null;
    linkDialogError.hidden = true;
    referenceDialogError.hidden = true;
}

function handleLinkDialogKeydown(event) {
    if (event.key === "Escape" && (!linkDialog.hidden || !referenceDialog.hidden)) {
        event.preventDefault();
        closeLinkDialog();
    }
}

function parseExternalLink(value) {
    try {
        const normalizedValue = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
            ? value
            : `https://${value}`;
        const url = new URL(normalizedValue);
        if (!/^https?:$/.test(url.protocol) || !url.hostname) {
            return null;
        }
        return { url: url.href };
    } catch (error) {
        return null;
    }
}

function parseReferenceLink(value) {
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
    state.saveTimer = window.setTimeout(() => {
        state.saveTimer = null;
        save();
    }, safetySaveDelay);
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
    queueSave();
}

function handleDocumentVisibilityChange() {
    if (document.visibilityState === "hidden") clearTimeout(state.saveTimer);
}

function flushPendingSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
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

    state.saveQueued = false;
    state.saveInFlight = true;
    setSaveState("Saving", "saving");
    const contentToSave = cloneContent(state.content);
    console.log("save start", contentToSave.blocks.map((block) => block.text));
    const revisionAtStart = state.revision;
    const blockSave = getBlockSavePayload(contentToSave, revisionAtStart);
    const payload = JSON.stringify(blockSave);
    updateDocumentLimitMeters(JSON.stringify({ content: contentToSave, revision: revisionAtStart }));

    try {
        const saved = await updateBlocks(state.documentId, JSON.parse(payload));
        console.log("save response", saved.content.blocks.map((block) => block.text), state.content.blocks.map((block) => block.text), sameContent(state.content, contentToSave));
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
        if (error.status === 409) {
            await recoverFromConflict();
            return;
        }
        console.error(error);
        setSaveState("Save failed", "error");
    } finally {
        state.saveInFlight = false;
        fileSaveButton.disabled = state.saveInFlight || !state.contentDirty;
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

    state.undoStack.push({
        content: cloneContent(state.content),
        operation: state.lastOperation,
        timestamp: state.lastOperationAt,
    });
    state.lastOperation = operation;
    state.lastOperationAt = Date.now();
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
    state.redoStack.push({
        content: cloneContent(state.content),
        operation: state.lastOperation,
        timestamp: state.lastOperationAt,
    });
    state.content = entry.content;
    state.lastOperation = entry.operation;
    state.lastOperationAt = entry.timestamp;
    render();
    restoreSavedSelection();
    handleSelectionChange();
    updateHistoryButtons();
    queueSave();
}

function redo() {
    if (state.redoStack.length === 0) {
        return;
    }

    const entry = state.redoStack.pop();
    state.undoStack.push({
        content: cloneContent(state.content),
        operation: state.lastOperation,
        timestamp: state.lastOperationAt,
    });
    state.content = entry.content;
    state.lastOperation = entry.operation;
    state.lastOperationAt = entry.timestamp;
    render();
    restoreSavedSelection();
    handleSelectionChange();
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
}

function getHistoryEntries() {
    return [
        ...state.undoStack.map((entry, index) => ({
            ...entry,
            kind: "undo",
            historyOrder: index,
        })),
        {
            content: state.content,
            operation: state.lastOperation,
            timestamp: state.lastOperationAt,
            kind: "current",
            historyOrder: state.undoStack.length,
        },
        ...[...state.redoStack].reverse().map((entry, index) => ({
            ...entry,
            kind: "redo",
            historyOrder: state.undoStack.length + index + 1,
        })),
    ];
}

function contentPreview(content) {
    const text = (content.blocks ?? [])
        .map((block) => block.text.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(" / ");
    return text ? text.slice(0, 120) : "Empty document";
}

function formatHistoryTime(timestamp) {
    return new Date(timestamp || Date.now()).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatHistoryStatus(entry) {
    const time = formatHistoryTime(entry.timestamp);
    return entry.kind === "current" ? `${time} · Active` : time;
}

function restoreHistorySnapshot(target) {
    if (!target || target.historyOrder === state.undoStack.length) return;

    while (state.undoStack.length > target.historyOrder) {
        undo();
    }
    while (state.undoStack.length < target.historyOrder && state.redoStack.length > 0) {
        redo();
    }
}

function cloneContent(content) {
    return JSON.parse(JSON.stringify(content));
}

function sameContent(left, right) {
    return JSON.stringify(canonicalizeContent(left)) === JSON.stringify(canonicalizeContent(right));
}

function canonicalizeContent(content) {
    const normalized = cloneContent(content);
    for (const block of normalized.blocks ?? []) {
        if (!block.align) delete block.align;
        if (!block.marks?.length) delete block.marks;
        if (!block.links?.length) delete block.links;
        if (!block.references?.length) delete block.references;
        if (!block.references?.length) delete block.references;
    }
    return normalized;
}

async function renameDocument() {
    const title = documentTitle.value.trim();
    if (!title || title === state.title) {
        documentTitle.value = state.title;
        return;
    }

    setSaveState("Renaming", "saving");
    try {
        const renamed = await renameDocumentRequest(state.documentId, { title, revision: state.revision });
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
    fileSaveButton.disabled = state.saveInFlight || !state.contentDirty;
    fileSaveButton.classList.toggle("has-changes", state.contentDirty);
    if (state.content) {
        revisionLabel.textContent = `Revision ${state.revision}`;
    }
}