# LNWJING Watcher API

LNWJING v5.6.0 introduced the local read-only runtime surface used by the separate **LNWJING Watcher** Web/PWA, Android, and iOS client. v5.6.1 added multiple projects and goals. v5.6.6 adds truthful Goal completion readiness and configured MCP plugin names without changing Protocol v1.

## What starts with Desktop

When LNWJING Desktop starts, it also starts two loopback listeners:

| Purpose | Default | Exposure |
| --- | --- | --- |
| Watcher API | `http://127.0.0.1:17890` | May be placed behind an HTTPS tunnel/reverse proxy |
| Local pairing | `http://127.0.0.1:17891/api/v1/pair` | **Loopback only — never publish this port** |

Override the ports only when needed:

```text
LNWJING_WATCHER_PORT
LNWJING_WATCHER_PAIR_PORT
```

The Watcher listeners are independent from the MCP command surface.

## Pair a Watcher client

On the machine running LNWJING Desktop, open:

```text
http://127.0.0.1:17891/api/v1/pair
```

The local-only response contains:

- `protocolVersion`
- local Watcher `endpoint`
- the dedicated Watcher access `token`

Keep the token private. In production Desktop it is persisted through LNWJING's protected secret provider and is separate from MCP, tunnel, and OAuth credentials.

For same-machine use, enter the returned endpoint and token directly in Watcher. Watcher v0.2.4+ keeps the token on that device for up to one year, then asks the user to check Settings and pair again. The Android inactivity reminder, when enabled, keeps a separate encrypted copy in Android Keystore protected storage and removes it when monitoring is disabled or the token expires.

For phone/remote use, expose **only port 17890** through zrok, Cloudflare Tunnel, Tailscale Serve/Funnel, ngrok, or your own HTTPS reverse proxy. Then enter the resulting HTTPS URL together with the same Watcher token in the Watcher app.

## Protocol v1

### Snapshot

```http
GET /api/v1/snapshot
Authorization: Bearer <watcher-token>
```

The response is intentionally bounded and sanitized:

- runtime version/health and total observable in-flight operation count
- stable instance id, hostname, platform
- `workspaces[]`: every Active Project, each with its active Durable Goals (up to 50 per project), active-operation count, and sanitized Git state
- workspace-tagged observable agents/workers and activity where the runtime knows the workspace
- configured MCP server names and their enabled/connected/excluded/lifecycle state in `plugins[]`; launch commands, config paths, and credentials are omitted
- recent observable activity across all Active Projects
- compatibility `goal` and `git` fields for the selected/primary project so older Protocol v1 clients continue to work
- server timestamp

Watcher does not return raw environment variables, provider credentials, MCP secrets, file contents, or hidden model reasoning.

From v5.6.6, each active Goal also reports `lifecycle: "active"`, `completionReady`, `objective`, `currentPhase`, sanitized acceptance-criterion titles/statuses, `activeTaskCount`, `createdAt`, `updatedAt`, and `lastCheckpointAt`. A Goal with completed milestones and acceptance criteria is **ready for explicit finalization**; it remains open until `finish_goal` makes the durable record terminal. An open Goal no longer makes the runtime or orchestrator appear to be executing when there is no observable in-flight operation. Older Protocol v1 clients can ignore these additive fields.

### Realtime events

Connect to:

```text
ws://127.0.0.1:17890/api/v1/events
```

or the corresponding `wss://` URL through an HTTPS tunnel.

Immediately after the socket opens, send:

```json
{"type":"auth","token":"<watcher-token>"}
```

Unauthenticated sockets are closed after a short bounded timeout. After valid authentication the runtime sends `{ "type": "ready", "protocolVersion": 1 }`; the client treats realtime as connected only after this acknowledgement, so an invalid token cannot briefly appear as a healthy live connection. Authorized clients then receive structured observable activity events and heartbeat pings keep the connection detectable.

The companion Watcher client re-synchronizes the full snapshot after reconnect and after live activity so Goal/Agent/Git state stays authoritative, while still rendering the event immediately. It uses a 5-second snapshot fallback while realtime is unavailable.

## Security boundary

Watcher v1 is **read-only**.

It does not expose:

- shell/process execution
- file writes/deletes
- MCP mutation calls
- approval actions
- pause/resume
- OAuth or tunnel credentials
- hidden chain-of-thought

Authentication uses a dedicated random Watcher bearer token. Production Desktop protects the persisted token with the same purpose-bound secret protection system used for other sensitive local state. Token comparisons use constant-time comparison where lengths match.

The pairing listener is deliberately separate and bound only to loopback. Do not reverse-proxy or tunnel port 17891.

## Remote access

The Watcher repository contains user-facing setup guides and helper scripts for:

- Local/LAN
- zrok
- Cloudflare Tunnel
- Tailscale Serve
- Tailscale Funnel
- ngrok
- Custom HTTPS

Remote providers forward to the local Watcher API only. They never need to expose the LNWJING MCP gateway.

## Troubleshooting

**Watcher shows 401 / Unauthorized**

Re-pair locally and make sure the Watcher client is using the current dedicated token.

**WebSocket reconnects but snapshots work**

Confirm your tunnel/reverse proxy forwards WebSocket upgrades for `/api/v1/events`.

**Port 17890 is already in use**

Set `LNWJING_WATCHER_PORT` before launching Desktop and use the new local origin in your tunnel configuration.

**Do I expose 17891 too?**

No. Pairing remains loopback-only by design.
