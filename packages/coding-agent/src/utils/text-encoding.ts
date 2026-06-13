/**
 * Decode a file's bytes into a string, tolerating the legacy encodings that are
 * still common on Windows (especially Chinese-locale systems) instead of assuming
 * UTF-8 unconditionally.
 *
 * Strategy:
 *  1. Honor a byte-order mark when present (UTF-8, UTF-16 LE/BE) — authoritative.
 *  2. Otherwise try strict UTF-8; valid UTF-8 (including plain ASCII) decodes here.
 *  3. If the bytes are not valid UTF-8, fall back to GBK — the dominant legacy
 *     Chinese encoding (GB2312/GBK/GB18030 superset) — which Node's built-in
 *     TextDecoder supports with no extra dependency. This turns the previous
 *     mojibake (`���Ĳ���`) back into readable text (`中文测试`).
 *
 * A UTF-8 BOM is stripped so it does not leak into the returned text as a stray
 * U+FEFF character.
 */
export function decodeTextBuffer(buffer: Buffer): string {
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return new TextDecoder("utf-8").decode(buffer.subarray(3));
	}
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return new TextDecoder("utf-16le").decode(buffer.subarray(2));
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		return new TextDecoder("utf-16be").decode(buffer.subarray(2));
	}

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		// Not valid UTF-8: best-effort decode as GBK. If the runtime lacks the GBK
		// decoder (Node built without full ICU), fall back to lossy UTF-8 so we never
		// throw on a readable file.
		try {
			return new TextDecoder("gbk").decode(buffer);
		} catch {
			return buffer.toString("utf-8");
		}
	}
}
