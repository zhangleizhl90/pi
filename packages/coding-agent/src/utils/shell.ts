import { existsSync, statSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

/** Concrete shell flavor used to assemble the command invocation. */
export type ShellKind = "bash" | "powershell";

/** User-facing shell selection from settings. "auto" resolves per platform. */
export type ShellType = "auto" | "bash" | "powershell";

export interface ShellConfig {
	shell: string;
	args: string[];
	/**
	 * Shell flavor. Optional for backward compatibility with callers/mocks that
	 * predate PowerShell support; `resolveShellConfig` always sets it.
	 */
	kind?: ShellKind;
}

/**
 * Command invocation args placed before the command argument, per shell flavor.
 *
 * PowerShell uses `-EncodedCommand` (base64 UTF-16LE) rather than `-Command "<string>"`
 * so the command survives Node/Windows argv quoting and PowerShell re-parsing intact
 * (quotes, semicolons, spaces, trailing backslashes). See `buildSpawnArgs`.
 */
export const BASH_INVOCATION_ARGS: string[] = ["-c"];
export const POWERSHELL_INVOCATION_ARGS: string[] = ["-NoProfile", "-NonInteractive", "-EncodedCommand"];

/**
 * Prepended to every PowerShell command so stdout/stderr are emitted as UTF-8.
 * Windows PowerShell 5.1 (and pwsh on non-UTF-8 locales) otherwise pipe output in
 * the console/OEM code page, which the UTF-8 output decoder turns into mojibake.
 *
 * $ProgressPreference='SilentlyContinue' suppresses the progress stream, which
 * PowerShell otherwise serializes to stderr as CLIXML (e.g. the one-time
 * "Preparing modules for first use" record) and pollutes captured tool output.
 */
export const POWERSHELL_UTF8_PREAMBLE =
	"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';\n";

/**
 * Build the full argv (invocation args + command) for spawning a resolved shell.
 * For PowerShell, the UTF-8 preamble + command are base64-UTF16LE encoded for
 * `-EncodedCommand`; for bash the command is passed verbatim after `-c`.
 */
export function buildSpawnArgs(config: ShellConfig, command: string): string[] {
	if (config.kind === "powershell") {
		const script = `${POWERSHELL_UTF8_PREAMBLE}${command}`;
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		return [...config.args, encoded];
	}
	return [...config.args, command];
}

/**
 * Injectable probes for shell resolution. Production wiring supplies real
 * filesystem/PATH lookups; tests supply deterministic fakes so the resolution
 * matrix can be exercised on any platform.
 */
export interface ShellProbeEnv {
	platform: NodeJS.Platform;
	/** True if a file exists at the given absolute path. */
	fileExists: (path: string) => boolean;
	/** Resolve an executable name on PATH to its absolute path, or null if absent. */
	findExecutableOnPath: (exe: string) => string | null;
	/** Value of %ProgramFiles% (Windows Git Bash discovery). */
	programFiles?: string;
	/** Value of %ProgramFiles(x86)% (Windows Git Bash discovery). */
	programFilesX86?: string;
}

export interface ResolveShellOptions {
	/** Selected shell type. Defaults to "auto". */
	shellType?: ShellType;
	/** Explicit shell executable path. When set, takes precedence over discovery. */
	shellPath?: string;
}

function argsForKind(kind: ShellKind): string[] {
	return kind === "powershell" ? [...POWERSHELL_INVOCATION_ARGS] : [...BASH_INVOCATION_ARGS];
}

/** Infer shell flavor from a binary name (exact `pwsh`/`powershell` stem -> powershell, else bash). */
function inferKindFromPath(shellPath: string): ShellKind {
	const file = shellPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
	const stem = file.replace(/\.(exe|cmd|bat|ps1)$/i, "");
	return /^(pwsh|powershell)$/i.test(stem) ? "powershell" : "bash";
}

/** Windows Git Bash candidate locations under Program Files. */
function winGitBashCandidates(env: ShellProbeEnv): string[] {
	const candidates: string[] = [];
	if (env.programFiles) candidates.push(`${env.programFiles}\\Git\\bin\\bash.exe`);
	if (env.programFilesX86) candidates.push(`${env.programFilesX86}\\Git\\bin\\bash.exe`);
	return candidates;
}

/** Discover PowerShell: pwsh (7+) first, then powershell (5.1). Null if neither. */
function discoverPowerShell(env: ShellProbeEnv): ShellConfig | null {
	const shell = env.findExecutableOnPath("pwsh") ?? env.findExecutableOnPath("powershell");
	return shell ? { shell, args: argsForKind("powershell"), kind: "powershell" } : null;
}

/**
 * Discover bash. On Windows: Git Bash known locations, then bash.exe on PATH;
 * null if none. On Unix: /bin/bash, then bash on PATH, then `sh` fallback (never null).
 */
function discoverBash(env: ShellProbeEnv): ShellConfig | null {
	if (env.platform === "win32") {
		for (const candidate of winGitBashCandidates(env)) {
			if (env.fileExists(candidate)) return { shell: candidate, args: argsForKind("bash"), kind: "bash" };
		}
		const onPath = env.findExecutableOnPath("bash.exe");
		return onPath ? { shell: onPath, args: argsForKind("bash"), kind: "bash" } : null;
	}

	if (env.fileExists("/bin/bash")) return { shell: "/bin/bash", args: argsForKind("bash"), kind: "bash" };
	const onPath = env.findExecutableOnPath("bash");
	if (onPath) return { shell: onPath, args: argsForKind("bash"), kind: "bash" };
	return { shell: "sh", args: argsForKind("bash"), kind: "bash" };
}

function noPowerShellError(): Error {
	return new Error(
		"No PowerShell found. Options:\n" +
			"  1. Install PowerShell 7: https://aka.ms/powershell\n" +
			"  2. Ensure pwsh.exe or powershell.exe is on PATH\n" +
			"  3. Set shellPath in settings.json",
	);
}

function noBashError(env: ShellProbeEnv): Error {
	const searched = winGitBashCandidates(env)
		.map((p) => `  ${p}`)
		.join("\n");
	return new Error(
		"No bash shell found. Options:\n" +
			"  1. Install Git for Windows: https://git-scm.com/download/win\n" +
			"  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n" +
			"  3. Set shellPath in settings.json\n\n" +
			`Searched Git Bash in:\n${searched}`,
	);
}

/**
 * Pure shell resolution: decides which shell to run and how to invoke it.
 *
 * Resolution precedence:
 * 1. Explicit `shellPath` (kind inferred from the binary name; shellType ignored).
 * 2. `shellType` "bash" | "powershell": flavor-specific discovery.
 * 3. `shellType` "auto" (default): PowerShell-first on Windows with graceful bash
 *    fallback; bash on Unix (PowerShell is never auto-preferred on Unix).
 */
export function resolveShellConfig(options: ResolveShellOptions, env: ShellProbeEnv): ShellConfig {
	if (options.shellPath) {
		if (!env.fileExists(options.shellPath)) {
			throw new Error(`Custom shell path not found: ${options.shellPath}`);
		}
		const kind = inferKindFromPath(options.shellPath);
		return { shell: options.shellPath, args: argsForKind(kind), kind };
	}

	const shellType = options.shellType ?? "auto";

	if (shellType === "powershell") {
		const ps = discoverPowerShell(env);
		if (ps) return ps;
		throw noPowerShellError();
	}

	if (shellType === "bash") {
		const bash = discoverBash(env);
		if (bash) return bash;
		throw noBashError(env);
	}

	// auto
	if (env.platform === "win32") {
		const ps = discoverPowerShell(env);
		if (ps) return ps;
		const bash = discoverBash(env);
		if (bash) return bash;
		throw new Error(
			"No shell found. Options:\n" +
				"  1. Install PowerShell 7: https://aka.ms/powershell\n" +
				"  2. Install Git for Windows (bash): https://git-scm.com/download/win\n" +
				'  3. Set shellPath, or shellType ("bash"|"powershell"), in settings.json',
		);
	}

	// Unix auto -> bash (discoverBash returns the `sh` fallback, never null here).
	const bash = discoverBash(env);
	if (bash) return bash;
	throw noBashError(env);
}

/** True if the path is a 0-byte file (Windows App Execution Alias reparse stub). */
function isZeroByteStub(path: string): boolean {
	try {
		return statSync(path).size === 0;
	} catch {
		return false;
	}
}

/** Resolve an executable name on PATH to its absolute path, or null if absent. */
function findExecutableOnPath(exe: string): string | null {
	if (process.platform === "win32") {
		// Windows: `where` can return non-existent paths, so verify the match exists.
		try {
			const result = spawnSync("where", [exe], { encoding: "utf-8", timeout: 5000, windowsHide: true });
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				// Skip 0-byte App Execution Alias stubs (e.g. WindowsApps\pwsh.exe), which
				// exist on disk but fail/open the Store when spawned non-interactively.
				if (firstMatch && existsSync(firstMatch) && !isZeroByteStub(firstMatch)) return firstMatch;
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: trust `which` output (handles Termux and special filesystems).
	try {
		const result = spawnSync("which", [exe], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) return firstMatch;
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/** Build the production probe environment backed by the real filesystem and PATH. */
function realShellProbeEnv(): ShellProbeEnv {
	return {
		platform: process.platform,
		fileExists: existsSync,
		findExecutableOnPath,
		programFiles: process.env.ProgramFiles,
		programFilesX86: process.env["ProgramFiles(x86)"],
	};
}

/**
 * Process-lifetime cache of real-environment resolutions, keyed by (shellType, shellPath).
 * Shell availability is static for a run, so this avoids re-spawning `where`/`which` on
 * every tool build / system-prompt rebuild / tool-call render. Cleared on settings reload.
 */
const shellConfigCache = new Map<string, ShellConfig | Error>();

/** Clear the shell-resolution cache (call after settings/PATH may have changed). */
export function clearShellConfigCache(): void {
	shellConfigCache.clear();
}

/**
 * Resolve shell configuration for production use.
 *
 * `shellType` defaults to "bash" — a conservative default for low-level callers.
 * The product default ("auto": PowerShell-first on Windows, bash on Unix) lives
 * in settings (`SettingsManager.getShellType`) and is threaded in explicitly.
 * When `env` is omitted, the real-environment result is memoized; pass `env` to
 * bypass the cache for deterministic tests.
 */
export function getShellConfig(
	customShellPath?: string,
	shellType: ShellType = "bash",
	env?: ShellProbeEnv,
): ShellConfig {
	if (env) {
		return resolveShellConfig({ shellPath: customShellPath, shellType }, env);
	}
	const key = `${shellType}
${customShellPath ?? ""}`;
	let cached = shellConfigCache.get(key);
	if (cached === undefined) {
		try {
			cached = resolveShellConfig({ shellPath: customShellPath, shellType }, realShellProbeEnv());
		} catch (error) {
			cached = error instanceof Error ? error : new Error(String(error));
		}
		shellConfigCache.set(key, cached);
	}
	if (cached instanceof Error) {
		throw cached;
	}
	return cached;
}

/**
 * Resolve only the shell flavor, without throwing. Used at tool-build time to
 * pick the tool description; falls back to "bash" when no shell is found (the
 * real error surfaces later at execution time). Reuses `getShellConfig`'s cache.
 */
export function resolveShellKind(
	customShellPath?: string,
	shellType: ShellType = "bash",
	env?: ShellProbeEnv,
): ShellKind {
	try {
		return getShellConfig(customShellPath, shellType, env).kind ?? "bash";
	} catch {
		return "bash";
	}
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
