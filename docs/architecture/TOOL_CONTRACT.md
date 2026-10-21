# lnwjing tool contract

Status: God-Tier Wave 0–8 additive contract snapshot synchronized for `v5.8.7`.

This is the compatibility contract for the current MCP surface. The runtime
advertises the JSON Schema for every input through `tools/list`; the TypeScript
Zod schemas in `packages/mcp-server/src/tools/` are the implementation source
of truth. The existing human-oriented catalog remains useful for field details,
while this document records the primitive/core contract, preserves the earlier
compatibility baseline, and records policy class, annotations, and schema source.
The historical v4 inventory contained 233 tool definitions. The current runtime contains 286 definitions, advertises 274 through `tools/list` by default, and advertises all 286 when Codex delegation plus Agent Swarm is enabled. Those 12 Codex/Agent Swarm definitions are opt-in; every other current first-party definition remains available through the default catalog and reports dependency/setup state truthfully at runtime. The additive v4 entries are defined
in `packages/mcp-server/src/upgrade-catalog.ts` and the exact runtime order is
verified by `packages/mcp-server/src/tool-registry.test.ts`.

Desktop readiness is a separate presentation contract built from the same live definitions. Main-process requirement probes are read-only, timeout-bounded, cached, and shared by the Tools catalog and structured Doctor report. Readiness never grants permission or bypasses workspace/command policy. External MCP descriptors remain a separate origin: a successful connection plus `tools/list` discovery establishes transport/catalog readiness only, while child-server permission/profile classification, cancellation, dry-run, and other semantics remain undeclared/unverified when the server does not publish them.

**Effective exposure boundary (v4.54.0):** First-party tool exposure is resolved independently from readiness and permission using persisted per-tool intent plus canonical Settings/runtime eligibility and default exposure. Hard Settings/runtime prerequisites are authoritative: a persisted `enabled` override cannot bypass a disabled family gate, missing provider, unsupported platform, or other system-ineligible state. `codex_*` and `agent_swarm_run`, for example, remain effectively hidden until Codex Delegation and the required runtime/provider make that family eligible. `ToolRegistry.listAll()` always remains the recovery-safe canonical inventory; `ToolRegistry.list()`, new `invoke()` calls, `tool_batch` children, and tool discovery/ranking/describe surfaces apply `effectiveExposed`. Disabling a tool blocks new execution but does not cancel a call that already crossed the registry boundary. Long-lived MCP servers keep canonical SDK registrations and toggle `RegisteredTool.enable()/disable()` handles so `notifications/tools/list_changed` is emitted for meaningful list transitions. Desktop and direct stdio share persisted availability state, while external MCP child tools retain their own control plane.

**Native Ponytail correctness boundary (v4.60.0):** Ponytail policy is optional and defaults to OFF. Effective mode resolves `Current Goal > Workspace > Global`, with `lite`, `full`, and `ultra` treated as active. Before a coding mutation crosses the central `ToolRegistry.invoke()` boundary, an active policy requires a successful exact load of `bundled:agent-skills/ponytail` for the current session/workspace/goal policy fingerprint. `skill_match`, skill listing, similarly named workspace/user skills, and instruction text do not satisfy activation. A failed or zero-result matcher therefore cannot disable the direct exact-load path. Successful code mutations advance a review generation; FULL/ULTRA durable coding goals cannot complete until exact bundled `ponytail-review` plus the latest `review_changes` satisfies that generation. A later code mutation makes the review stale again. `tool_batch` children re-enter the same registry gate. Full Bypass does not bypass this correctness policy; explicit `ponytail_session` suppression is session-scoped and does not rewrite persisted Global/Workspace/Goal policy.

**ChatGPT host-sync boundary:** MCP list-change notification proves only that the MCP server offered a different list. It is not proof that an approved ChatGPT app/action snapshot was refreshed. ChatGPT-specific guidance is conditional and must never promise that browser F5 alone updates a frozen/approved host snapshot.

Native host support is governed by [`PLATFORM_SUPPORT.md`](PLATFORM_SUPPORT.md).
That matrix is authoritative for platform disposition, bundled
`tunnel-client` artifacts, permission/dependency gates, and explicit
`unsupported_platform` behavior for WSL, Windows Registry, Windows Sandbox, and
other Windows-only operations. A foreign provider must not be instantiated and
allowed to fail later.

**Active Workspace Set boundary:** Primary/Selected Project is only the default. Every tool may target any registered workspace currently in the host Active Projects set. When an input contains an absolute path/cwd/database target/native path that belongs to another active root, the registry routes the effective `workspaceId` to the most-specific matching active workspace before policy and handler dispatch. Targets outside the active set remain guarded; one call is not allowed to silently span multiple active roots.

**Managed-browser target boundary:** page-targeted `dom_cdp` work is fail-closed and ID-pinned. The caller must first `list_tabs`, select the intended exact returned ID after inspecting URL/title, or create a safe target with `new_tab`; every target-scoped action and `steps` batch then carries that same top-level `tab_id`. A missing/closed ID is an error, never permission to select the first or OS-active tab. Native address-bar typing is not a browser-navigation fallback. Mutating a ChatGPT tab additionally requires both `allow_protected_tab_action: true` and real `userConfirmed: true`; Full Bypass does not satisfy that explicit-user condition.

**Native automation ownership boundary (v5.4.0):** the six `automation_*` tools are an execution layer beneath an existing Durable Goal, not an independent scheduler. Creation and every mutation require the current Goal lease, the stored root `goalId`, matching actor/workspace ownership, and revision compare-and-swap. Full Bypass may skip ordinary application authorization, but it never skips this live Goal ownership fence. Only the `shell` provider is implemented; `process` and `codex` are unsupported rather than advertised as planned-working providers. An uncertain launch is persisted as `dispatched_unresolved` and must be observed; a new attempt is allowed only after exact absence is proven. Automation reuses the Goal's one existing hourly recurring Native ChatGPT scheduled continuation and never creates or retimes a schedule itself.

<!-- BEGIN GENERATED TOOL REGISTRY -->
## Generated live ToolRegistry index

This complete inventory is generated from `ToolRegistry.listAll()`: **294 total tool definitions**. The runtime advertises **282 tools by default** and **294 tools when Codex delegation plus Agent Swarm is enabled** through `tools/list`.
Run `pnpm docs:tools` after intentionally changing the registry; CI runs `pnpm docs:tools:check` and fails on drift.

| # | Tool | Permission | Advertised | Delivery | Runtime evidence | Read-only | Destructive |
| ---: | --- | --- | --- | --- | --- | :---: | :---: |
| 1 | `workspace_list` | READ | default | operational | service_dispatch | yes | no |
| 2 | `workspace_path_preflight` | READ | default | operational | service_dispatch | yes | no |
| 3 | `workspace_writer_lease_acquire` | WRITE | default | operational | service_dispatch | no | no |
| 4 | `workspace_writer_lease_status` | READ | default | operational | service_dispatch | yes | no |
| 5 | `workspace_writer_lease_renew` | WRITE | default | operational | service_dispatch | no | no |
| 6 | `workspace_writer_lease_release` | WRITE | default | operational | service_dispatch | no | no |
| 7 | `workspace_register` | WRITE | default | operational | service_dispatch | no | no |
| 8 | `workspace_info` | READ | default | operational | service_dispatch | yes | no |
| 9 | `workspace_tree` | READ | default | operational | service_dispatch | yes | no |
| 10 | `project_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 11 | `engineering_prepare_task` | READ | default | operational | service_dispatch | yes | no |
| 12 | `engineering_start_task` | WRITE | default | operational | service_dispatch | no | no |
| 13 | `engineering_get_status` | READ | default | operational | service_dispatch | yes | no |
| 14 | `read_file` | READ | default | operational | service_dispatch | yes | no |
| 15 | `read_files` | READ | default | operational | service_dispatch | yes | no |
| 16 | `search_files` | READ | default | operational | service_dispatch | yes | no |
| 17 | `search_text` | READ | default | operational | service_dispatch | yes | no |
| 18 | `git_status` | READ | default | operational | service_dispatch | yes | no |
| 19 | `git_diff` | READ | default | operational | service_dispatch | yes | no |
| 20 | `git_log` | READ | default | operational | service_dispatch | yes | no |
| 21 | `git_clone_safe` | EXECUTE | default | operational | service_dispatch | no | yes |
| 22 | `git_clone_status` | READ | default | operational | service_dispatch | yes | no |
| 23 | `git_clone_cancel` | EXECUTE | default | operational | service_dispatch | no | no |
| 24 | `git` | EXECUTE | default | operational | service_dispatch | no | yes |
| 25 | `write_file` | WRITE | default | operational | service_dispatch | no | no |
| 26 | `apply_patch` | WRITE | default | operational | service_dispatch | no | no |
| 27 | `edit_file` | WRITE | default | operational | service_dispatch | no | no |
| 28 | `move_file` | WRITE | default | operational | service_dispatch | no | no |
| 29 | `copy_file` | WRITE | default | operational | service_dispatch | no | no |
| 30 | `delete_file` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 31 | `list_recovery_items` | READ | default | operational | service_dispatch | yes | no |
| 32 | `restore_deleted_file` | WRITE | default | operational | service_dispatch | no | no |
| 33 | `list_checkpoints` | READ | default | operational | service_dispatch | yes | no |
| 34 | `restore_checkpoint` | WRITE | default | operational | service_dispatch | no | yes |
| 35 | `process_start` | EXECUTE | default | operational | service_dispatch | no | no |
| 36 | `process_list` | READ | default | operational | service_dispatch | yes | no |
| 37 | `process_status` | READ | default | operational | service_dispatch | yes | no |
| 38 | `process_logs` | READ | default | operational | service_dispatch | yes | no |
| 39 | `process_stop` | EXECUTE | default | operational | service_dispatch | no | no |
| 40 | `project_dev` | EXECUTE | default | operational | service_dispatch | no | no |
| 41 | `project_test` | EXECUTE | default | operational | service_dispatch | no | no |
| 42 | `project_lint` | EXECUTE | default | operational | service_dispatch | no | no |
| 43 | `project_typecheck` | EXECUTE | default | operational | service_dispatch | no | no |
| 44 | `project_build` | EXECUTE | default | operational | service_dispatch | no | no |
| 45 | `codex_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 46 | `codex_run` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 47 | `codex_task_list` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 48 | `codex_task_status` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 49 | `codex_task_logs` | READ | Codex opt-in | operational | service_dispatch | yes | no |
| 50 | `codex_stop` | EXECUTE | Codex opt-in | operational | service_dispatch | no | no |
| 51 | `agent_swarm_run` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | no | no |
| 52 | `shell` | EXECUTE | default | operational | service_dispatch | no | yes |
| 53 | `dom_cdp` | READ | default | operational | service_dispatch | no | yes |
| 54 | `computer_use` | EXECUTE | default | operational | service_dispatch | no | yes |
| 55 | `accessibility` | READ | default | operational | service_dispatch | no | yes |
| 56 | `input_event` | EXECUTE | default | operational | service_dispatch | no | yes |
| 57 | `vision` | READ | default | operational | service_dispatch | yes | no |
| 58 | `vision_annotated_capture` | READ | default | operational | service_dispatch | yes | no |
| 59 | `ui_target_action` | EXECUTE | default | operational | service_dispatch | no | yes |
| 60 | `window` | EXECUTE | default | operational | service_dispatch | no | yes |
| 61 | `health` | READ | default | operational | service_dispatch | yes | no |
| 62 | `system_info` | READ | default | operational | service_dispatch | yes | no |
| 63 | `notification` | EXECUTE | default | operational | service_dispatch | no | no |
| 64 | `file_dialog` | EXECUTE | default | operational | service_dispatch | yes | no |
| 65 | `clipboard` | EXECUTE | default | operational | service_dispatch | no | no |
| 66 | `web_fetch` | READ | default | operational | service_dispatch | no | yes |
| 67 | `audio` | EXECUTE | default | operational | service_dispatch | no | yes |
| 68 | `screen_record` | EXECUTE | default | operational | service_dispatch | no | yes |
| 69 | `office` | WRITE | default | operational | service_dispatch | no | no |
| 70 | `scheduler` | EXECUTE | default | operational | service_dispatch | no | yes |
| 71 | `wsl_exec` | EXECUTE | default | operational | service_dispatch | no | yes |
| 72 | `wsl_fs` | READ | default | operational | service_dispatch | yes | no |
| 73 | `skills_list` | READ | default | operational | service_dispatch | yes | no |
| 74 | `skills_read` | READ | default | operational | service_dispatch | yes | no |
| 75 | `ponytail_session` | WRITE | default | operational | service_dispatch | no | no |
| 76 | `mcp_list` | READ | default | operational | service_dispatch | yes | no |
| 77 | `mcp_describe` | READ | default | operational | service_dispatch | yes | no |
| 78 | `mcp_call` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 79 | `workspace_context` | READ | default | operational | service_dispatch | yes | no |
| 80 | `workspace_context_continue` | READ | default | operational | service_dispatch | yes | no |
| 81 | `workspace_full_scan` | READ | default | operational | service_dispatch | yes | no |
| 82 | `workspace_full_scan_continue` | READ | default | operational | deterministic_operation | yes | no |
| 83 | `workspace_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 84 | `search_all` | READ | default | operational | service_dispatch | yes | no |
| 85 | `read_many_files` | READ | default | operational | service_dispatch | yes | no |
| 86 | `read_file_page` | READ | default | operational | service_dispatch | yes | no |
| 87 | `read_file_page_continue` | READ | default | operational | service_dispatch | yes | no |
| 88 | `workspace_index` | WRITE | default | operational | service_dispatch | no | no |
| 89 | `workspace_index_status` | READ | default | operational | service_dispatch | yes | no |
| 90 | `workspace_index_watch` | WRITE | default | operational | service_dispatch | no | no |
| 91 | `workspace_index_stop` | WRITE | default | operational | service_dispatch | no | no |
| 92 | `session_handoff` | READ | default | operational | service_dispatch | yes | no |
| 93 | `verify_incremental` | EXECUTE | default | operational | service_dispatch | no | no |
| 94 | `run_goal` | WRITE | default | operational | service_dispatch | no | no |
| 95 | `get_goal` | READ | default | operational | service_dispatch | yes | no |
| 96 | `get_goal_plan` | READ | default | operational | service_dispatch | yes | no |
| 97 | `update_goal_plan` | WRITE | default | operational | service_dispatch | no | no |
| 98 | `update_goal_acceptance` | WRITE | default | operational | service_dispatch | no | no |
| 99 | `revise_goal_intent` | WRITE | default | operational | service_dispatch | no | no |
| 100 | `create_context_capsule` | WRITE | default | operational | service_dispatch | no | no |
| 101 | `get_context_capsule` | READ | default | operational | service_dispatch | yes | no |
| 102 | `list_context_capsules` | READ | default | operational | service_dispatch | yes | no |
| 103 | `context_pressure` | READ | default | operational | service_dispatch | yes | no |
| 104 | `record_delivery_receipt` | WRITE | default | operational | service_dispatch | no | no |
| 105 | `list_delivery_receipts` | READ | default | operational | service_dispatch | yes | no |
| 106 | `advance_goal_iteration` | WRITE | default | operational | service_dispatch | no | no |
| 107 | `checkpoint_goal` | WRITE | default | operational | service_dispatch | no | no |
| 108 | `checkpoint_goal_engineering` | WRITE | default | operational | service_dispatch | no | no |
| 109 | `finish_goal` | WRITE | default | operational | service_dispatch | no | no |
| 110 | `cancel_goal` | WRITE | default | operational | service_dispatch | no | yes |
| 111 | `reconcile_goals` | WRITE | default | operational | service_dispatch | no | no |
| 112 | `list_goals` | READ | default | operational | service_dispatch | yes | no |
| 113 | `resource_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 114 | `call_history` | READ | default | operational | service_dispatch | yes | no |
| 115 | `goal_result` | READ | default | operational | service_dispatch | yes | no |
| 116 | `workflow_templates` | READ | default | operational | service_dispatch | yes | no |
| 117 | `workflow_prepare` | READ | default | operational | service_dispatch | yes | no |
| 118 | `workflow_start` | WRITE | default | operational | service_dispatch | no | no |
| 119 | `prepare_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 120 | `record_scheduled_continuation_receipt` | WRITE | default | operational | service_dispatch | no | no |
| 121 | `claim_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 122 | `get_scheduled_continuation` | READ | default | operational | service_dispatch | yes | no |
| 123 | `expedite_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | no |
| 124 | `cancel_scheduled_continuation` | WRITE | default | operational | service_dispatch | no | yes |
| 125 | `symbol_search` | READ | default | operational | service_dispatch | yes | no |
| 126 | `find_definition` | READ | default | operational | service_dispatch | yes | no |
| 127 | `find_references` | READ | default | operational | service_dispatch | yes | no |
| 128 | `find_implementations` | READ | default | operational | service_dispatch | yes | no |
| 129 | `call_hierarchy` | READ | default | operational | service_dispatch | yes | no |
| 130 | `import_graph` | READ | default | operational | service_dispatch | yes | no |
| 131 | `dependency_graph` | READ | default | operational | service_dispatch | yes | no |
| 132 | `module_graph` | READ | default | operational | service_dispatch | yes | no |
| 133 | `type_search` | READ | default | operational | service_dispatch | yes | no |
| 134 | `trace_symbol` | READ | default | operational | service_dispatch | yes | no |
| 135 | `context_ranking` | READ | default | operational | deterministic_operation | yes | no |
| 136 | `debug_context` | READ | default | operational | service_dispatch | yes | no |
| 137 | `review_context` | READ | default | operational | service_dispatch | yes | no |
| 138 | `change_context` | READ | default | operational | service_dispatch | yes | no |
| 139 | `symbol_context` | READ | default | operational | service_dispatch | yes | no |
| 140 | `test_context` | READ | default | operational | service_dispatch | yes | no |
| 141 | `dependency_context` | READ | default | operational | service_dispatch | yes | no |
| 142 | `git_context` | READ | default | operational | service_dispatch | yes | no |
| 143 | `frontend_context` | READ | default | operational | service_dispatch | yes | no |
| 144 | `backend_context` | READ | default | operational | service_dispatch | yes | no |
| 145 | `route_intent` | READ | default | operational | deterministic_operation | yes | no |
| 146 | `recipe_list` | READ | default | operational | deterministic_operation | yes | no |
| 147 | `recipe_describe` | READ | default | operational | deterministic_operation | yes | no |
| 148 | `recipe_run` | EXECUTE | default | operational | deterministic_operation | no | no |
| 149 | `dry_run` | READ | default | operational | deterministic_operation | yes | no |
| 150 | `review_changes` | READ | default | operational | service_dispatch | yes | no |
| 151 | `changed_symbols` | READ | default | operational | service_dispatch | yes | no |
| 152 | `affected_modules` | READ | default | operational | service_dispatch | yes | no |
| 153 | `git_history_context` | READ | default | operational | service_dispatch | yes | no |
| 154 | `git_blame_context` | READ | default | operational | service_dispatch | yes | no |
| 155 | `discover_tests` | READ | default | operational | service_dispatch | yes | no |
| 156 | `run_affected_tests` | EXECUTE | default | operational | service_dispatch | no | no |
| 157 | `test_failures` | READ | default | operational | service_dispatch | yes | no |
| 158 | `coverage_context` | READ | default | operational | service_dispatch | yes | no |
| 159 | `test_history` | READ | default | operational | service_dispatch | yes | no |
| 160 | `cache_stats` | READ | default | operational | deterministic_operation | yes | no |
| 161 | `cache_clear` | WRITE | default | operational | deterministic_operation | no | no |
| 162 | `cache_invalidate` | WRITE | default | operational | deterministic_operation | no | no |
| 163 | `hook_list` | READ | default | operational | deterministic_operation | yes | no |
| 164 | `hook_register` | WRITE | default | operational | deterministic_operation | no | no |
| 165 | `hook_remove` | WRITE | default | operational | deterministic_operation | no | no |
| 166 | `skill_match` | READ | default | operational | service_dispatch | yes | no |
| 167 | `skill_load` | READ | default | operational | service_dispatch | yes | no |
| 168 | `plugin_install` | WRITE | default | operational | truthful_unavailable | no | no |
| 169 | `plugin_list` | READ | default | operational | deterministic_operation | yes | no |
| 170 | `plugin_enable` | WRITE | default | operational | truthful_unavailable | no | no |
| 171 | `plugin_disable` | WRITE | default | operational | truthful_unavailable | no | no |
| 172 | `plugin_remove` | DANGEROUS | default | operational | truthful_unavailable | no | yes |
| 173 | `session_context` | READ | default | operational | deterministic_operation | yes | no |
| 174 | `session_checkpoint` | WRITE | default | operational | deterministic_operation | no | no |
| 175 | `session_resume` | READ | default | operational | deterministic_operation | yes | no |
| 176 | `session_history` | READ | default | operational | deterministic_operation | yes | no |
| 177 | `response_mode` | READ | default | operational | deterministic_operation | yes | no |
| 178 | `inspect_web_app` | READ | default | operational | service_dispatch | yes | no |
| 179 | `debug_ui` | READ | default | operational | service_dispatch | yes | no |
| 180 | `capture_ui_state` | READ | default | operational | service_dispatch | yes | no |
| 181 | `form_context` | READ | default | operational | service_dispatch | yes | no |
| 182 | `network_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 183 | `console_context` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 184 | `browser_debug_context` | READ | default | operational | service_dispatch | yes | no |
| 185 | `windows_environment` | READ | default | dependency_gated | service_dispatch | yes | no |
| 186 | `service_context` | READ | default | operational | deterministic_operation | yes | no |
| 187 | `process_context` | READ | default | operational | service_dispatch | yes | no |
| 188 | `port_context` | READ | default | operational | deterministic_operation | yes | no |
| 189 | `registry_context` | READ | default | dependency_gated | deterministic_operation | yes | no |
| 190 | `event_log_context` | READ | default | operational | deterministic_operation | yes | no |
| 191 | `installed_runtime_context` | READ | default | operational | deterministic_operation | yes | no |
| 192 | `path_context` | READ | default | operational | deterministic_operation | yes | no |
| 193 | `startup_context` | READ | default | operational | deterministic_operation | yes | no |
| 194 | `mcp_discover` | READ | default | operational | service_dispatch | yes | no |
| 195 | `mcp_health` | READ | default | operational | service_dispatch | yes | no |
| 196 | `mcp_resources` | READ | default | dependency_gated | service_dispatch | yes | no |
| 197 | `task_create` | EXECUTE | default | operational | service_dispatch | no | no |
| 198 | `task_status` | READ | default | operational | service_dispatch | yes | no |
| 199 | `task_cancel` | EXECUTE | default | operational | service_dispatch | no | no |
| 200 | `task_result` | READ | default | operational | service_dispatch | yes | no |
| 201 | `task_list` | READ | default | operational | service_dispatch | yes | no |
| 202 | `delegate` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | no | no |
| 203 | `delegate_status` | READ | Codex opt-in | dependency_gated | service_dispatch | yes | no |
| 204 | `delegate_cancel` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | no | no |
| 205 | `delegate_result` | READ | Codex opt-in | dependency_gated | service_dispatch | yes | no |
| 206 | `parallel_delegate` | EXECUTE | Codex opt-in | dependency_gated | service_dispatch | no | no |
| 207 | `permission_check` | READ | default | operational | deterministic_operation | yes | no |
| 208 | `permission_profile` | READ | default | operational | deterministic_operation | yes | no |
| 209 | `live_logs_query` | READ | default | operational | truthful_unavailable | yes | no |
| 210 | `live_logs_status` | READ | default | operational | truthful_unavailable | yes | no |
| 211 | `telemetry_dashboard` | READ | default | operational | deterministic_operation | yes | no |
| 212 | `context_economy_stats` | READ | default | operational | deterministic_operation | yes | no |
| 213 | `execution_plan` | READ | default | operational | deterministic_operation | yes | no |
| 214 | `repo_map` | READ | default | operational | service_dispatch | yes | no |
| 215 | `context_expand` | READ | default | operational | service_dispatch | yes | no |
| 216 | `recovery_status` | READ | default | operational | service_dispatch | yes | no |
| 217 | `tool_schema_list` | READ | default | operational | deterministic_operation | yes | no |
| 218 | `tool_schema_register` | WRITE | default | operational | deterministic_operation | no | no |
| 219 | `capabilities` | READ | default | operational | deterministic_operation | yes | no |
| 220 | `tool_search` | READ | default | operational | deterministic_operation | yes | no |
| 221 | `tool_dynamic_filter` | READ | default | operational | deterministic_operation | yes | no |
| 222 | `tool_describe` | READ | default | operational | deterministic_operation | yes | no |
| 223 | `tool_categories` | READ | default | operational | deterministic_operation | yes | no |
| 224 | `tool_function_find` | READ | default | operational | deterministic_operation | yes | no |
| 225 | `tool_aliases` | READ | default | operational | deterministic_operation | yes | no |
| 226 | `mcp_hub` | READ | default | dependency_gated | service_dispatch | yes | no |
| 227 | `dev_context` | READ | default | operational | service_dispatch | yes | no |
| 228 | `recipe_catalog` | READ | default | operational | deterministic_operation | yes | no |
| 229 | `capture_screenshot` | READ | default | operational | service_dispatch | yes | no |
| 230 | `compare_screenshot` | READ | default | operational | deterministic_operation | yes | no |
| 231 | `dom_snapshot` | READ | default | operational | service_dispatch | yes | no |
| 232 | `layout_metadata` | READ | default | operational | service_dispatch | yes | no |
| 233 | `visual_context` | READ | default | operational | service_dispatch | yes | no |
| 234 | `inspect_workbook` | READ | default | operational | service_dispatch | yes | no |
| 235 | `compare_workbook_layout` | READ | default | dependency_gated | service_dispatch | yes | no |
| 236 | `render_excel_preview` | READ | default | dependency_gated | service_dispatch | yes | no |
| 237 | `inspect_pdf` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 238 | `compare_pdf_pages` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 239 | `project_profile_get` | READ | default | operational | service_dispatch | yes | no |
| 240 | `project_profile_set` | WRITE | default | operational | deterministic_operation | no | no |
| 241 | `handoff_context` | READ | default | operational | service_dispatch | yes | no |
| 242 | `benchmark_run` | EXECUTE | default | dependency_gated | service_dispatch | no | no |
| 243 | `regression_report` | READ | default | operational | deterministic_operation | yes | no |
| 244 | `sandbox_exec` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 245 | `event_watch` | EXECUTE | default | dependency_gated | deterministic_operation | no | no |
| 246 | `crash_trace` | READ | default | dependency_gated | deterministic_operation | yes | no |
| 247 | `lsp_diagnostics` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 248 | `lsp_rename` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 249 | `debug_attach` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 250 | `debug_step` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 251 | `git_worktree_spawn` | WRITE | default | dependency_gated | deterministic_operation | no | no |
| 252 | `git_worktree_remove` | DANGEROUS | default | dependency_gated | deterministic_operation | no | yes |
| 253 | `db_inspect` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 254 | `db_query` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 255 | `office_ppt` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 256 | `office_status` | READ | default | operational | service_dispatch | yes | no |
| 257 | `office_word` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 258 | `office_excel` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 259 | `office_powerpoint` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 260 | `office_outlook` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 261 | `office_calendar` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 262 | `office_contacts` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 263 | `office_tasks` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 264 | `office_onenote` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 265 | `office_onedrive` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 266 | `office_sharepoint` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 267 | `office_teams` | WRITE | default | dependency_gated | truthful_unavailable | no | no |
| 268 | `office_access` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 269 | `office_visio` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 270 | `office_project` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 271 | `office_publisher` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 272 | `office_convert` | WRITE | default | dependency_gated | deterministic_operation | no | no |
| 273 | `office_batch` | WRITE | default | dependency_gated | deterministic_operation | no | no |
| 274 | `pdf_extract_tables` | READ | default | dependency_gated | truthful_unavailable | yes | no |
| 275 | `docx_merge` | WRITE | default | dependency_gated | service_dispatch | no | no |
| 276 | `self_heal_plan` | READ | default | operational | service_dispatch | yes | no |
| 277 | `self_heal_apply` | DANGEROUS | default | dependency_gated | service_dispatch | no | yes |
| 278 | `skills_import` | WRITE | default | operational | service_dispatch | no | no |
| 279 | `ecc_status` | READ | default | operational | deterministic_operation | yes | no |
| 280 | `ecc_catalog` | READ | default | operational | deterministic_operation | yes | no |
| 281 | `ecc_load` | READ | default | operational | truthful_unavailable | yes | no |
| 282 | `ecc_configure` | WRITE | default | operational | truthful_unavailable | no | no |
| 283 | `ecc_security_scan` | EXECUTE | default | dependency_gated | truthful_unavailable | no | no |
| 284 | `ecc_memory_save` | WRITE | default | operational | service_dispatch | no | no |
| 285 | `ecc_memory_search` | READ | default | operational | service_dispatch | yes | no |
| 286 | `ecc_memory_read` | READ | default | operational | service_dispatch | yes | no |
| 287 | `ecc_memory_doctor` | READ | default | operational | service_dispatch | yes | no |
| 288 | `tool_batch` | EXECUTE | default | operational | service_dispatch | no | yes |
| 289 | `automation_create` | WRITE | default | operational | service_dispatch | no | no |
| 290 | `automation_status` | READ | default | operational | service_dispatch | yes | no |
| 291 | `automation_events` | READ | default | operational | service_dispatch | yes | no |
| 292 | `automation_run` | EXECUTE | default | operational | service_dispatch | no | yes |
| 293 | `automation_control` | DANGEROUS | default | operational | service_dispatch | no | yes |
| 294 | `automation_finalize` | WRITE | default | operational | service_dispatch | no | yes |
<!-- END GENERATED TOOL REGISTRY -->

## Protocol and result rules

- Tool names and registry order are deterministic.
- Every request is schema-validated before the application service runs.
- Every result is structured JSON-compatible MCP content; errors use the
  repository error/result mapping and do not expose secrets or raw stack traces.
- `readOnlyHint` is advisory metadata for clients. It never grants permission.
- `destructiveHint` is advisory metadata for clients. In standard mode permission
  policy and application hard blocks remain authoritative; trusted Full Bypass
  intentionally skips those lnwjing checks.
- A bounded result must report truncation, continuation, or a bounded-window
  contract. A new compound tool cannot hide data that a primitive tool can read.
- `workspaceId` is required where the operation is workspace-scoped unless an
  explicitly normalized absolute path is accepted by that tool's schema.
- Automation events are append-only, redacted, actor/workspace scoped, and
  returned in bounded sequence pages. Raw task output remains in the owned shell
  task store rather than being copied into automation rows or events.

## Permission classes

| Class | Meaning | Existing profile behavior |
| --- | --- | --- |
| `READ` | No intentional mutation; inspection or local diagnostics | allowed by Safe/Balanced/Full |
| `WRITE` | Changes workspace files or registration state | prompts in Safe; allowed in Balanced/Full |
| `EXECUTE` | Starts/controls an owned command, process, project, or Codex task | prompts in Safe; allowed in Balanced/Full |
| `DANGEROUS` | Destructive, interactive, external, or full-access meta capability | denied in Safe; prompts in Balanced; allowed in Full subject to standard-mode policy, or dispatched without lnwjing approval when Full Bypass is ON |

Desktop uses its configured local permission profile. Packaged stdio keeps `full` as the backward-compatible default but accepts `safe|balanced|full|custom` through the launcher, environment, or Desktop STDIO policy settings. Desktop HTTP/Secure Tunnel and direct STDIO have independent Full Bypass toggles under the Full Access (Unrestricted) group; both default OFF and are effective only with profile `full`.

No mode scans or registers drive letters automatically. With Full Bypass OFF, optional strict-root mode constrains access to explicit canonical roots and the normal ownership/path/Active Project/host approval/command-policy boundaries remain enforced. With Full Bypass ON, the gateway and inner runtimes skip ordinary lnwjing application approval and scope checks, including always-confirm tools, protected paths, and explicit absolute outside paths. A live rolling scheduled-Goal mutation fence is different: workspace mutations and native automation mutations still require the exact current `goalLease` goal/token/generation proof so a stale worker cannot mutate after handoff. The authorization is carried separately from tool input and must never be forged as caller `userConfirmed: true`. Schema validation, relative-traversal rejection, exact task/process/worktree ownership, Windows ACL/UAC, provider availability, remote/child policy, and runtime errors remain.

Mutations still receive typed policy classification for audit/dispatch behavior. With Full Bypass OFF, the only configurable scoped auto-approval exception is exact recoverable `delete_file`; every other approval-required mutation needs independent trusted host exact-action approval and providerless runtimes fail closed. Full Bypass ON supersedes those lnwjing authorization checks for its transport. Arbitrary commands and project-owned scripts remain opaque execution, not an OS sandbox, and outside-project changes are not automatically recoverable through Recovery Trash.

## Core primitive runtime catalog

The generated live `ToolRegistry.listAll()` index above is the authoritative complete catalog for all **286 tool definitions**. It is generated from the built registry and checked in CI. This section intentionally does not maintain a second hand-numbered primitive table, because duplicate permission/schema tables can drift from the registry. The Zod schemas in `packages/mcp-server/src/tools/` and the generated table above remain the source of truth for names, permissions, annotations, ordering, and input JSON Schema; `tools/list` exposes only the currently advertised subset.

## Schema groups and contract examples

The following examples make the required shape explicit without duplicating the
generated JSON Schema. Optional fields and bounds must remain aligned with the
source schema and the runtime `tools/list` response.

### Workspace and filesystem

```ts
workspace_list: {}
workspace_register: {
  parentWorkspaceId?: string; // legacy explicit machine-root-relative registration
  path: string;
  displayName?: string;
}
workspace_info: { workspaceId: string }
workspace_tree: {
  workspaceId?: string;
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
}
project_snapshot: { workspaceId: string }
read_file: {
  workspaceId?: string;
  path: string;
  startLine?: number;
  endLine?: number;
}
read_files: { workspaceId?: string; files: Array<{ path: string; startLine?: number; endLine?: number }> }
search_files: { workspaceId?: string; path?: string; glob?: string; maxResults?: number; includeIgnored?: boolean }
search_text: {
  workspaceId?: string;
  path?: string;
  query: string;
  glob?: string;
  maxResults?: number;
  includeIgnored?: boolean;
}
```

`write_file`, `apply_patch`, `edit_file`, `move_file`, `copy_file`, `delete_file`,
`restore_deleted_file`, and `restore_checkpoint` retain their checkpoint/recovery,
same-workspace, secret-policy, confirmation, host-approval, and canonical
path-guard contracts. They must not acquire implicit recursive or arbitrary-root
mutation behavior.

### Git, process, project, and Codex

```ts
git_status: { workspaceId: string }
git_diff: { workspaceId: string; path?: string; staged?: boolean; maxBytes?: number }
git_log: { workspaceId: string; maxCommits?: number; maxBytes?: number }
git: { workspaceId?: string; cwd?: string; args: string[]; timeoutSeconds?: number }
process_start: { workspaceId: string; executable: string; args: string[]; cwd?: string; timeoutMs?: number }
process_list: { workspaceId: string }
process_status: { workspaceId: string; processId: string }
process_logs: { workspaceId: string; processId: string; tailLines?: number; sinceSequence?: number }
process_stop: { workspaceId: string; processId: string }
project_dev: { workspaceId: string }
project_test: { workspaceId: string }
project_lint: { workspaceId: string }
project_typecheck: { workspaceId: string }
project_build: { workspaceId: string }
codex_status: {}
codex_run: { workspaceId: string; instruction: string }
codex_task_list: { workspaceId: string }
codex_task_status: { workspaceId: string; codexTaskId: string }
codex_task_logs: { workspaceId: string; codexTaskId: string; tailLines?: number; sinceSequence?: number }
codex_stop: { workspaceId: string; codexTaskId: string }
```

Project tools take the workspace scope and use the detected project profile;
they do not accept arbitrary shell command strings. The gateway previews exact
executable/argv for approval and re-resolves immediately before spawn so a
changed command requires fresh approval.

### Native Goal automation

```ts
automation_create: {
  workspaceId: string;
  goalId: string;
  leaseToken: string;
  plan: {
    milestones: Array<{
      id: string;
      title: string;
      goalStepId: string;
      dependsOn: string[];
      provider: 'shell';
      role: 'blocking_job' | 'supporting_service';
      cancelWithGoal: boolean;
      dispatch: {
        executable: string;
        arguments: string[];
        cwd: string;
        timeoutSeconds: number;
        maxOutputBytes: number;
        includeStdout: boolean;
        includeStderr: boolean;
        windowsVerbatimArguments?: boolean;
      };
      verification: Array<
        | { id: string; kind: 'command_exit'; expectedExitCode: number }
        | { id: string; kind: 'file_sha256'; path: string; expectedSha256: string }
        | { id: string; kind: 'git_diff_check' }
      >;
    }>;
  };
}
automation_status: { workspaceId: string; runId: string }
automation_events: { workspaceId: string; runId: string; afterSequence?: number; limit?: number }
automation_run: { workspaceId: string; goalId: string; runId: string; leaseToken: string; expectedRevision: number; userConfirmed?: boolean }
automation_control: { workspaceId: string; goalId: string; runId: string; leaseToken: string; expectedRevision: number; action: 'pause' | 'resume' | 'cancel'; summary?: string; userConfirmed?: boolean }
automation_finalize: { workspaceId: string; goalId: string; runId: string; leaseToken: string; expectedRevision: number; userConfirmed?: boolean }
```

Plans contain 1–128 acyclic milestones; every milestone maps to an existing Goal
step and carries at least one verification requirement. There may be only one
non-terminal automation run per Goal. `automation_status` and
`automation_events` are read-only but still require matching actor/workspace
ownership. Mutation tools also require the current root Goal lease and exact
stored revision. `automation_run` advances to one deterministic dispatch,
observation, or verification boundary; callers continue with the returned
revision. The automation tools are deliberately ineligible for `tool_batch` so
lease, revision, and evidence decisions cannot be hidden inside generic batch
execution.

### Local capability and extension tools

The detailed action enums and bounds are defined in `schemas.ts` and the
capability backends. Important invariants are:

- `shell` receives an executable plus an argument array, never a composed shell
  string, and retains foreground/background, timeout, dry-run, and task actions;
- `dom_cdp`, `accessibility`, `input_event`, `window`, `audio`, `office`, and
  scheduler operations retain their existing interactive/destructive policy;
- `vision`, `health`, and `system_info` remain truthful read-only diagnostics;
- `web_fetch` remains HTTP(S)-only and bounded by explicit byte/timeout fields;
- `skills_*` and `mcp_*` remain bridge tools and do not silently flatten
  child-server tools into the 259-definition complete inventory; `mcp_list` and
  `mcp_describe` are read-only inspection while `mcp_call` is opaque mutation.
- `mcp_call` intentionally omits an outer MCP `outputSchema`: a conforming child
  may return valid text/image `content` without `structuredContent`. A fake
  structured result would misrepresent the child; direct calls and `tool_batch`
  must preserve original content and `isError`. Other lnwjing tools retain their
  declared structured output schemas.
- When lnwjing receives a host exact-action denial, MCP clients still see `PERMISSION_DENIED`. The error details distinguish `denialSource: host_approval_adapter` with `approvalState: unavailable` versus `denied_or_unverified`; activity/watch telemetry emits `HOST_APPROVAL_UNAVAILABLE` or `HOST_APPROVAL_DENIED_OR_UNVERIFIED` without logging tool arguments. An OpenAI safety rejection **before connector dispatch** is outside lnwjing's runtime and cannot create a local activity receipt or be bypassed by editing ChatGPT Project Instructions, changing connector display names, or retrying a privileged action. Diagnose the exact host error and continue only permitted actions.

The additive Windows gateway contract is:

```ts
wsl_exec: {
  workspaceId: string;
  distro?: string;
  executable?: string;
  arguments?: string[];
  cwd?: string;                 // registered absolute Windows path or absolute WSL path from wsl_fs
  environment?: Record<string, string>;
  operation?: 'run' | 'status' | 'wait' | 'logs' | 'result' | 'cancel';
  execution?: 'foreground' | 'background' | 'auto';
  task_id?: string;
}
wsl_fs: {
  workspaceId?: string;
  operation?: 'status' | 'translate' | 'metadata';
  direction?: 'windows_to_wsl' | 'wsl_to_windows';
  distro?: string;
  path?: string;
}
vision_annotated_capture: {
  workspaceId: string;
  capture?: 'display' | 'region' | 'window';
  max_depth?: number;
  max_marks?: number;
  ttl_seconds?: number;
}
ui_target_action: {
  workspaceId: string;
  observationId: string;
  markId: string;
  observationHash?: string;
  action?: 'click' | 'focus' | 'read_value' | 'set_value' | 'select_item' | 'menu_select';
  value?: string;
  userConfirmed?: boolean;
}
```

`wsl_exec` is argv-only and delegates task lifecycle to the existing bounded
shell runner. It records workspace ownership, rejects shell-string flags, and
does not expose arbitrary host paths. An absolute WSL `cwd` is normalized back
to its Windows workspace representation for scope checks, while the original
normalized WSL path is retained for `wsl.exe --cd`, so `wsl_fs` translation
output can be passed directly to `wsl_exec`. `wsl_fs` only translates paths or reads
metadata; it never opens raw `\\wsl$`/`\\wsl.localhost` files. A WSL status
failure is returned as `available: false`, not as a successful empty task.

SoM observations return `observationId`, `observationHash`, annotated PNG data,
`marks[]`, and `expiresAt`. `ui_target_action` checks owner, TTL, optional hash,
mark identity, and a fresh Accessibility lookup before forwarding an action.
Coordinates are screen-pixel metadata; action execution uses semantic element
identifiers so DPI and multi-monitor offsets do not become authorization.

`vision` keeps its existing public OCR action. WinRT OCR is routed to the
separate packaged-helper boundary and returns a truthful unavailable result when
package identity, a supported profile language, or the helper is absent. The
NSIS application remains the primary installer; sparse-package registration is
an optional release step.

The router adds `tool_dynamic_filter` and extends `tool_search`/`route_intent`
with ranked candidates, deterministic scores, reason codes, selected model,
permission metadata, and `authorizationUnchanged: true`. Local rerank is
opt-in; when no local model is configured it falls back to deterministic scoring
without sending prompt or file data off-machine.

### Context aggregation

```ts
workspace_context: {
  query: string;
  workspaceId?: string;
  path?: string;
  intent?: 'auto' | 'debug' | 'implement' | 'review' | 'trace' | 'explore';
  mode?: 'optimized' | 'full' | 'exhaustive';
  includeIgnored?: boolean;
  responseTargetBytes?: number;
  pageSize?: number;
}
workspace_context_continue: { continuationToken: string; pageSize?: number }
workspace_full_scan: { workspaceId?: string; path?: string; glob?: string; pageSize?: number; includeIgnored?: boolean }
workspace_full_scan_continue: { continuationToken: string; pageSize?: number }
workspace_snapshot: { workspaceId: string }
search_all: { query: string; workspaceId?: string; path?: string; glob?: string; maxResults?: number; includeIgnored?: boolean }
read_many_files: { workspaceId?: string; files: Array<{ path: string; startLine?: number; endLine?: number }> }
```

Context pages are transport windows, not capability limits. The engine keeps
continuation state and preserves the full primitive search/read tools.

`includeIgnored` is an explicit discovery override. Automatic mode is a quota
optimization, not authorization. `context_economy_stats` reports raw versus
delivered context bytes, skipped generated/binary paths, duplicate/previously
seen bytes avoided, ledger hits, and the bounded ledger size. The ledger is
in-memory and does not persist file contents or credentials.

### Lossless file paging

```ts
read_file_page: {
  workspaceId?: string;
  path: string;
  startLine?: number;
  pageSize?: number;
  responseTargetBytes?: number;
}
read_file_page_continue: { continuationToken: string; pageSize?: number }
```

Paged responses always expose whether more content remains. The page adapter
does not replace or reduce the existing unrestricted trusted-workspace read
path.

### Full-visibility indexing

```ts
workspace_index: { workspaceId: string; rebuild?: boolean; includeIgnored?: boolean }
workspace_index_status: { workspaceId: string }
workspace_index_watch: { workspaceId: string; debounceMs?: number; concurrency?: number }
workspace_index_stop: { workspaceId: string }
```

Index scheduling uses the automatic context-economy policy for vendor/build,
binary, and generated paths. It must not be treated as an access denial:
explicit index/search requests and direct file reads can still inspect any path
allowed by the existing workspace boundary, including hidden, ignored,
generated, dependency, and environment files.

### Roadmap extension catalog

The Phase 05–41 additive tools are defined in
[`../../packages/mcp-server/src/upgrade-catalog.ts`](../../packages/mcp-server/src/upgrade-catalog.ts).
Each entry carries its phase, permission class, tags, streamability, and
parallel-safety metadata. `tool_search` and `tool_describe` expose this metadata
without replacing the full `tools/list` contract.

### Compound execution

```ts
tool_batch: {
  parallel?: boolean;
  calls?: Array<{
    id?: string;
    tool: string;
    arguments?: Record<string, unknown>;
    dependsOn?: string[];
    timeoutMs?: number;
  }>;
  groups?: Array<{
    id?: string;
    parallel?: boolean;
    calls: Array<{
      id?: string;
      tool: string;
      arguments?: Record<string, unknown>;
      dependsOn?: string[];
      timeoutMs?: number;
    }>;
  }>;
}
```

The input contains at most 50 child calls. Results retain input order and
include per-child status, duration, error, and returned MCP response. Read-only
children can run in parallel; side-effecting children are serialized by the
early compound safety guard. Nested `tool_batch` calls are rejected, and every
child still traverses the normal registry confirmation/host-approval boundary;
a parent batch never grants mutation privilege to a child.

## Change protocol

Any tool contract change must include:

1. a schema/source change;
2. a registry/tool-list test asserting the tool remains discoverable;
3. permission and annotation assertions;
4. success and failure tests for the application behavior;
5. an audit/Live Logs assertion for new compound children or side effects;
6. a fresh benchmark or regression comparison when latency, bytes, or result
   shape can change;
7. an update to this file and `docs/mcp/MCP_TOOL_CATALOG.md`.

Adding a compound tool is additive. Removing or narrowing a primitive tool is a
breaking change and is outside this upgrade roadmap.
