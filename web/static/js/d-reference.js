const { loadDocument: referenceLoadDocument } = window.EditorAPI;
const referencePreview = document.querySelector("#reference-preview");
const referencePreviewText = document.querySelector("#reference-preview-text");
const referencePreviewLink = document.querySelector("#reference-preview-link");
let referencePreviewTimer = null;
let activeReference = null;
const referencePreviewCache = new Map();

class DReferenceElement extends HTMLElement {
    connectedCallback() {
        this.contentEditable = "true";
        this.addEventListener("mouseenter", this.handleShowPreview);
        this.addEventListener("mouseleave", this.handleHidePreview);
        this.addEventListener("focus", this.handleShowPreview);
        this.addEventListener("blur", this.handleHidePreview);
    }

    disconnectedCallback() {
        this.removeEventListener("mouseenter", this.handleShowPreview);
        this.removeEventListener("mouseleave", this.handleHidePreview);
        this.removeEventListener("focus", this.handleShowPreview);
        this.removeEventListener("blur", this.handleHidePreview);
    }

    handleShowPreview = () => {
        window.clearTimeout(referencePreviewTimer);
        activeReference = this;
        referencePreviewText.textContent = "Loading...";
        referencePreview.hidden = false;
        this.positionPreview();

        const target = this.getTarget();
        if (!target) return;
        referencePreviewLink.href = this.getTargetHref(target);
        const cacheKey = `${target.documentId}:${target.blockId}`;
        if (referencePreviewCache.has(cacheKey)) {
            referencePreviewText.textContent = referencePreviewCache.get(cacheKey);
            this.positionPreview();
            return;
        }

        referenceLoadDocument(target.documentId).then((documentState) => {
            const block = documentState.content.blocks.find((candidate) => candidate.id === target.blockId);
            const text = block?.text || "Empty paragraph";
            referencePreviewCache.set(cacheKey, text);
            if (activeReference === this) {
                referencePreviewText.textContent = text;
                this.positionPreview();
            }
        }).catch(() => {
            if (activeReference === this) referencePreviewText.textContent = "Unable to load paragraph";
        });
    };

    handleHidePreview = () => {
        window.clearTimeout(referencePreviewTimer);
        referencePreviewTimer = window.setTimeout(() => {
            activeReference = null;
            referencePreview.hidden = true;
        }, 140);
    };

    getTarget() {
        return {
            documentId: this.dataset.documentId,
            blockId: this.dataset.blockId,
        };
    }

    getTargetHref(target) {
        return `/documents/${encodeURIComponent(target.documentId)}#block-${encodeURIComponent(target.blockId)}`;
    }

    positionPreview() {
        const bounds = this.getBoundingClientRect();
        const width = Math.min(360, window.innerWidth - 24);
        const left = Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12));
        const belowTop = bounds.bottom + 10;
        const top = belowTop + referencePreview.offsetHeight <= window.innerHeight - 12
            ? belowTop
            : Math.max(12, bounds.top - referencePreview.offsetHeight - 10);
        referencePreview.style.left = `${left}px`;
        referencePreview.style.top = `${top}px`;
        referencePreview.style.width = `${width}px`;
    }
}

referencePreview.addEventListener("mouseenter", () => window.clearTimeout(referencePreviewTimer));
referencePreview.addEventListener("mouseleave", () => {
    window.clearTimeout(referencePreviewTimer);
    referencePreviewTimer = window.setTimeout(() => {
        activeReference = null;
        referencePreview.hidden = true;
    }, 140);
});

customElements.define("d-reference", DReferenceElement);
