# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |
| < 1.0 | ❌ |

## Threat model — read this first

`opencode-windows-scheduler` is a **local automation tool**. By design it:

- registers jobs with the operating system scheduler;
- generates wrapper scripts that execute `opencode run` with a prompt;
- runs user-provided `beforeScript`, `afterScript` and Quality Gate commands through the system shell;
- stores job definitions, history and logs on the local machine.

Therefore:

1. **Job definitions are code.** Anyone who can create or edit a job can execute arbitrary commands under your user account. Protect the config directory and review imported job files (`.json`) before importing.
2. **The web dashboard is local.** Do not expose its port to untrusted networks; it has no authentication layer.
3. **Secrets in prompts and scripts are stored in plain text** in the local SQLite database and logs. Prefer environment variables managed outside the plugin; secret masking and encryption are on the roadmap.
4. **Tool allow/deny lists are metadata passed to the runtime**, not a sandbox. They do not replace OS-level isolation.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Use GitHub Security Advisories: <https://github.com/DeadSno/opencode-windows-scheduler/security/advisories/new>
- Include: affected version, OS, reproduction steps, impact and a suggested fix if you have one.

You can expect an acknowledgement within 72 hours and a coordinated disclosure timeline. Reporters will be credited in the release notes unless they prefer otherwise.

## Scope

In scope: command injection through job fields, path traversal in export/import, unsafe wrapper generation, credential leakage in logs, privilege issues in the OS scheduler integration, dashboard exposure.

Out of scope: issues that require an already-compromised local account, and the intentional ability to run arbitrary shell commands through job definitions.
