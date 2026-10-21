use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

type NativeError = (&'static str, &'static str, bool);
const MAX_RESPONSE: u64 = 16 * 1024 * 1024;
const MAX_OWNERS: usize = 16;
const MAX_HANDLE_HISTORY: usize = 64;
const HELPER: &str = include_str!("desktop_session.py");
static SESSIONS: LazyLock<Mutex<BTreeMap<Owner, Helper>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Owner {
    client: String,
    session: String,
    workspace: Option<String>,
}

impl Owner {
    fn permits(&self, requester: &Self) -> bool {
        self.client == requester.client
            && self.session == requester.session
            && (requester.workspace.is_none() || self.workspace == requester.workspace)
    }
    fn read(input: &BTreeMap<String, String>) -> Result<Self, NativeError> {
        let field = |name: &str| input.get(&format!("metadata.lnwjing.taskOwner.v1.{name}"));
        let client = field("clientId");
        let session = field("sessionId");
        let workspace = field("workspaceId");
        if client.is_none() && session.is_none() && workspace.is_none() {
            return Ok(Self {
                client: "legacy".into(),
                session: "legacy".into(),
                workspace: None,
            });
        }
        let valid = |value: &String| {
            !value.trim().is_empty() && value.len() <= 256 && !value.contains('\0')
        };
        if !client.is_some_and(valid)
            || !session.is_some_and(valid)
            || workspace.is_some_and(|value| !valid(value))
        {
            return Err((
                "INVALID_INPUT",
                "Native media owner metadata is invalid",
                false,
            ));
        }
        Ok(Self {
            client: client.unwrap().clone(),
            session: session.unwrap().clone(),
            workspace: workspace.cloned(),
        })
    }
}

struct Helper {
    child: Child,
    stdin: ChildStdin,
    replies: mpsc::Receiver<Value>,
    handles: BTreeMap<String, HandleRecord>,
    last_seen: std::time::Instant,
}

struct HandleRecord {
    seen: std::time::Instant,
    active: bool,
}

fn track_handles(handles: &mut BTreeMap<String, HandleRecord>, value: &Value) {
    if let Some(released) = value.get("released_session_ids").and_then(Value::as_array) {
        for session in released.iter().filter_map(Value::as_str) {
            handles.remove(session);
        }
    }
    for name in ["handle", "session_id"] {
        let Some(handle) = value.get(name).and_then(Value::as_str) else {
            continue;
        };
        if name == "session_id"
            && (value.get("closed").and_then(Value::as_bool) == Some(true)
                || value.get("permissionState").and_then(Value::as_str) == Some("revoked"))
        {
            handles.remove(handle);
            continue;
        }
        let active = if name == "session_id" {
            true
        } else {
            value.get("state").and_then(Value::as_str) == Some("termination_unverified")
                || value.get("deliveryState").and_then(Value::as_str)
                    == Some("termination_unverified")
                || value.get("termination_verified").and_then(Value::as_bool) == Some(false)
                || value
                    .get("running")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| {
                        !matches!(
                            value.get("state").and_then(Value::as_str),
                            Some("completed" | "failed" | "cancelled" | "stopped")
                        )
                    })
        };
        handles.insert(
            handle.into(),
            HandleRecord {
                seen: std::time::Instant::now(),
                active,
            },
        );
    }
    prune_handles(handles);
}

fn prune_handles(handles: &mut BTreeMap<String, HandleRecord>) {
    handles.retain(|_, record| record.active || record.seen.elapsed() < Duration::from_secs(900));
    while handles.values().filter(|record| !record.active).count() > MAX_HANDLE_HISTORY {
        let oldest = handles
            .iter()
            .filter(|(_, record)| !record.active)
            .min_by_key(|(_, record)| record.seen)
            .map(|(handle, _)| handle.clone());
        if let Some(oldest) = oldest {
            handles.remove(&oldest);
        }
    }
}

impl Helper {
    fn spawn() -> Result<Self, NativeError> {
        Self::spawn_source(HELPER)
    }

    fn spawn_source(source: &str) -> Result<Self, NativeError> {
        let mut command = Command::new("python3");
        command
            .args(["-I", "-u", "-c", source])
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for name in [
            "PATH",
            "HOME",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_SESSION_TYPE",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
            "PULSE_SERVER",
            "PIPEWIRE_REMOTE",
            "GST_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().map_err(|_| {
            (
                "EXECUTABLE_NOT_FOUND",
                "Python 3 is required by the Linux desktop session provider",
                true,
            )
        })?;
        let stdin = child.stdin.take().ok_or((
            "INTERNAL_ERROR",
            "Desktop helper input pipe is missing",
            true,
        ))?;
        let stdout = child.stdout.take().ok_or((
            "INTERNAL_ERROR",
            "Desktop helper output pipe is missing",
            true,
        ))?;
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(MAX_RESPONSE + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line.len() as u64 > MAX_RESPONSE => break,
                    Ok(_) => {
                        let Ok(value) = serde_json::from_slice(&line) else {
                            break;
                        };
                        if sender.send(value).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            replies,
            handles: BTreeMap::new(),
            last_seen: std::time::Instant::now(),
        })
    }

    fn call(
        &mut self,
        operation: &str,
        action: &str,
        input: &BTreeMap<String, String>,
    ) -> Result<String, NativeError> {
        self.last_seen = std::time::Instant::now();
        let request = json!({"operation": operation, "action": action, "input": input});
        writeln!(self.stdin, "{request}")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| ("PROCESS_NOT_FOUND", "Desktop session helper stopped", true))?;
        let reply = self
            .replies
            .recv_timeout(Duration::from_secs(65))
            .map_err(|_| {
                (
                    "PROCESS_TIMEOUT",
                    "Desktop session request timed out or the helper stopped",
                    true,
                )
            })?;
        if reply.get("ok").and_then(Value::as_bool) == Some(true) {
            if let Some(value) = reply.get("value") {
                track_handles(&mut self.handles, value);
            }
            return reply.get("value").map(Value::to_string).ok_or((
                "INTERNAL_ERROR",
                "Desktop session helper returned an invalid response",
                true,
            ));
        }
        Err(match reply.pointer("/error/code").and_then(Value::as_str) {
            Some("INVALID_INPUT") => (
                "INVALID_INPUT",
                "Desktop session input or target is invalid",
                false,
            ),
            Some("PERMISSION_REQUIRED") => (
                "PERMISSION_REQUIRED",
                "Desktop consent was denied, revoked, or is required",
                true,
            ),
            Some("EXECUTABLE_NOT_FOUND") => (
                "EXECUTABLE_NOT_FOUND",
                "Installed Python Gio/GStreamer plugins are required by this desktop action",
                true,
            ),
            Some("FILE_NOT_FOUND") => (
                "FILE_NOT_FOUND",
                "The owned media handle, file, or portal stream was not found",
                true,
            ),
            Some("FILE_TOO_LARGE") => (
                "FILE_TOO_LARGE",
                "Desktop media exceeded its bounded size",
                true,
            ),
            Some("CONFLICT") => (
                "CONFLICT",
                "The media target exists or a session is already recording",
                true,
            ),
            Some("PROCESS_TIMEOUT") => (
                "PROCESS_TIMEOUT",
                "Desktop media or consent did not finish within its limit",
                true,
            ),
            Some("UNSUPPORTED_PLATFORM") => (
                "UNSUPPORTED_PLATFORM",
                "The selected desktop action is not supported by this provider",
                true,
            ),
            _ => (
                "INTERNAL_ERROR",
                "Desktop media failed or could not be verified",
                true,
            ),
        })
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = writeln!(
            self.stdin,
            "{{\"operation\":\"host\",\"action\":\"close\",\"input\":{{}}}}"
        );
        let _ = self.stdin.flush();
        let deadline = std::time::Instant::now() + Duration::from_millis(1_000);
        while self.child.try_wait().ok().flatten().is_none() && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn execute(
    operation: &str,
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, NativeError> {
    let mut sessions = SESSIONS.lock().map_err(|_| {
        (
            "INTERNAL_ERROR",
            "Desktop session registry is unavailable",
            true,
        )
    })?;
    execute_owned(&mut sessions, operation, action, input)
}

fn execute_owned(
    sessions: &mut BTreeMap<Owner, Helper>,
    operation: &str,
    action: &str,
    input: &BTreeMap<String, String>,
) -> Result<String, NativeError> {
    let requester = Owner::read(input)?;
    sessions.retain(|_, helper| {
        prune_handles(&mut helper.handles);
        (helper.last_seen.elapsed() < Duration::from_secs(900)
            || helper.handles.values().any(|record| record.active))
            && helper.child.try_wait().ok().flatten().is_none()
    });
    let owner = if let Some(handle) = input.get("handle").or_else(|| input.get("session_id")) {
        sessions
            .iter()
            .find_map(|(owner, helper)| {
                (owner.permits(&requester) && helper.handles.contains_key(handle))
                    .then(|| owner.clone())
            })
            .ok_or((
                "FILE_NOT_FOUND",
                "The owned desktop handle was not found",
                true,
            ))?
    } else {
        requester
    };
    if !sessions.contains_key(&owner) {
        if input.contains_key("handle") || input.contains_key("session_id") {
            return Err((
                "FILE_NOT_FOUND",
                "The owned desktop handle was not found",
                true,
            ));
        }
        if sessions.len() >= MAX_OWNERS {
            return Err((
                "CONFLICT",
                "Too many owned desktop session providers are active",
                true,
            ));
        }
        sessions.insert(owner.clone(), Helper::spawn()?);
    }
    let result = sessions
        .get_mut(&owner)
        .unwrap()
        .call(operation, action, input);
    if result
        .as_ref()
        .is_err_and(|error| matches!(error.0, "PROCESS_TIMEOUT" | "PROCESS_NOT_FOUND"))
    {
        sessions.remove(&owner);
    }
    result
}

pub(crate) fn close() {
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::Owner;
    use std::collections::BTreeMap;

    #[test]
    fn handle_history_is_bounded_and_never_forgets_live_or_unverified_resources() {
        use super::{prune_handles, track_handles, MAX_HANDLE_HISTORY};
        let mut handles = BTreeMap::new();
        track_handles(
            &mut handles,
            &serde_json::json!({"handle":"live", "state":"running"}),
        );
        track_handles(
            &mut handles,
            &serde_json::json!({"handle":"quarantined", "state":"termination_unverified", "running":false}),
        );
        track_handles(
            &mut handles,
            &serde_json::json!({"session_id":"retained-capture", "permissionState":"granted"}),
        );
        for number in 0..1000 {
            track_handles(
                &mut handles,
                &serde_json::json!({"handle":format!("terminal-{number}"), "state":"completed"}),
            );
            track_handles(
                &mut handles,
                &serde_json::json!({"session_id":format!("portal-{number}"), "permissionState":"granted"}),
            );
            track_handles(
                &mut handles,
                &serde_json::json!({"released":true, "closed":true, "scope":"session", "released_session_ids":[format!("portal-{number}")]}),
            );
            assert!(handles.len() <= MAX_HANDLE_HISTORY + 3);
        }
        for record in handles.values_mut() {
            record.seen = std::time::Instant::now() - std::time::Duration::from_secs(901);
        }
        prune_handles(&mut handles);
        assert_eq!(
            handles.keys().cloned().collect::<Vec<_>>(),
            vec!["live", "quarantined", "retained-capture"]
        );
    }

    #[test]
    fn owner_tuple_is_not_a_display_session_or_handle() {
        let make = |session: &str, workspace: Option<&str>| {
            let mut input = BTreeMap::from([
                (
                    "metadata.lnwjing.taskOwner.v1.clientId".into(),
                    "client".into(),
                ),
                (
                    "metadata.lnwjing.taskOwner.v1.sessionId".into(),
                    session.into(),
                ),
            ]);
            if let Some(workspace) = workspace {
                input.insert(
                    "metadata.lnwjing.taskOwner.v1.workspaceId".into(),
                    workspace.into(),
                );
            }
            Owner::read(&input).unwrap()
        };
        assert_ne!(make("one", Some("a")), make("two", Some("a")));
        assert_ne!(make("one", Some("a")), make("one", Some("b")));
        assert_ne!(make("one", Some("a")), make("one", None));
        assert!(make("one", Some("a")).permits(&make("one", None)));
        assert!(!make("one", Some("a")).permits(&make("one", Some("b"))));
        assert_eq!(make("one", None), make("one", None));
    }

    #[test]
    fn partial_or_blank_owner_never_downgrades_to_legacy() {
        assert!(Owner::read(&BTreeMap::from([(
            "metadata.lnwjing.taskOwner.v1.clientId".into(),
            "client".into()
        )]))
        .is_err());
        assert!(Owner::read(&BTreeMap::from([
            (
                "metadata.lnwjing.taskOwner.v1.clientId".into(),
                "client".into()
            ),
            ("metadata.lnwjing.taskOwner.v1.sessionId".into(), " ".into()),
        ]))
        .is_err());
        assert!(Owner::read(&BTreeMap::new()).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn foreign_handle_requests_never_reach_the_owned_helper_and_restart_loses_handles() {
        use super::{execute_owned, Helper};
        let source = "import json,sys\nstate='running'\nfor line in sys.stdin:\n r=json.loads(line)\n if r['operation']=='host': break\n if r['action']=='stop': state='completed'\n print(json.dumps({'ok':True,'value':{'handle':'fixture-owned','state':state}}),flush=True)\n";
        let input = |client: &str, session: &str, workspace: Option<&str>| {
            let mut result = BTreeMap::from([
                (
                    "metadata.lnwjing.taskOwner.v1.clientId".into(),
                    client.into(),
                ),
                (
                    "metadata.lnwjing.taskOwner.v1.sessionId".into(),
                    session.into(),
                ),
                ("handle".into(), "fixture-owned".into()),
            ]);
            if let Some(workspace) = workspace {
                result.insert(
                    "metadata.lnwjing.taskOwner.v1.workspaceId".into(),
                    workspace.into(),
                );
            }
            result
        };
        let owner_input = input("client", "session", Some("workspace"));
        let owner = Owner::read(&owner_input).unwrap();
        let mut helper = Helper::spawn_source(source).unwrap();
        helper
            .call("screen_record", "start", &BTreeMap::new())
            .unwrap();
        let mut sessions = BTreeMap::from([(owner.clone(), helper)]);
        for foreign in [
            input("foreign", "session", Some("workspace")),
            input("client", "foreign", Some("workspace")),
            input("client", "session", Some("foreign")),
        ] {
            for action in ["status", "stop"] {
                assert_eq!(
                    execute_owned(&mut sessions, "screen_record", action, &foreign)
                        .unwrap_err()
                        .0,
                    "FILE_NOT_FOUND"
                );
            }
        }
        let status: serde_json::Value = serde_json::from_str(
            &execute_owned(
                &mut sessions,
                "screen_record",
                "status",
                &input("client", "session", None),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(status["state"], "running");
        let status: serde_json::Value = serde_json::from_str(
            &execute_owned(&mut sessions, "screen_record", "stop", &owner_input).unwrap(),
        )
        .unwrap();
        assert_eq!(status["state"], "completed");
        let previous = sessions.remove(&owner).unwrap();
        let previous_pid = previous.child.id();
        drop(previous);
        assert!(!std::path::Path::new(&format!("/proc/{previous_pid}")).exists());
        let mut replacement = Helper::spawn_source(source).unwrap();
        assert_eq!(replacement.child.try_wait().unwrap(), None);
        sessions.insert(owner, replacement);
        assert_eq!(
            execute_owned(&mut sessions, "screen_record", "status", &owner_input)
                .unwrap_err()
                .0,
            "FILE_NOT_FOUND"
        );
    }
}
