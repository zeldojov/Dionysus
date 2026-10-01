const assert = require("node:assert/strict");
const test = require("node:test");

const {
    mergeMetadataRanges,
    normalizeBlockWhitespace,
    removeMetadataRange,
    splitRanges,
} = require("../web/static/js/editor-transforms.js");

test("normalizeBlockWhitespace trims both edges and preserves inner metadata", () => {
    const block = {
        text: "  Alpha  ",
        marks: [{ start: 2, end: 7, style: "bold" }],
        links: [{ start: 0, end: 2, documentId: "doc", blockId: "link" }],
    };

    const cursorOffset = normalizeBlockWhitespace(block, 9);

    assert.equal(block.text, "Alpha");
    assert.deepEqual(block.marks, [{ start: 0, end: 5, style: "bold" }]);
    assert.deepEqual(block.links, []);
    assert.equal(cursorOffset, 5);
});

test("removeMetadataRange shifts later ranges and clips overlapping ranges", () => {
    const block = {
        text: "abcdefghij",
        marks: [
            { start: 0, end: 3, style: "bold" },
            { start: 2, end: 8, style: "italic" },
            { start: 8, end: 10, style: "underline" },
        ],
        links: [],
    };

    removeMetadataRange(block, 3, 6);

    assert.deepEqual(block.marks, [
        { start: 0, end: 3, style: "bold" },
        { start: 2, end: 5, style: "italic" },
        { start: 5, end: 7, style: "underline" },
    ]);
});

test("splitRanges divides metadata around the removed split boundary", () => {
    const [before, after] = splitRanges([
        { start: 0, end: 11, style: "bold" },
        { start: 6, end: 11, documentId: "doc", blockId: "link" },
    ], 6, 8);

    assert.deepEqual(before, [{ start: 0, end: 6, style: "bold" }]);
    assert.deepEqual(after, [
        { start: 0, end: 3, style: "bold" },
        { start: 0, end: 3, documentId: "doc", blockId: "link" },
    ]);
});

test("mergeMetadataRanges shifts the next block after the inserted separator", () => {
    const merged = mergeMetadataRanges(
        [{ start: 0, end: 5, style: "bold" }],
        [
            { start: 0, end: 4, style: "bold" },
            { start: 4, end: 8, documentId: "doc", blockId: "link" },
        ],
        6,
    );

    assert.deepEqual(merged, [
        { start: 0, end: 5, style: "bold" },
        { start: 6, end: 10, style: "bold" },
        { start: 10, end: 14, documentId: "doc", blockId: "link" },
    ]);
});
