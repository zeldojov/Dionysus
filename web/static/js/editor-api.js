(() => {
    async function requestJSON(url, options = {}, operation = "Request") {
        const response = await fetch(url, options);
        if (!response.ok) {
            const error = new Error(`${operation} failed: ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response.json();
    }

    function jsonOptions(method, body) {
        return {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        };
    }

    function createDocument(title = "Untitled document") {
        return requestJSON(
            "/documents",
            jsonOptions("POST", { title }),
            "Create document",
        );
    }

    function loadDocument(identifier) {
        return requestJSON(
            `/documents/${encodeURIComponent(identifier)}`,
            {},
            "Load document",
        );
    }

    function updateBlocks(identifier, payload) {
        return requestJSON(
            `/documents/${encodeURIComponent(identifier)}/blocks`,
            jsonOptions("PATCH", payload),
            "Save document",
        );
    }

    function renameDocument(identifier, payload) {
        return requestJSON(
            `/documents/${encodeURIComponent(identifier)}`,
            jsonOptions("PATCH", payload),
            "Rename document",
        );
    }

    function loadIncomingReferences(identifier, blockID) {
        return requestJSON(
            `/documents/${encodeURIComponent(identifier)}/blocks/${encodeURIComponent(blockID)}/incoming-references`,
            {},
            "Load incoming references",
        );
    }

    async function removeIncomingReference(identifier, blockID, referenceID) {
        const response = await fetch(
            `/documents/${encodeURIComponent(identifier)}/blocks/${encodeURIComponent(blockID)}/incoming-references/${encodeURIComponent(referenceID)}`,
            { method: "DELETE" },
        );
        if (!response.ok) {
            const error = new Error(`Remove incoming reference failed: ${response.status}`);
            error.status = response.status;
            throw error;
        }
    }

    window.EditorAPI = {
        createDocument,
        loadDocument,
        loadIncomingReferences,
        renameDocument,
        removeIncomingReference,
        updateBlocks,
    };
})();
