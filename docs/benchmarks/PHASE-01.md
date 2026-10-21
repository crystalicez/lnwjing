# lnwjing Phase 01 Compatibility Benchmark

Generated: 2026-08-16T18:19:46.017Z
Repository: `main` @ `3ba7d48da9eba432988414fb03322d1f33a84fca`

## Scope

This is a post-Phase-01 compatibility snapshot. It starts the built lnwjing application runtime, registers a temporary fixture workspace, measures the loopback MCP HTTP transport, and deletes the fixture afterward. It retains the Phase 00 sequential scenarios so tool-catalog and transport changes can be compared without replacing the original baseline.

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
- Tool count: **54**
- Initialize latency: 59.55 ms
- tools/list latency: 10.49 ms
- Handshake body bytes transferred: 37,441
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
- `tool_batch` (3 input properties)

## Scenario measurements

| Scenario | Runs | Calls/run | Tool calls | Avg workflow ms | Avg tool ms | p50 tool ms | p95 tool ms | Bytes transferred | Result bytes | Errors | Retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| simple-file-read | 3 | 1 | 3 | 15.94 | 15.87 | 15.51 | 19.24 | 3,354 | 2,844 | 0 | 0 |
| workspace-search | 3 | 1 | 3 | 94.43 | 94.39 | 94.89 | 96.45 | 6,765 | 6,135 | 0 | 0 |
| git-status-diff | 3 | 2 | 6 | 137.69 | 68.79 | 60.58 | 106.44 | 4,642 | 3,722 | 0 | 0 |
| bug-investigation | 3 | 5 | 15 | 315.13 | 63.01 | 57 | 113.18 | 16,794 | 14,280 | 0 | 0 |
| code-review | 3 | 4 | 12 | 253.09 | 63.25 | 55.45 | 91.7 | 11,430 | 9,387 | 0 | 0 |
| ui-debugging | 3 | 2 | 6 | 787.9 | 393.93 | 10.46 | 790.18 | 7,791 | 7,134 | 0 | 0 |
| test-failure-investigation | 3 | 4 | 12 | 170.79 | 42.68 | 9.99 | 93.39 | 11,781 | 9,675 | 0 | 0 |

## Totals

| Metric | Value |
| --- | ---: |
| Tool calls | 57 |
| Protocol requests | 60 |
| Average tool latency | 93.39 ms |
| p50 tool latency | 56.73 ms |
| p95 tool latency | 756.79 ms |
| Average workflow latency | 253.57 ms |
| p50 workflow latency | 177.09 ms |
| p95 workflow latency | 797.7 ms |
| Bytes transferred | 99,998 |
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

This report records the sequential compatibility cost after adding `tool_batch`. The original Phase 00 report remains the comparison baseline; the new compound engine is covered by focused parallel, dependency, timeout, cancellation, partial-failure, and mutation-serialization tests.
