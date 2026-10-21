# lnwjing Phase 05–40 Foundation Compatibility Benchmark

Generated: 2026-08-16T19:24:15.048Z
Repository: `main` @ `087b240bc4a00a0e3829b9a5eb1eeecf50121de1`

## Scope

This is the Phase 05–40 foundation compatibility snapshot. It starts the built lnwjing application runtime, registers a temporary fixture workspace, measures the loopback MCP HTTP transport, and deletes the fixture afterward. It is a repeatable local contract benchmark, not a production-machine benchmark.

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
- Tool count: **183**
- Initialize latency: 68.23 ms
- tools/list latency: 16.73 ms
- Handshake body bytes transferred: 76,869
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
- `workspace_index` (2 input properties)
- `workspace_index_status` (1 input properties)
- `workspace_index_watch` (3 input properties)
- `workspace_index_stop` (1 input properties)
- `symbol_search` (0 input properties)
- `find_definition` (0 input properties)
- `find_references` (0 input properties)
- `find_implementations` (0 input properties)
- `call_hierarchy` (0 input properties)
- `import_graph` (0 input properties)
- `dependency_graph` (0 input properties)
- `module_graph` (0 input properties)
- `type_search` (0 input properties)
- `trace_symbol` (0 input properties)
- `context_ranking` (0 input properties)
- `debug_context` (0 input properties)
- `review_context` (0 input properties)
- `change_context` (0 input properties)
- `symbol_context` (0 input properties)
- `test_context` (0 input properties)
- `dependency_context` (0 input properties)
- `git_context` (0 input properties)
- `frontend_context` (0 input properties)
- `backend_context` (0 input properties)
- `route_intent` (0 input properties)
- `recipe_list` (0 input properties)
- `recipe_describe` (0 input properties)
- `recipe_run` (0 input properties)
- `dry_run` (0 input properties)
- `review_changes` (0 input properties)
- `changed_symbols` (0 input properties)
- `affected_modules` (0 input properties)
- `git_history_context` (0 input properties)
- `git_blame_context` (0 input properties)
- `discover_tests` (0 input properties)
- `run_affected_tests` (0 input properties)
- `test_failures` (0 input properties)
- `coverage_context` (0 input properties)
- `test_history` (0 input properties)
- `cache_stats` (0 input properties)
- `cache_clear` (0 input properties)
- `cache_invalidate` (0 input properties)
- `hook_list` (0 input properties)
- `hook_register` (0 input properties)
- `hook_remove` (0 input properties)
- `skill_match` (0 input properties)
- `skill_load` (0 input properties)
- `plugin_install` (0 input properties)
- `plugin_list` (0 input properties)
- `plugin_enable` (0 input properties)
- `plugin_disable` (0 input properties)
- `plugin_remove` (0 input properties)
- `session_context` (0 input properties)
- `session_checkpoint` (0 input properties)
- `session_resume` (0 input properties)
- `session_history` (0 input properties)
- `response_mode` (0 input properties)
- `inspect_web_app` (0 input properties)
- `debug_ui` (0 input properties)
- `capture_ui_state` (0 input properties)
- `form_context` (0 input properties)
- `network_context` (0 input properties)
- `console_context` (0 input properties)
- `browser_debug_context` (0 input properties)
- `windows_environment` (0 input properties)
- `service_context` (0 input properties)
- `process_context` (0 input properties)
- `port_context` (0 input properties)
- `registry_context` (0 input properties)
- `event_log_context` (0 input properties)
- `installed_runtime_context` (0 input properties)
- `path_context` (0 input properties)
- `startup_context` (0 input properties)
- `mcp_discover` (0 input properties)
- `mcp_health` (0 input properties)
- `mcp_resources` (0 input properties)
- `task_create` (0 input properties)
- `task_status` (0 input properties)
- `task_cancel` (0 input properties)
- `task_result` (0 input properties)
- `task_list` (0 input properties)
- `delegate` (0 input properties)
- `delegate_status` (0 input properties)
- `delegate_cancel` (0 input properties)
- `delegate_result` (0 input properties)
- `parallel_delegate` (0 input properties)
- `permission_check` (0 input properties)
- `permission_profile` (0 input properties)
- `live_logs_query` (0 input properties)
- `live_logs_status` (0 input properties)
- `telemetry_dashboard` (0 input properties)
- `execution_plan` (0 input properties)
- `repo_map` (0 input properties)
- `context_expand` (0 input properties)
- `recovery_status` (0 input properties)
- `tool_schema_list` (0 input properties)
- `tool_schema_register` (0 input properties)
- `capabilities` (0 input properties)
- `tool_search` (0 input properties)
- `tool_describe` (0 input properties)
- `tool_categories` (0 input properties)
- `tool_function_find` (0 input properties)
- `tool_aliases` (0 input properties)
- `dev_context` (0 input properties)
- `recipe_catalog` (0 input properties)
- `capture_screenshot` (0 input properties)
- `compare_screenshot` (0 input properties)
- `dom_snapshot` (0 input properties)
- `layout_metadata` (0 input properties)
- `visual_context` (0 input properties)
- `inspect_workbook` (0 input properties)
- `compare_workbook_layout` (0 input properties)
- `render_excel_preview` (0 input properties)
- `inspect_pdf` (0 input properties)
- `compare_pdf_pages` (0 input properties)
- `project_profile_get` (0 input properties)
- `project_profile_set` (0 input properties)
- `handoff_context` (0 input properties)
- `benchmark_run` (0 input properties)
- `regression_report` (0 input properties)
- `tool_batch` (3 input properties)

## Scenario measurements

| Scenario | Runs | Calls/run | Tool calls | Avg workflow ms | Avg tool ms | p50 tool ms | p95 tool ms | Bytes transferred | Result bytes | Errors | Retries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| simple-file-read | 3 | 1 | 3 | 16.87 | 16.81 | 15.87 | 21.56 | 3,354 | 2,844 | 0 | 0 |
| workspace-search | 3 | 1 | 3 | 108.03 | 107.98 | 93.63 | 136.99 | 6,765 | 6,135 | 0 | 0 |
| git-status-diff | 3 | 2 | 6 | 124.19 | 62.06 | 61.8 | 63.76 | 4,642 | 3,722 | 0 | 0 |
| bug-investigation | 3 | 5 | 15 | 333.61 | 66.7 | 57.67 | 167.13 | 16,794 | 14,280 | 0 | 0 |
| code-review | 3 | 4 | 12 | 268.42 | 67.09 | 59 | 99.19 | 11,430 | 9,387 | 0 | 0 |
| ui-debugging | 3 | 2 | 6 | 780.8 | 390.38 | 15.42 | 784.55 | 7,791 | 7,134 | 0 | 0 |
| test-failure-investigation | 3 | 4 | 12 | 175.15 | 43.77 | 15.7 | 96.51 | 11,781 | 9,675 | 0 | 0 |

## Totals

| Metric | Value |
| --- | ---: |
| Tool calls | 57 |
| Protocol requests | 60 |
| Average tool latency | 95.09 ms |
| p50 tool latency | 59 ms |
| p95 tool latency | 756.11 ms |
| Average workflow latency | 258.15 ms |
| p50 workflow latency | 178.01 ms |
| p95 workflow latency | 771.22 ms |
| Bytes transferred | 139,426 |
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

## Foundation interpretation

This report records the 183-tool Phase 05–40 foundation catalog after the roadmap compatibility surfaces were registered. The primitive tools, full-visibility reads/search/indexing, paging, Codex tunnel/stdIO route, and additive runtime contracts remain available; future optimization must preserve that contract without silently reducing accessible context.
