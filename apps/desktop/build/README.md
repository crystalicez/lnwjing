# Desktop build resources

This directory contains source build resources used by Electron Builder, including the branded lnwjing application icons and NSIS include file.

The MCP stdio launcher files (`lnwjing-mcp-stdio.cjs` and `lnwjing-mcp-stdio.cmd`) are **generated artifacts**, not source files. `pnpm build` / `pnpm package:windows` regenerates them from the current CLI entrypoint before packaging. They are intentionally ignored by Git so stale local bundles and machine-specific build content cannot become part of the public source tree.

Current Windows packaging uses:

- `build/icon.ico` for the Windows executable, installer, and uninstaller branding.
- `build/icon.png` as an application image resource.
- `signAndEditExecutable: true` so Electron Builder can apply executable metadata/icon editing.
- x64 NSIS, per-user installation, with a user-selectable installation directory.
- `deleteAppDataOnUninstall: false`, so uninstalling the application does not automatically delete lnwjing user data.

Do not hand-edit generated stdio bundles. Change their source under `apps/cli/` or the launcher generator script, rebuild, and verify the resulting package instead.
