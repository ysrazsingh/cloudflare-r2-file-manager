const assert = require("node:assert/strict");
const { before, after, test, mock } = require("node:test");
const http = require("node:http");
const express = require("express");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

let server;
let baseUrl;

before(async () => {
    // Suppress automatic startup only while importing the app for these tests.
    const startupListen = mock.method(express.application, "listen", () => {});
    let app;
    try {
        app = require("../index");
    } finally {
        startupListen.mock.restore();
    }
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function getPage(query = {}) {
    const response = await fetch(`${baseUrl}/list-files-paginated?${new URLSearchParams(query)}`);
    return { status: response.status, body: await response.json() };
}

test("retrieves more than 1000 files and resumes without missing or repeating keys", async (t) => {
    const expected = Array.from({ length: 2505 }, (_, i) => `uploads/file-${String(i).padStart(5, "0")}.json`);
    const calls = [];
    // Include reserved URL characters so the client must preserve the opaque token.
    const token = (offset) => `offset+/${offset}==`;
    t.mock.method(S3Client.prototype, "send", async (command) => {
        assert.ok(command instanceof ListObjectsV2Command);
        const input = command.input;
        assert.equal(input.Prefix, "uploads/");
        assert.equal(input.Delimiter, "/");
        calls.push(input);
        const offset = input.ContinuationToken ? Number(input.ContinuationToken.match(/\/(\d+)==$/)[1]) : 0;
        const keys = expected.slice(offset, offset + input.MaxKeys);
        const end = offset + keys.length;
        return {
            Contents: keys.map((Key) => ({ Key })),
            IsTruncated: end < expected.length,
            NextContinuationToken: end < expected.length ? token(end) : undefined
        };
    });

    const first = await getPage({ folder: "uploads", limit: "1500" });
    assert.equal(first.status, 200);
    assert.equal(first.body.count, 1500);
    assert.equal(first.body.hasMore, true);
    assert.equal(first.body.nextCursor, token(1500));
    assert.deepEqual(calls.map((input) => input.MaxKeys), [1000, 500]);

    const second = await getPage({ folder: "uploads", limit: "1500", cursor: first.body.nextCursor });
    assert.equal(second.status, 200);
    assert.equal(second.body.count, 1005);
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.nextCursor, null);
    assert.deepEqual([...first.body.files, ...second.body.files], expected);
    assert.equal(new Set([...first.body.files, ...second.body.files]).size, expected.length);
    assert.deepEqual(calls.map((input) => input.MaxKeys), [1000, 500, 1000, 500]);
});

test("defaults to 1000 entries at the bucket root and counts child folders", async (t) => {
    t.mock.method(S3Client.prototype, "send", async ({ input }) => {
        assert.equal(input.Prefix, "");
        assert.equal(input.MaxKeys, 1000);
        assert.equal(input.ContinuationToken, undefined);
        return {
            Contents: [{ Key: "root.json" }],
            CommonPrefixes: [{ Prefix: "images/" }],
            IsTruncated: false
        };
    });
    const { status, body } = await getPage();
    assert.equal(status, 200);
    assert.deepEqual(body, {
        files: ["root.json"], folders: ["images/"], count: 2, hasMore: false, nextCursor: null
    });
});

test("stops at the requested limit even when a page contains only folders", async (t) => {
    let calls = 0;
    t.mock.method(S3Client.prototype, "send", async ({ input }) => {
        calls++;
        assert.equal(input.Prefix, "uploads/");
        assert.equal(input.MaxKeys, 2);
        return {
            CommonPrefixes: [{ Prefix: "uploads/a/" }, { Prefix: "uploads/b/" }],
            IsTruncated: true,
            NextContinuationToken: "more-folders"
        };
    });
    const { status, body } = await getPage({ folder: "uploads/", limit: "2" });
    assert.equal(status, 200);
    assert.equal(body.count, 2);
    assert.deepEqual(body.files, []);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextCursor, "more-folders");
    assert.equal(calls, 1);
});

test("continues after an empty truncated page and handles an empty final page", async (t) => {
    let calls = 0;
    t.mock.method(S3Client.prototype, "send", async ({ input }) => {
        calls++;
        if (calls === 1) return { IsTruncated: true, NextContinuationToken: "next" };
        assert.equal(input.ContinuationToken, "next");
        return { IsTruncated: false };
    });
    const { status, body } = await getPage();
    assert.equal(status, 200);
    assert.deepEqual(body, { files: [], folders: [], count: 0, hasMore: false, nextCursor: null });
    assert.equal(calls, 2);
});

test("bounds a large response to 10000 entries", async (t) => {
    let calls = 0;
    t.mock.method(S3Client.prototype, "send", async ({ input }) => {
        assert.equal(input.MaxKeys, 1000);
        const offset = calls++ * 1000;
        return {
            Contents: Array.from({ length: 1000 }, (_, i) => ({ Key: `file-${offset + i}` })),
            IsTruncated: true,
            NextContinuationToken: `page-${calls}`
        };
    });
    const { status, body } = await getPage({ limit: "10000" });
    assert.equal(status, 200);
    assert.equal(calls, 10);
    assert.equal(body.count, 10000);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextCursor, "page-10");
});

test("rejects invalid and structured query parameters before calling R2", async (t) => {
    const send = t.mock.method(S3Client.prototype, "send", async () => {
        throw new Error("R2 must not be called");
    });
    const queries = [
        { limit: "0" }, { limit: "-1" }, { limit: "10001" }, { limit: "1.5" },
        { limit: "1e3" }, { limit: "abc" }, { limit: "" }, { "limit[]": "1000" },
        { "folder[]": "uploads" }, { "cursor[]": "token" }, { cursor: "" }
    ];
    for (const query of queries) {
        const { status, body } = await getPage(query);
        assert.equal(status, 400, JSON.stringify(query));
        assert.equal(typeof body.error, "string");
    }
    assert.equal(send.mock.callCount(), 0);
});

test("returns an error if a later R2 page fails instead of reporting partial success", async (t) => {
    let calls = 0;
    t.mock.method(S3Client.prototype, "send", async () => {
        if (++calls === 2) throw new Error("R2 unavailable");
        return { Contents: [{ Key: "file.json" }], IsTruncated: true, NextContinuationToken: "next" };
    });
    const { status, body } = await getPage({ limit: "1500" });
    assert.equal(status, 500);
    assert.deepEqual(body, { error: "R2 unavailable" });
});

test("fails if R2 reports more results without a usable next token", async (t) => {
    for (const nextToken of [undefined, "current"]) {
        const send = t.mock.method(S3Client.prototype, "send", async () => ({
            IsTruncated: true, NextContinuationToken: nextToken
        }));
        const { status, body } = await getPage({ cursor: "current" });
        assert.equal(status, 500);
        assert.match(body.error, /continuation token/);
        assert.equal(send.mock.callCount(), 1);
        send.mock.restore();
    }
});

test("preserves the original list-files response", async (t) => {
    t.mock.method(S3Client.prototype, "send", async () => ({
        Contents: [{ Key: "file.json" }],
        CommonPrefixes: [{ Prefix: "uploads/" }],
        IsTruncated: true,
        NextContinuationToken: "next"
    }));
    const response = await fetch(`${baseUrl}/list-files`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { files: ["file.json"], folders: ["uploads/"] });
});
