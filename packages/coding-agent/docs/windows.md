# Windows Setup

On Windows, pi runs the `bash` tool through **PowerShell by default** — no Git Bash
required. PowerShell 7 (`pwsh`) is preferred; Windows PowerShell 5.1 (`powershell.exe`)
is used as a fallback.

The shell is selected by the `shellType` setting:

| `shellType` | Behavior |
|-------------|----------|
| `"auto"` (default) | Windows: PowerShell-first (pwsh, then powershell.exe), falling back to bash if no PowerShell is found. Unix: bash. |
| `"powershell"` | Always PowerShell (pwsh, then powershell.exe). |
| `"bash"` | Always bash. On Windows: Git Bash, then `bash.exe` on PATH. |

When PowerShell is active, write **PowerShell syntax** (e.g. `Get-ChildItem`,
`Select-String`, `Where-Object`; use `;` or `if` instead of `&&`/`||`). PowerShell 7
is recommended over 5.1 for UTF-8 output and modern operators.

## Configuration

Set the shell type in `~/.pi/agent/settings.json`:

```json
{
  "shellType": "powershell"
}
```

To use bash (requires [Git for Windows](https://git-scm.com/download/win), Cygwin,
MSYS2, or WSL):

```json
{
  "shellType": "bash"
}
```

### Custom shell path

`shellPath` pins an explicit shell executable and takes precedence over `shellType`.
The flavor is inferred from the binary name (`pwsh`/`powershell` → PowerShell, otherwise bash):

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Bash discovery (shellType "bash")

When bash is selected, pi checks these locations in order:

1. `shellPath` from settings
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`, then the x86 path)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)
