# Office Suite v5.5.0

lnwjing v5.5.0 adds semantic Office tools on top of the existing Office capability while preserving the legacy `office`, `office_ppt`, `office_outlook`, `inspect_workbook`, `render_excel_preview`, `compare_workbook_layout`, and `docx_merge` surfaces.

## Provider truthfulness

`office_status` is the authoritative readiness surface. Installed software is not treated as semantic readiness by itself.

- **Windows Microsoft Office COM:** production provider for the actions reported in each tool's `supportedActions`.
- **macOS local Office automation:** not advertised ready until a native provider has passed real acceptance.
- **Linux / LibreOffice UNO:** not advertised ready until a production UNO implementation has passed real acceptance.
- **Microsoft Graph / Microsoft 365:** contracts are present for cloud workloads, but v5.5.0 reports Graph as unavailable/not signed in until a complete OAuth provider is configured and accepted.
- **Access, Visio, Project, Publisher:** optional contracts only; installed dependency detection must not make unsupported semantic actions ready.
- **Desktop UI automation:** never selected implicitly as a substitute for COM, Graph, UNO, or Open XML.

The status response separates dependency availability from action readiness and reports unsupported operations with `ready:false`, `executed:false`, and an explicit reason.

## Semantic surfaces

The v5.5.0 catalog includes:

- `office_word`: structured reads, search, document properties, text/table/image/header-footer/comment/revision operations, styles/fonts, protection, merge, save/save-as, PDF and text export.
- `office_excel`: workbook/sheet/range/formula/style/table/chart/pivot reads and edits, sorting/filtering, freeze panes, validation, comments/images, calculation/error checks, protection, PDF/CSV/TSV export.
- `office_powerpoint`: presentation/slide/shape/text/layout/media/table/chart/notes reads and edits, slide lifecycle, save/save-as and PDF export.
- `office_outlook`: bounded folder/message/header/body/attachment/search/conversation reads plus guarded draft/message mutation and send.
- `office_calendar`: calendar/event listing, search, create/update/delete and guarded invitation sending.
- `office_contacts`: list/search/get/create/update/delete contacts.
- `office_tasks`: task-folder/task listing, search, create/update/complete/reopen/delete.
- `office_onenote`, `office_onedrive`, `office_sharepoint`, `office_teams`: Graph-routed contracts that remain unavailable until Graph OAuth/provider readiness is real.
- `office_access`, `office_visio`, `office_project`, `office_publisher`: optional local-provider contracts that fail closed when no verified provider exists.
- `office_convert`: conversion routing only when the selected provider can perform the conversion and the output artifact can be verified.
- `office_batch`: bounded ordered orchestration with dry-run support; dangerous child actions cannot be hidden inside a batch.

## Permissions, recovery, and security

Office semantic tools remain inside the normal lnwjing safety boundary:

- workspace/Active Project scope is checked for file mutations;
- mutation policy classifies reads, creates, replacements, destructive operations, sending and other dangerous actions;
- recoverable replacement operations retain a pre-image and return recovery identity/path information;
- recovery is explicit—lnwjing does not silently restore an older file after reporting success;
- send mail and send invitation remain confirmation-gated;
- macro execution is not enabled by v5.5.0 and `run_macro` remains unsupported/default-disabled;
- Office Trust Center settings are never lowered automatically;
- external-data refresh is not silently enabled;
- attachment paths follow the same file-safety boundary as other workspace file operations;
- model-visible results and logs must not expose Graph tokens, mailbox credentials, file passwords, OAuth secrets, or other protected values;
- large reads are bounded instead of returning an entire document/mailbox/workbook without limits.

## Windows prerequisites

For the Windows COM provider, install the corresponding desktop Microsoft Office application. v5.5.0 real-provider acceptance targets Word, Excel, PowerPoint and Outlook 16.x on Windows.

The provider owns only the automation process/session it starts for document work. Outlook is treated specially because `Outlook.Application` is commonly a shared single-instance COM server: acceptance and runtime cleanup release COM references but do **not** call `Outlook.Application.Quit()` merely to finish an lnwjing operation.

## Real-provider acceptance

`scripts/verify-office-provider.ps1` creates synthetic artifacts only under `.local-artifacts/office-provider-acceptance/<timestamp>` and exercises real Windows Office COM.

The harness:

- logs the app/action before every call;
- enforces a bounded per-action timeout;
- terminates only the PowerShell child owned by that acceptance call when an action times out;
- tests Word, Excel and PowerPoint create/edit/read/export workflows;
- probes Outlook status first; only when that probe proves ready does it continue with folder listing, one bounded message listing, and draft create/update/delete; it never sends, and a status timeout is recorded as degraded readiness instead of a fake pass;
- checks that the test did not leave new `WINWORD`, `EXCEL`, or `POWERPNT` processes behind;
- writes non-secret JSON evidence without mailbox contents.

A provider/action that fails acceptance must be fixed or reported not ready; mocks alone are not acceptance evidence.

## Cross-platform limitations

macOS and Linux still expose the Office provider boundary, but v5.5.0 does not claim native Office parity there. Graph and LibreOffice/UNO can be added later only after their real authentication/provider implementation and acceptance exist. Contracts may be visible while readiness remains false; that is intentional.

## Dry-run and recovery examples

Mutation-capable semantic tools default to the runtime's policy-aware dry-run behavior where the action can be previewed. A dry-run result means a plan was produced; it does not mean the Office application executed the change.

For file replacements, keep the returned recovery identifier/path until the result is validated. Restoration is a separate explicit operation through lnwjing recovery tooling.

## Related documentation

- [Thai usage guide](USAGE_TH.md)
- [Capability overview](LNWJING_CAPABILITIES.md)
- [MCP tool catalog](mcp/MCP_TOOL_CATALOG.md)
- [v5.5.0 implementation plan](codebase/2026-09-22-v5.5.0-office-suite-whats-new-plan.md)
