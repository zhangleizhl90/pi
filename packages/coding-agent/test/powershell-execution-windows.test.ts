/**
 * Real PowerShell execution smoke test.
 *
 * Windows-only: gated on PowerShell being resolvable. Skipped on CI (ubuntu)
 * and on Windows machines without pwsh/powershell. Verifies that the bash tool's
 * local operations actually run commands through PowerShell when shellType is
 * "powershell" — i.e. PowerShell-only syntax works and exit codes propagate.
 */

import { describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { getShellConfig } from "../src/utils/shell.ts";

function powerShellAvailable(): boolean {
	if (process.platform !== "win32") return false;
	try {
		getShellConfig(undefined, "powershell");
		return true;
	} catch {
		return false;
	}
}

const hasPowerShell = powerShellAvailable();

async function runPowerShell(command: string): Promise<{ out: string; exitCode: number | null }> {
	const ops = createLocalBashOperations({ shellType: "powershell" });
	let out = "";
	const { exitCode } = await ops.exec(command, process.cwd(), {
		onData: (chunk) => {
			out += chunk.toString();
		},
	});
	return { out, exitCode };
}

describe.skipIf(!hasPowerShell)("PowerShell execution (Windows)", () => {
	it("runs a PowerShell command and captures stdout", async () => {
		const { out, exitCode } = await runPowerShell("Write-Output 'pi-ps-ok'");
		expect(out).toContain("pi-ps-ok");
		expect(exitCode).toBe(0);
	});

	it("decodes non-ASCII output as UTF-8 (no mojibake) regardless of console code page", async () => {
		const { out } = await runPowerShell("Write-Output 'café-日本語'");
		expect(out).toContain("café-日本語");
	});

	it("preserves commands containing quotes, semicolons, and spaced paths verbatim", async () => {
		const { out } = await runPowerShell('Write-Output "a b"; Write-Output "x;y"');
		expect(out).toContain("a b");
		expect(out).toContain("x;y");
	});

	it("executes PowerShell-only constructs ($PSVersionTable)", async () => {
		const { out } = await runPowerShell("if ($PSVersionTable) { Write-Output 'is-powershell' }");
		expect(out).toContain("is-powershell");
	});

	it("propagates non-zero exit codes", async () => {
		const { exitCode } = await runPowerShell("exit 3");
		expect(exitCode).toBe(3);
	});
});
