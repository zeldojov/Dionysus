class DParagraphElement extends HTMLElement {
    constructor() {
        super();

        this.block = null;
    }

    connectedCallback() {
        this.classList.add("paragraph");
        this.tabIndex = 0;
    }

    get blockId() {
        return this.dataset.blockId ?? null;
    }

    set blockId(value) {
        if (!value) {
            delete this.dataset.blockId;
            this.removeAttribute("id");
            return;
        }

        this.dataset.blockId = value;
        this.id = `block-${value}`;
    }


    render(block) {
        if (block) {
            this.block = block;
            this.blockId = block.id;
            this.style.textAlign = block.align || "left";
            this.classList.toggle("paragraph-justify", block.align === "justify");
        }

        block = this.block;
        if (!block) {
            return;
        }

        this.replaceChildren();
        const boundaries = new Set([0, block.text.length]);
        for (const range of [...(block.marks ?? []), ...(block.links ?? []), ...(block.references ?? [])]) {
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
                const element = document.createElement(this.markElement(mark.style));
                element.append(node);
                node = element;
            }
            if (link) {
                const linkElement = document.createElement("d-link");
                linkElement.setAttribute("href", link.url);
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
            this.append(node);
        }
    }

    markElement(style) {
        const elementName = {
            bold: "d-bold",
            italic: "d-italic",
            underline: "d-underline",
            strike: "d-strike",
            highlight: "d-highlight",
            color: "d-color",
            subscript: "d-subscript",
            superscript: "d-superscript",
        }[style];
        if (!elementName) {
            throw new Error(`Unsupported paragraph mark style: ${style}`);
        }
        return elementName;
    }

    notifyBlockChange(reason, detail = {}) {
        this.dispatchEvent(new CustomEvent("block-change", {
            bubbles: true,
            detail: { block: this.block, reason, ...detail },
        }));
    }

    syncContentFromDOM() {
        if (!this.block) {
            return { textChanged: false };
        }

        const text = this.textContent.replace(/[\r\n]/g, "");
        const metadata = this.readInlineMetadata();
        const textChanged = this.block.text !== text;
        this.block.text = text;
        this.block.marks = metadata.marks;
        this.block.links = metadata.links;
        this.block.references = metadata.references;
        this.notifyBlockChange("content");
        return { textChanged };
    }

    toggleMark(style, start, end) {
        if (!this.block || start >= end) {
            return false;
        }

        const marks = this.block.marks ?? [];
        const active = marks.some((mark) => mark.style === style && mark.start <= start && mark.end >= end);
        const sameStyle = marks.filter((mark) => mark.style === style);
        const otherStyles = marks.filter((mark) => mark.style !== style);
        this.block.marks = [...otherStyles, ...this.removeRanges(sameStyle, start, end)];
        if (!active) {
            this.block.marks.push({ start, end, style });
        }
        this.notifyBlockChange("marks");
        return !active;
    }

    clearMarks(start, end) {
        if (!this.block || start >= end) {
            return false;
        }

        this.block.marks = this.removeRanges(this.block.marks ?? [], start, end);
        this.notifyBlockChange("marks");
        return true;
    }

    addLink(start, end, url) {
        if (!this.block || start >= end) {
            return false;
        }

        this.block.links = [
            ...(this.block.links ?? []),
            { start, end, url },
        ];
        this.notifyBlockChange("link");
        return true;
    }

    addReference(start, end, documentId, blockId) {
        if (!this.block || start >= end) {
            return false;
        }

        this.block.references = [
            ...(this.block.references ?? []),
            { start, end, documentId, blockId },
        ];
        this.notifyBlockChange("reference");
        return true;
    }

    removeLink(start, end) {
        if (!this.block || start > end) {
            return false;
        }

        const ranges = this.block.links ?? [];
        const selected = ranges.find((range) => range.start >= start && range.end <= end);
        if (!selected) {
            return false;
        }

        this.block.links = this.removeRanges(ranges, start, end);
        this.notifyBlockChange("link");
        return true;
    }

    removeReference(start, end) {
        if (!this.block || start > end) {
            return false;
        }

        const references = this.block.references ?? [];
        const selected = references.find((reference) => reference.start >= start && reference.start <= end);
        if (!selected) {
            return false;
        }

        this.block.references = references.filter((reference) => reference !== selected);
        this.notifyBlockChange("reference");
        return true;
    }

    readInlineMetadata() {
        const marks = [];
        const links = [];
        const references = [];
        let offset = 0;
        const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode();
        while (textNode) {
            const length = textNode.textContent.length;
            const start = offset;
            const end = offset + length;
            let markElement = textNode.parentElement;
            while (markElement && markElement !== this) {
                const style = {
                    STRONG: "bold", B: "bold", EM: "italic", I: "italic", U: "underline",
                    S: "strike", STRIKE: "strike", DEL: "strike",
                    SUB: "subscript", SUP: "superscript",
                    "D-BOLD": "bold", "D-ITALIC": "italic", "D-UNDERLINE": "underline",
                    "D-STRIKE": "strike", "D-HIGHLIGHT": "highlight", "D-COLOR": "color",
                    "D-SUBSCRIPT": "subscript", "D-SUPERSCRIPT": "superscript",
                }[markElement.tagName];
                if (style) marks.push({ start, end, style });
                if (markElement.style.backgroundColor) marks.push({ start, end, style: "highlight" });
                markElement = markElement.parentElement;
            }
            const linkElement = textNode.parentElement.closest("d-link");
            if (linkElement) {
                const url = linkElement.getAttribute("href");
                if (url) links.push({ start, end, url });
            }
            const referenceElement = textNode.parentElement.closest("d-reference");
            if (referenceElement?.dataset.documentId && referenceElement?.dataset.blockId) {
                references.push({
                    start,
                    end,
                    documentId: referenceElement.dataset.documentId,
                    blockId: referenceElement.dataset.blockId,
                });
            }
            offset = end;
            textNode = walker.nextNode();
        }
        return {
            marks: this.mergeRanges(marks),
            links: this.mergeRanges(links),
            references: this.mergeRanges(references),
        };
    }

    mergeRanges(ranges) {
        return ranges.filter((range, index, values) => index === values.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(range)));
    }

    removeRanges(ranges, start, end) {
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

    remapRanges(ranges, start, end, replacementLength) {
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

    setAlignment(alignment) {
        if (!this.block || (this.block.align || "left") === alignment) {
            return false;
        }

        if (alignment === "left") {
            delete this.block.align;
        } else {
            this.block.align = alignment;
        }
        this.style.textAlign = alignment;
        this.classList.toggle("paragraph-justify", alignment === "justify");
        this.notifyBlockChange("alignment", { alignment });
        return true;
    }

    setText(text) {
        const value = text.replace(/[\r\n]/g, "");
        if (!this.block || this.block.text === value) {
            return false;
        }

        this.block.text = value;
        this.notifyBlockChange("text");
        return true;
    }

    transformText(start, end, transform) {
        if (!this.block || start >= end) {
            return null;
        }

        const selectedText = this.block.text.slice(start, end);
        const transformedText = transform(selectedText);
        if (transformedText === selectedText) {
            return { changed: false, end };
        }

        this.block.text = this.block.text.slice(0, start) + transformedText + this.block.text.slice(end);
        if (transformedText.length !== end - start) {
            this.block.marks = this.remapRanges(this.block.marks, start, end, transformedText.length);
            this.block.links = this.remapRanges(this.block.links, start, end, transformedText.length);
            this.block.references = this.remapRanges(this.block.references, start, end, transformedText.length);
        }
        this.notifyBlockChange("text");
        return { changed: true, end: start + transformedText.length };
    }

    setActive(active) {
        this.classList.toggle("is-active", Boolean(active));
    }

    setEditing(editing) {
        const value = Boolean(editing);
        this.contentEditable = String(value);
        this.setAttribute("aria-readonly", String(!value));
    }

    focusAt(offset = this.textContent.length) {
        this.focus();

        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(this);
        range.collapse(true);

        const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
        let remaining = Math.max(0, offset);
        let textNode = walker.nextNode();

        while (textNode) {
            if (remaining <= textNode.textContent.length) {
                range.setStart(textNode, remaining);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }

            remaining -= textNode.textContent.length;
            textNode = walker.nextNode();
        }

        range.selectNodeContents(this);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }
}

customElements.define("d-paragraph", DParagraphElement);
