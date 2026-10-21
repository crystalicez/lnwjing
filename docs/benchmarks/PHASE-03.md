# lnwjing Phase 03 Compatibility Benchmark

Generated: 2026-08-16T18:39:53.354Z
Repository: `main` @ `75b8d1ede2053641e98e8b5705f52dab27daa865`

## Scope

This is the Phase 03 compatibility snapshot. It starts the built lnwjing application runtime, registers a temporary fixture workspace, measures the loopback MCP HTTP transport, and deletes the fixture afterward. It is a repeatable local contract benchmark, not a production-machine benchmark.

| Field | Value |
| --- | --- |
| Node | `v24.16.0` |
| Platform | `win32/x64` |
| Transport | loopback Streamable HTTP (legacy-compatible claim-less MCP route) at `127.0.0.1 (ephemeral port)` |
| Runs per scenario | 3 |
| Configured retries | 0 |
| Request timeout | 30000 ms |
| Fixture | temporary synthetic repository; deleted after the run |

## MCP discovery baseline

- Negotiated protocol: `2025-11-25`
- Tool count: **63**
- Initialize latency: 63.52 ms
- tools/list latency: 13.14 ms
- Handshake body bytes transferred: 42,684
- Handshake protocol requests: 3 (initialize, initialized notification, tools/list)

### Discovered tools

- `workspace_list` (0 input properties)
- `workspace_register` (3 input properties)
- `workspace_info` (1 input properties)
- `workspace_tree` (4 input properties)
- `project_snapshot` (1 input properties)
- `read_file` (4 input properties)
- `read_files` (2 input properties)
- `search_files` (4 input properties)
- `search_text` (5 input properties)
- `git_status` (1 input properties)
- `git_diff` (4 input properties)
- `git_log` (3 input properties)
- `git` (4 input properties)
- `write_file` (3 input properties)
- `apply_patch` (2 input properties)
- `move_file` (3 input properties)
- `copy_file` (3 input properties)
- `delete_file` (3 input properties)
- `process_start` (5 input properties)
- `process_status` (2 input properties)
- `process_logs` (4 input properties)
- `process_stop` (2 input properties)
- `project_dev` (1 input properties)
- `project_test` (1 input properties)
- `project_lint` (1 input properties)
- `project_typecheck` (1 input properties)
- `project_build` (1 input properties)
- `codex_status` (0 input properties)
- `codex_run` (2 input properties)
- `codex_task_status` (2 input properties)
- `codex_task_logs` (4 input properties)
- `codex_stop` (2 input properties)
- `shell` (16 input properties)
- `dom_cdp` (10 input properties)
- `accessibility` (8 input properties)
- `input_event` (8 input properties)
- `vision` (12 input properties)
- `window` (6 input properties)
- `health` (3 input properties)
- `system_info` (5 input properties)
- `notification` (6 input properties)
- `file_dialog` (8 input properties)
- `clipboard` (5 input properties)
- `web_fetch` (9 input properties)
- `audio` (7 input properties)
- `screen_record` (10 input properties)
- `office` (12 input properties)
- `scheduler` (10 input properties)
- `skills_list` (2 input properties)
- `skills_read` (2 input properties)
- `mcp_list` (0 input properties)
- `mcp_describe` (1 input properties)
- `mcp_call` (3 input properties)
- `workspace_context` (7 input properties)
- `workspace_context_continue` (2 input properties)
- `workspace_full_scan` (4 input properties)
- `workspace_full_scan_continue` (2 input properties)
- `workspace_snapshot` (1 input properties)
- `search_all` (5 input properties)
- `read_many_files` (2 input properties)
- `read_file_page` (5 input properties)
- `read_file_page_continue` (2 input properties)
- `tool_batch` (3 input properties)

## Scenario measurements

| Scenario | Runs | Calls/run | Tool calls | Avg workflow ms | Avg tool ms | p50 tool ms | p95 tool ms | Bytes transferred | Result bytes | Errors | Retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| simple-file-read | 3 | 1 | 3 | 15.56 | 15.5 | 14.78 | 18.96 | 3,354 | 2,844 | 0 | 0 |
| workspace-search | 3 | 1 | 3 | 102.09 | 102.03 | 102.51 | 107.7 | 6,765 | 6,135 | 0 | 0 |
| git-status-diff | 3 | 2 | 6 | 124.41 | 62.18 | 61.59 | 68.74 | 4,642 | 3,722 | 0 | 0 |
| bug-investigation | 3 | 5 | 15 | 317.8 | 63.54 | 56.93 | 114.6 | 16,794 | 14,280 | 0 | 0 |
| code-review | 3 | 4 | 12 | 261.28 | 65.3 | 56.82 | 93.19 | 11,430 | 9,387 | 0 | 0 |
| ui-debugging | 3 | 2 | 6 | 813.27 | 406.61 | 22.6 | 806.5 | 7,791 | 7,134 | 0 | 0 |
| test-failure-investigation | 3 | 4 | 12 | 172.7 | 43.16 | 14.68 | 90.82 | 11,781 | 9,675 | 0 | 0 |

## Totals

| Metric | Value |
| --- | ---: |
| Tool calls | 57 |
| Protocol requests | 60 |
| Average tool latency | 95.09 ms |
| p50 tool latency | 58.41 ms |
| p95 tool latency | 790.67 ms |
| Average workflow latency | 258.16 ms |
| p50 workflow latency | 170.33 ms |
| p95 workflow latency | 813.31 ms |
| Bytes transferred | 105,241 |
| Result bytes | 53,177 |
| Errors | 0 |
| Retries | 0 |

## Measurement contract

- **Tool calls** count `tools/call` requests only. The handshake and discovery requests are reported separately and included in **protocol requests**.
- **Latency** is measured around each HTTP request from the benchmark process. Workflow latency covers all sequential tool calls in one scenario run.
- **Bytes transferred** is the UTF-8 request body plus the raw HTTP response body for every measured request, including the discovery handshake in the total.
- **Result bytes** is the raw response body for tool calls; it includes the JSON-RPC envelope and MCP result metadata.
- **Errors** count transport/JSON-RPC failures and MCP tool results with `isError: true`. A failed step does not discard sibling steps in the scenario.
- **Retries** count only automatic transport retries. The default baseline uses zero retries so failures remain visible.

## Baseline interpretation

This report records the 63-tool contract after Phase 03 resumable file paging. Future indexing, lifecycle, permission, caching, and discovery changes must preserve primitive compatibility and full accessible context, including explicitly requested hidden or generated paths.
