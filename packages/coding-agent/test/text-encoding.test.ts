import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/index.ts";
import { decodeTextBuffer } from "../src/utils/text-encoding.ts";

// Raw GBK bytes for "中文测试" (中=D6D0 文=CEC4 测=B2E2 试=CAD4).
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("decodeTextBuffer", () => {
	it("decodes plain ASCII", () => {
		expect(decodeTextBuffer(Buffer.from("hello world", "utf-8"))).toBe("hello world");
	});

	it("decodes UTF-8 (including CJK and emoji)", () => {
		expect(decodeTextBuffer(Buffer.from("中文测试 café 😀", "utf-8"))).toBe("中文测试 café 😀");
	});

	it("strips a UTF-8 BOM", () => {
		const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文", "utf-8")]);
		expect(decodeTextBuffer(buf)).toBe("中文");
	});

	it("decodes UTF-16 LE with BOM", () => {
		const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文", "utf-16le")]);
		expect(decodeTextBuffer(buf)).toBe("中文");
	});

	it("decodes UTF-16 BE with BOM", () => {
		// 中 = U+4E2D, 文 = U+6587 in big-endian byte order.
		const buf = Buffer.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]);
		expect(decodeTextBuffer(buf)).toBe("中文");
	});

	it("falls back to GBK when bytes are not valid UTF-8", () => {
		expect(decodeTextBuffer(GBK_ZHONGWEN)).toBe("中文测试");
	});

	it("returns an empty string for an empty buffer", () => {
		expect(decodeTextBuffer(Buffer.alloc(0))).toBe("");
	});
});

describe("read tool with legacy encodings", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-encoding-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("reads a GBK-encoded file as readable Chinese, not mojibake", async () => {
		const file = join(testDir, "gbk.txt");
		writeFileSync(file, GBK_ZHONGWEN);

		const readTool = createReadTool(testDir);
		const result = (await readTool.execute("test-gbk", { path: file })) as {
			content: Array<{ type: string; text?: string }>;
		};

		const output = getText(result);
		expect(output).toContain("中文测试");
		expect(output).not.toContain("�"); // no replacement characters
	});

	it("reads a UTF-8 file with a BOM without leaking the BOM character", async () => {
		const file = join(testDir, "bom.txt");
		writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("你好\nworld", "utf-8")]));

		const readTool = createReadTool(testDir);
		const result = (await readTool.execute("test-bom", { path: file })) as {
			content: Array<{ type: string; text?: string }>;
		};

		const output = getText(result);
		expect(output).toContain("你好");
		expect(output).not.toContain("﻿");
	});
});
