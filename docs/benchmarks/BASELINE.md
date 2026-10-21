# lnwjing Baseline Benchmark

Generated: 2026-08-16T18:08:33.449Z
Repository: `main` @ `d6f3173c34f5d0bff9bdf94617125cb0974537dc`

## Scope

This is the Phase 00 synthetic baseline. It starts the built lnwjing application runtime, registers a temporary fixture workspace, measures the loopback MCP HTTP transport, and deletes the fixture afterward. It is a repeatable local contract baseline, not a production-machine benchmark.

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
- Tool count: **53**
- Initialize latency: 60.62 ms
- tools/list latency: 15.44 ms
- Handshake body bytes transferred: 35,783
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

## Scenario measurements

| Scenario | Runs | Calls/run | Tool calls | Avg workflow ms | Avg tool ms | p50 tool ms | p95 tool ms | Bytes transferred | Result bytes | Errors | Retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| simple-file-read | 3 | 1 | 3 | 13.59 | 13.52 | 11.69 | 17.56 | 3,354 | 2,844 | 0 | 0 |
| workspace-search | 3 | 1 | 3 | 106.84 | 106.8 | 100.47 | 125.25 | 6,765 | 6,135 | 0 | 0 |
| git-status-diff | 3 | 2 | 6 | 147.82 | 73.87 | 64.84 | 91.53 | 4,642 | 3,722 | 0 | 0 |
| bug-investigation | 3 | 5 | 15 | 320.45 | 64.07 | 57.24 | 123.89 | 16,794 | 14,280 | 0 | 0 |
| code-review | 3 | 4 | 12 | 272.28 | 68.05 | 60.93 | 97.62 | 11,430 | 9,387 | 0 | 0 |
| ui-debugging | 3 | 2 | 6 | 808.3 | 404.13 | 11.67 | 836.26 | 7,791 | 7,134 | 0 | 0 |
| test-failure-investigation | 3 | 4 | 12 | 181.47 | 45.35 | 10.61 | 100.41 | 11,781 | 9,675 | 0 | 0 |

## Totals

| Metric | Value |
| --- | ---: |
| Tool calls | 57 |
| Protocol requests | 60 |
| Average tool latency | 97.38 ms |
| p50 tool latency | 60.93 ms |
| p95 tool latency | 761 ms |
| Average workflow latency | 264.39 ms |
| p50 workflow latency | 177.25 ms |
| p95 workflow latency | 808.65 ms |
| Bytes transferred | 98,340 |
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

This report records the current sequential call cost before Phase 01. Future parallel execution, context aggregation, pagination, indexing, and caching changes must preserve the primitive-tool contract and must be compared against this report without silently reducing accessible context.
