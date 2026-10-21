# lnwjing Phase 02 Compatibility Benchmark

Generated: 2026-08-16T18:32:43.446Z
Repository: `main` @ `687c362c5af1ec6c8930e61bc35fd3361bdd29b7`

## Scope

This is a post-Phase-02 compatibility snapshot. It starts the built lnwjing application runtime, registers a temporary fixture workspace, measures the loopback MCP HTTP transport, and deletes the fixture afterward. It retains the original sequential scenarios so the expanded context surface can be compared against the Phase 00 baseline.

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
- Tool count: **61**
- Initialize latency: 64.1 ms
- tools/list latency: 11.26 ms
- Handshake body bytes transferred: 41,543
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
- `tool_batch` (3 input properties)

## Scenario measurements

| Scenario | Runs | Calls/run | Tool calls | Avg workflow ms | Avg tool ms | p50 tool ms | p95 tool ms | Bytes transferred | Result bytes | Errors | Retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| simple-file-read | 3 | 1 | 3 | 15.06 | 15 | 13.04 | 19.83 | 3,354 | 2,844 | 0 | 0 |
| workspace-search | 3 | 1 | 3 | 94.85 | 94.81 | 92.28 | 100.92 | 6,765 | 6,135 | 0 | 0 |
| git-status-diff | 3 | 2 | 6 | 114.3 | 57.12 | 56.62 | 62.3 | 4,642 | 3,722 | 0 | 0 |
| bug-investigation | 3 | 5 | 15 | 309.27 | 61.84 | 59.16 | 113.19 | 16,794 | 14,280 | 0 | 0 |
| code-review | 3 | 4 | 12 | 254.85 | 63.69 | 55.08 | 90.36 | 11,430 | 9,387 | 0 | 0 |
| ui-debugging | 3 | 2 | 6 | 865.61 | 432.78 | 10.33 | 1,047.65 | 7,791 | 7,134 | 0 | 0 |
| test-failure-investigation | 3 | 4 | 12 | 166.14 | 41.52 | 11 | 93.62 | 11,781 | 9,675 | 0 | 0 |

## Totals

| Metric | Value |
| --- | ---: |
| Tool calls | 57 |
| Protocol requests | 60 |
| Average tool latency | 95.77 ms |
| p50 tool latency | 56.36 ms |
| p95 tool latency | 756.3 ms |
| Average workflow latency | 260.01 ms |
| p50 workflow latency | 165.63 ms |
| p95 workflow latency | 772.52 ms |
| Bytes transferred | 104,100 |
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

This report records the sequential compatibility cost after the context aggregation and full-visibility search changes. The Phase 00 report remains the historical baseline; context behavior is covered by engine tests for ranking, continuation, cross-workspace search, full scan, and parallel many-file reads.
