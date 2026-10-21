# Security Policy

## Supported versions

Security fixes are prioritized for the latest published lnwjing release and the current `main` branch. Older releases may not receive backported fixes; users should normally update to the latest stable release after reviewing release notes and operational requirements.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for a suspected vulnerability, credential exposure, privilege-boundary bypass, workspace escape, destructive-action bypass, or other security-sensitive finding.

Preferred reporting path:

1. Open the repository **Security** tab.
2. If **Report a vulnerability** / private vulnerability reporting is available, use that private channel.
3. Include the affected version or commit, reproduction steps, expected vs. actual behavior, impact, and any proposed mitigation.
4. Redact tokens, credentials, private file contents, user data, and unrelated machine information from logs or screenshots.

If private vulnerability reporting is not available, contact the repository maintainer through GitHub and request a private channel before sharing exploit details.

## What to include

Useful reports contain:

- lnwjing version and installation type.
- Windows version and relevant optional runtime (WSL, browser, Office, etc.).
- The affected tool/capability and workspace/trust-boundary context.
- Minimal reproduction steps.
- Whether the issue requires local access, an authenticated MCP client, or user confirmation.
- Potential impact and whether data modification, credential exposure, or privilege expansion is possible.

## Security model notes

lnwjing intentionally exposes powerful local capabilities. A report is especially useful when it demonstrates behavior outside the documented permission, workspace, confirmation, or process-ownership boundaries rather than merely showing that an explicitly authorized local capability is powerful.

Do not test against machines, accounts, repositories, or data you do not own or have explicit permission to assess.
