/**
 * Decision-matrix spec for shell resolution (Windows PowerShell support).
 *
 * These tests pin the CONTRACT for `resolveShellConfig`, the pure core of shell
 * selection. They run deterministically on any OS (incl. ubuntu CI) by injecting
 * a fake `ShellProbeEnv` instead of touching the real filesystem/PATH.
 *
 * STATUS: RED until Phase 1 implements `resolveShellConfig`. The stub throws
 * "not implemented", so every case below fails by design — that is the target
 * spec the implementation must satisfy.
 *
 * Decisions encoded here:
 * - shellType "auto" (default): Windows = PowerShell-first with graceful bash
 *   fallback; Unix = bash (PowerShell is never auto-preferred on Unix).
 * - PowerShell discovery: pwsh (7+) first, then powershell (5.1).
 * - Invocation args: bash -> ["-c"]; powershell -> ["-NoProfile","-NonInteractive","-EncodedCommand"].
 * - Explicit shellPath: kind inferred from the binary name (pwsh/powershell ->
 *   powershell, else bash); shellType is ignored when shellPath is explicit.
 */

import { describe, expect, it } from "vitest";
import {
	BASH_INVOCATION_ARGS,
	buildSpawnArgs,
	getShellConfig,
	POWERSHELL_INVOCATION_ARGS,
	POWERSHELL_UTF8_PREAMBLE,
	type ResolveShellOptions,
	resolveShellConfig,
	resolveShellKind,
	type ShellProbeEnv,
} from "../src/utils/shell.ts";

const BASH_ARGS = BASH_INVOCATION_ARGS;
const PS_ARGS = POWERSHELL_INVOCATION_ARGS;

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const GIT_BASH_X86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";

/**
 * Build a ShellProbeEnv. By default NOTHING exists and NOTHING is on PATH;
 * each test opts in to the executables/paths it wants present.
 */
function makeEnv(
	overrides: {
		platform?: NodeJS.Platform;
		existingPaths?: string[];
		onPath?: Record<string, string>;
		programFiles?: string | undefined;
		programFilesX86?: string | undefined;
	} = {},
): ShellProbeEnv {
	const existing = new Set(overrides.existingPaths ?? []);
	const onPath = overrides.onPath ?? {};
	return {
		platform: overrides.platform ?? "linux",
		fileExists: (p) => existing.has(p),
		findExecutableOnPath: (exe) => onPath[exe] ?? null,
		programFiles: "programFiles" in overrides ? overrides.programFiles : "C:\\Program Files",
		programFilesX86: "programFilesX86" in overrides ? overrides.programFilesX86 : "C:\\Program Files (x86)",
	};
}

function resolve(options: ResolveShellOptions, env: ShellProbeEnv) {
	return resolveShellConfig(options, env);
}

// =====================================================================
// Group A — explicit shellPath (kind inferred from binary name)
// =====================================================================
describe("resolveShellConfig: explicit shellPath", () => {
	it("A1: existing bash path -> bash kind, -c args", () => {
		const env = makeEnv({ platform: "win32", existingPaths: ["C:\\msys64\\usr\\bin\\bash.exe"] });
		const cfg = resolve({ shellPath: "C:\\msys64\\usr\\bin\\bash.exe" }, env);
		expect(cfg).toEqual({ shell: "C:\\msys64\\usr\\bin\\bash.exe", args: BASH_ARGS, kind: "bash" });
	});

	it("A2: existing pwsh path -> powershell kind, PowerShell args", () => {
		const env = makeEnv({ platform: "win32", existingPaths: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] });
		const cfg = resolve({ shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }, env);
		expect(cfg).toEqual({
			shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			args: PS_ARGS,
			kind: "powershell",
		});
	});

	it("A3: existing powershell.exe path -> powershell kind", () => {
		const p = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		const env = makeEnv({ platform: "win32", existingPaths: [p] });
		expect(resolve({ shellPath: p }, env).kind).toBe("powershell");
	});

	it("A4: non-existent shellPath -> throws not found", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [] });
		expect(() => resolve({ shellPath: "C:\\nope\\bash.exe" }, env)).toThrow(/not found/i);
	});

	it("A5: kind inference is case-insensitive and basename-based", () => {
		const p = "C:\\Tools\\PWSH.EXE";
		const env = makeEnv({ platform: "win32", existingPaths: [p] });
		expect(resolve({ shellPath: p }, env).kind).toBe("powershell");
	});

	it("A6: explicit shellPath wins over shellType (shellType ignored)", () => {
		const p = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const env = makeEnv({ platform: "win32", existingPaths: [p] });
		// User asked for bash type but pointed shellPath at pwsh -> path's inferred kind wins.
		expect(resolve({ shellPath: p, shellType: "bash" }, env).kind).toBe("powershell");
	});
});

// =====================================================================
// Group B — shellType: "powershell" (explicit), no shellPath
// =====================================================================
describe("resolveShellConfig: shellType=powershell", () => {
	it("B1: pwsh on PATH -> uses pwsh, PowerShell args", () => {
		const env = makeEnv({ platform: "win32", onPath: { pwsh: "C:\\pf\\pwsh.exe", powershell: "C:\\ps.exe" } });
		const cfg = resolve({ shellType: "powershell" }, env);
		expect(cfg).toEqual({ shell: "C:\\pf\\pwsh.exe", args: PS_ARGS, kind: "powershell" });
	});

	it("B2: no pwsh, powershell present -> uses powershell.exe", () => {
		const env = makeEnv({ platform: "win32", onPath: { powershell: "C:\\Windows\\...\\powershell.exe" } });
		const cfg = resolve({ shellType: "powershell" }, env);
		expect(cfg).toEqual({ shell: "C:\\Windows\\...\\powershell.exe", args: PS_ARGS, kind: "powershell" });
	});

	it("B3: neither pwsh nor powershell -> throws PowerShell-not-found", () => {
		const env = makeEnv({ platform: "win32", onPath: {} });
		expect(() => resolve({ shellType: "powershell" }, env)).toThrow(/powershell/i);
	});

	it("B4: honored on non-Windows too (pwsh on PATH on linux)", () => {
		const env = makeEnv({ platform: "linux", onPath: { pwsh: "/usr/bin/pwsh" } });
		const cfg = resolve({ shellType: "powershell" }, env);
		expect(cfg).toEqual({ shell: "/usr/bin/pwsh", args: PS_ARGS, kind: "powershell" });
	});
});

// =====================================================================
// Group C — shellType: "bash" (explicit), no shellPath
// =====================================================================
describe("resolveShellConfig: shellType=bash", () => {
	it("C1: win32 Git Bash in ProgramFiles -> uses it, -c args", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [GIT_BASH] });
		const cfg = resolve({ shellType: "bash" }, env);
		expect(cfg).toEqual({ shell: GIT_BASH, args: BASH_ARGS, kind: "bash" });
	});

	it("C2: win32 Git Bash in ProgramFiles(x86) when 64-bit absent", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [GIT_BASH_X86] });
		expect(resolve({ shellType: "bash" }, env).shell).toBe(GIT_BASH_X86);
	});

	it("C3: win32 no Git Bash, bash on PATH -> uses PATH bash", () => {
		const env = makeEnv({ platform: "win32", onPath: { "bash.exe": "C:\\cygwin64\\bin\\bash.exe" } });
		const cfg = resolve({ shellType: "bash" }, env);
		expect(cfg).toEqual({ shell: "C:\\cygwin64\\bin\\bash.exe", args: BASH_ARGS, kind: "bash" });
	});

	it("C4: win32 no bash anywhere -> throws bash-not-found", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [], onPath: {} });
		expect(() => resolve({ shellType: "bash" }, env)).toThrow(/bash/i);
	});

	it("C5: unix /bin/bash exists -> uses /bin/bash", () => {
		const env = makeEnv({ platform: "linux", existingPaths: ["/bin/bash"] });
		const cfg = resolve({ shellType: "bash" }, env);
		expect(cfg).toEqual({ shell: "/bin/bash", args: BASH_ARGS, kind: "bash" });
	});

	it("C6: unix no /bin/bash, bash on PATH -> uses PATH bash", () => {
		const env = makeEnv({ platform: "linux", onPath: { bash: "/usr/local/bin/bash" } });
		expect(resolve({ shellType: "bash" }, env).shell).toBe("/usr/local/bin/bash");
	});

	it("C7: unix nothing -> falls back to sh, bash kind", () => {
		const env = makeEnv({ platform: "linux", existingPaths: [], onPath: {} });
		const cfg = resolve({ shellType: "bash" }, env);
		expect(cfg).toEqual({ shell: "sh", args: BASH_ARGS, kind: "bash" });
	});
});

// =====================================================================
// Group D — shellType: "auto" (default) on Windows: PowerShell-first
// =====================================================================
describe("resolveShellConfig: auto on Windows (PowerShell-first)", () => {
	it("D1: pwsh present -> PowerShell preferred even when bash also exists", () => {
		const env = makeEnv({
			platform: "win32",
			existingPaths: [GIT_BASH],
			onPath: { pwsh: "C:\\pf\\pwsh.exe", "bash.exe": "C:\\g\\bash.exe" },
		});
		const cfg = resolve({ shellType: "auto" }, env);
		expect(cfg).toEqual({ shell: "C:\\pf\\pwsh.exe", args: PS_ARGS, kind: "powershell" });
	});

	it("D2: no pwsh, powershell present -> powershell.exe", () => {
		const env = makeEnv({ platform: "win32", onPath: { powershell: "C:\\ps.exe" } });
		expect(resolve({ shellType: "auto" }, env).kind).toBe("powershell");
	});

	it("D3: no PowerShell, Git Bash present -> graceful bash fallback (no throw)", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [GIT_BASH], onPath: {} });
		const cfg = resolve({ shellType: "auto" }, env);
		expect(cfg).toEqual({ shell: GIT_BASH, args: BASH_ARGS, kind: "bash" });
	});

	it("D4: neither PowerShell nor bash -> throws", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [], onPath: {} });
		expect(() => resolve({ shellType: "auto" }, env)).toThrow();
	});

	it("D5: options omitted (undefined shellType) behaves like auto -> PowerShell-first", () => {
		const env = makeEnv({ platform: "win32", onPath: { pwsh: "C:\\pf\\pwsh.exe" } });
		expect(resolve({}, env).kind).toBe("powershell");
	});
});

// =====================================================================
// Group E — shellType: "auto" on Unix: bash always (never auto-prefers PS)
// =====================================================================
describe("resolveShellConfig: auto on Unix (bash)", () => {
	it("E1: linux /bin/bash -> bash, even when pwsh is installed", () => {
		const env = makeEnv({ platform: "linux", existingPaths: ["/bin/bash"], onPath: { pwsh: "/usr/bin/pwsh" } });
		const cfg = resolve({ shellType: "auto" }, env);
		expect(cfg).toEqual({ shell: "/bin/bash", args: BASH_ARGS, kind: "bash" });
	});

	it("E2: darwin bash on PATH -> bash", () => {
		const env = makeEnv({ platform: "darwin", onPath: { bash: "/opt/homebrew/bin/bash" } });
		expect(resolve({ shellType: "auto" }, env).shell).toBe("/opt/homebrew/bin/bash");
	});

	it("E3: linux nothing -> sh fallback, bash kind", () => {
		const env = makeEnv({ platform: "linux", existingPaths: [], onPath: {} });
		expect(resolve({ shellType: "auto" }, env)).toEqual({ shell: "sh", args: BASH_ARGS, kind: "bash" });
	});
});

// =====================================================================
// Group F — invocation args are flavor-correct (guards the -c vs -Command bug)
// =====================================================================
describe("resolveShellConfig: invocation args by flavor", () => {
	it("F1: bash flavor uses exactly -c", () => {
		const env = makeEnv({ platform: "linux", existingPaths: ["/bin/bash"] });
		expect(resolve({ shellType: "bash" }, env).args).toEqual(["-c"]);
	});

	it("F2: powershell flavor uses -NoProfile -NonInteractive -EncodedCommand", () => {
		const env = makeEnv({ platform: "win32", onPath: { pwsh: "C:\\pf\\pwsh.exe" } });
		expect(resolve({ shellType: "powershell" }, env).args).toEqual([
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
		]);
	});
});

// =====================================================================
// Group I — buildSpawnArgs: bash verbatim, PowerShell base64-UTF16LE encoded
// with a UTF-8 output preamble (guards the encoding + arg-quoting fixes)
// =====================================================================
describe("buildSpawnArgs", () => {
	it("I1: bash passes the command verbatim after -c", () => {
		const cfg = { shell: "/bin/bash", args: ["-c"], kind: "bash" as const };
		expect(buildSpawnArgs(cfg, "echo 'a b'; ls")).toEqual(["-c", "echo 'a b'; ls"]);
	});

	it("I2: powershell base64-encodes (UTF-16LE) the preamble + command", () => {
		const cfg = {
			shell: "pwsh",
			args: ["-NoProfile", "-NonInteractive", "-EncodedCommand"],
			kind: "powershell" as const,
		};
		const command = 'Write-Output "a b"; Get-Item "C:\\Program Files"';
		const spawnArgs = buildSpawnArgs(cfg, command);
		expect(spawnArgs.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
		const decoded = Buffer.from(spawnArgs[3], "base64").toString("utf16le");
		expect(decoded).toBe(`${POWERSHELL_UTF8_PREAMBLE}${command}`);
		// The literal command (quotes, semicolon, spaces) survives intact inside the payload.
		expect(decoded).toContain('Write-Output "a b"; Get-Item "C:\\Program Files"');
	});
});

// =====================================================================
// Group J — inferKindFromPath precision (no substring false positives,
// trailing-separator paths don't misclassify)
// =====================================================================
describe("explicit shellPath kind inference precision", () => {
	function kindFor(path: string): "bash" | "powershell" {
		const env = makeEnv({ platform: "win32", existingPaths: [path] });
		return resolve({ shellPath: path }, env).kind as "bash" | "powershell";
	}

	it("J1: a bash wrapper whose name merely contains 'pwsh' is NOT powershell", () => {
		expect(kindFor("C:\\tools\\pwsh-bash.exe")).toBe("bash");
	});

	it("J2: exact pwsh/powershell stems are powershell (with .exe and .cmd)", () => {
		expect(kindFor("C:\\PS\\pwsh.exe")).toBe("powershell");
		expect(kindFor("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
		expect(kindFor("C:\\x\\pwsh.cmd")).toBe("powershell");
	});

	it("J3: a bash binary is bash even under a powershell-named directory", () => {
		expect(kindFor("C:\\PowerShell\\bin\\bash.exe")).toBe("bash");
	});
});

// =====================================================================
// Group G — getShellConfig wrapper: conservative "bash" default, explicit
// "auto" delivers PowerShell-first on Windows (production threads "auto" from
// settings). `env` injectable keeps this deterministic on any OS.
// =====================================================================
describe("getShellConfig wrapper", () => {
	it("G1: explicit auto on Windows -> PowerShell-first (no Git Bash required)", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [GIT_BASH], onPath: { pwsh: "C:\\pf\\pwsh.exe" } });
		expect(getShellConfig(undefined, "auto", env)).toEqual({
			shell: "C:\\pf\\pwsh.exe",
			args: PS_ARGS,
			kind: "powershell",
		});
	});

	it("G2: explicit auto on Unix -> bash (never prefers PowerShell on Unix)", () => {
		const env = makeEnv({ platform: "linux", existingPaths: ["/bin/bash"], onPath: { pwsh: "/usr/bin/pwsh" } });
		expect(getShellConfig(undefined, "auto", env).kind).toBe("bash");
	});

	it("G3: omitted shellType defaults to bash (safe for low-level callers)", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [GIT_BASH], onPath: { pwsh: "C:\\pf\\pwsh.exe" } });
		expect(getShellConfig(undefined, undefined, env).shell).toBe(GIT_BASH);
	});
});

// =====================================================================
// Group H — resolveShellKind: non-throwing flavor probe for tool descriptions
// =====================================================================
describe("resolveShellKind: never throws", () => {
	it("H1: explicit auto on Windows with pwsh -> powershell", () => {
		const env = makeEnv({ platform: "win32", onPath: { pwsh: "C:\\pf\\pwsh.exe" } });
		expect(resolveShellKind(undefined, "auto", env)).toBe("powershell");
	});

	it("H2: no shell found -> falls back to bash instead of throwing", () => {
		const env = makeEnv({ platform: "win32", existingPaths: [], onPath: {} });
		expect(resolveShellKind(undefined, "auto", env)).toBe("bash");
	});

	it("H3: explicit pwsh shellPath -> powershell", () => {
		const p = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const env = makeEnv({ platform: "win32", existingPaths: [p] });
		expect(resolveShellKind(p, "auto", env)).toBe("powershell");
	});

	it("H4: omitted shellType defaults to bash", () => {
		const env = makeEnv({ platform: "win32", onPath: { pwsh: "C:\\pf\\pwsh.exe" } });
		expect(resolveShellKind(undefined, undefined, env)).toBe("bash");
	});
});
