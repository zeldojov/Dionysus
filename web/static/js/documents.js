const documentsList = document.querySelector("#documents-list");
const documentsStatus = document.querySelector("#documents-status");
const documentsSearch = document.querySelector("#documents-search");
const newDocumentButton = document.querySelector("#new-document");
let loadedDocuments = [];

document.addEventListener("DOMContentLoaded", loadDocuments);
newDocumentButton.addEventListener("click", createDocument);
documentsSearch.addEventListener("input", () => renderDocuments(loadedDocuments));

async function loadDocuments() {
    try {
        const response = await fetch("/documents", {
            headers: { Accept: "application/json" },
        });
        if (!response.ok) {
            throw new Error(`Load documents failed: ${response.status}`);
        }

        loadedDocuments = await response.json();
        renderDocuments(loadedDocuments);
    } catch (error) {
        console.error(error);
        documentsStatus.textContent = "Unable to load documents";
    }
}

async function createDocument() {
    newDocumentButton.disabled = true;
    try {
        const response = await fetch("/documents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Untitled document" }),
        });
        if (!response.ok) {
            throw new Error(`Create document failed: ${response.status}`);
        }

        const documentState = await response.json();
        localStorage.setItem("dionysus:lastDocumentSlug", documentState.slug);
        window.location.assign(`/documents/${encodeURIComponent(documentState.slug)}`);
    } catch (error) {
        console.error(error);
        newDocumentButton.disabled = false;
        documentsStatus.textContent = "Unable to create document";
    }
}

function renderDocuments(documents) {
    const query = normalizeSearchText(documentsSearch.value.trim());
    const visibleDocuments = query
        ? documents
            .map((documentState) => ({ documentState, score: scoreDocument(documentState, query) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score)
            .map((entry) => entry.documentState)
        : documents;

    documentsList.replaceChildren();
    documentsStatus.textContent = visibleDocuments.length === 0
        ? query ? "No matching documents" : "No documents yet"
        : query
            ? `${visibleDocuments.length} of ${documents.length} documents`
            : `${documents.length} document${documents.length === 1 ? "" : "s"}`;

    for (const documentState of visibleDocuments) {
        const card = document.createElement("article");
        card.className = "document-card";

        const link = document.createElement("a");
        link.className = "document-card-link";
        link.href = `/documents/${encodeURIComponent(documentState.slug)}`;

        const details = document.createElement("div");
        const title = document.createElement("h2");
        title.className = "document-card-title";
        title.textContent = documentState.title;
        const slug = document.createElement("div");
        slug.className = "document-card-slug";
        slug.textContent = documentState.slug;
        details.append(title, slug);

        const date = document.createElement("time");
        date.className = "document-card-date";
        date.dateTime = documentState.updatedAt;
        date.textContent = formatDate(documentState.updatedAt);
        link.append(details, date);

        const actions = document.createElement("div");
        actions.className = "document-card-actions";

        const renameButton = document.createElement("button");
        renameButton.className = "rename-document";
        renameButton.type = "button";
        renameButton.textContent = "Rename";
        renameButton.addEventListener("click", () => renameDocument(documentState, renameButton));

        const deleteButton = document.createElement("button");
        deleteButton.className = "delete-document";
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", () => deleteDocument(documentState, deleteButton));

        actions.append(renameButton, deleteButton);
        card.append(link, actions);
        documentsList.append(card);
    }
}

function normalizeSearchText(value) {
    return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fuzzyScore(value, query) {
    let queryIndex = 0;
    let gapScore = 0;
    for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
        if (value[valueIndex] === query[queryIndex]) {
            queryIndex += 1;
        } else if (queryIndex > 0) {
            gapScore += 1;
        }
    }
    return queryIndex === query.length ? 100 - gapScore : 0;
}

function scoreDocument(documentState, query) {
    const title = normalizeSearchText(documentState.title);
    const slug = normalizeSearchText(documentState.slug);
    const titleScore = title === query
        ? 1000
        : title.startsWith(query)
            ? 800 - title.indexOf(query)
            : title.includes(query)
                ? 600 - title.indexOf(query)
                : fuzzyScore(title, query) * 3;
    const slugScore = slug === query
        ? 200
        : slug.startsWith(query)
            ? 140
            : slug.includes(query)
                ? 100
                : fuzzyScore(slug, query);
    return Math.max(titleScore, slugScore);
}

async function renameDocument(documentState, button) {
    const title = window.prompt("Document title", documentState.title);
    if (title === null || title.trim() === documentState.title) {
        return;
    }

    button.disabled = true;
    try {
        const response = await fetch(`/documents/${encodeURIComponent(documentState.slug)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, revision: documentState.revision }),
        });
        if (!response.ok) {
            throw new Error(`Rename document failed: ${response.status}`);
        }
        await loadDocuments();
    } catch (error) {
        console.error(error);
        button.disabled = false;
        documentsStatus.textContent = "Unable to rename document";
    }
}

async function deleteDocument(documentState, button) {
    if (!window.confirm(`Delete "${documentState.title}"?`)) {
        return;
    }

    button.disabled = true;
    try {
        const response = await fetch(
            `/documents/${encodeURIComponent(documentState.slug)}?revision=${documentState.revision}`,
            { method: "DELETE" },
        );
        if (!response.ok) {
            throw new Error(`Delete document failed: ${response.status}`);
        }
        await loadDocuments();
    } catch (error) {
        console.error(error);
        button.disabled = false;
        documentsStatus.textContent = "Unable to delete document";
    }
}

function formatDate(value) {
    return new Intl.DateTimeFormat("sr-Latn-RS", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}