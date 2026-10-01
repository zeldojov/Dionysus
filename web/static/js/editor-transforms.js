(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.EditorTransforms = factory();
    }
}(typeof globalThis === "object" ? globalThis : this, () => {
    function cloneRanges(ranges) {
        return (ranges ?? []).map((range) => ({ ...range }));
    }

    function normalizeRanges(ranges, identity = (range) => JSON.stringify(range)) {
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

    function removeMetadataRanges(ranges, start, end, removeLength) {
        return (ranges ?? []).flatMap((range) => {
            if (range.end <= start) {
                return [range];
            }
            if (range.start >= end) {
                return [{ ...range, start: range.start - removeLength, end: range.end - removeLength }];
            }

            const adjusted = {
                ...range,
                start: range.start < start ? range.start : start,
                end: range.end > end ? range.end - removeLength : start,
            };
            return adjusted.start < adjusted.end ? [adjusted] : [];
        });
    }

    function removeMetadataRange(block, start, end) {
        const removeLength = end - start;
        block.marks = removeMetadataRanges(block.marks, start, end, removeLength);
        block.links = removeMetadataRanges(block.links, start, end, removeLength);
        block.references = removeMetadataRanges(block.references, start, end, removeLength);
    }

    function normalizeBlockWhitespace(block, cursorOffset = null) {
        const leadingLength = block.text.length - block.text.trimStart().length;
        if (leadingLength > 0) {
            removeMetadataRange(block, 0, leadingLength);
        }

        const textAfterLeading = block.text.slice(leadingLength);
        const trailingLength = textAfterLeading.length - textAfterLeading.trimEnd().length;
        if (trailingLength > 0) {
            removeMetadataRange(block, block.text.length - trailingLength, block.text.length);
        }

        if (leadingLength > 0 || trailingLength > 0) {
            block.text = textAfterLeading.slice(0, textAfterLeading.length - trailingLength);
        }

        if (cursorOffset === null) {
            return null;
        }
        return Math.max(0, Math.min(block.text.length, cursorOffset - leadingLength));
    }

    function splitRanges(ranges, start, end) {
        const before = [];
        const after = [];
        for (const range of ranges ?? []) {
            if (range.start < start) {
                before.push({ ...range, end: Math.min(range.end, start) });
            }
            if (range.end > end) {
                after.push({ ...range, start: Math.max(range.start, end) - end, end: range.end - end });
            }
        }
        return [normalizeRanges(before), normalizeRanges(after)];
    }

    function mergeMetadataRanges(previousRanges, nextRanges, offset) {
        return normalizeRanges([
            ...(previousRanges ?? []),
            ...(nextRanges ?? []).map((range) => ({
                ...range,
                start: range.start + offset,
                end: range.end + offset,
            })),
        ], (range) => range.style ?? `${range.documentId}:${range.blockId}`);
    }

    return { mergeMetadataRanges, normalizeBlockWhitespace, removeMetadataRange, splitRanges };
}));
