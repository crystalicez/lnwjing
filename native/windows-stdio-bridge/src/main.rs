//! Windows console STDIO relay for the GUI-subsystem Electron MCP host.
//! Only loopback is used. A fresh 128-bit secret authenticates each connection.
//! MCP frames and secrets are never parsed or logged.
#![cfg(windows)]

use std::env;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

fn random_secret() -> io::Result<[u8; 16]> {
    let mut secret = [0_u8; 16];
    let status = unsafe { BCryptGenRandom(ptr::null_mut(), secret.as_mut_ptr(), 16, 2) };
    if status != 0 { return Err(io::Error::other("Windows secure random generator unavailable")); }
    Ok(secret)
}

fn receive_authenticated_client(
    listener: &TcpListener,
    child: &mut Child,
    expected: &[u8; 16],
) -> io::Result<TcpStream> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() {
            return Err(io::Error::other("Electron exited before its MCP transport connected"));
        }
        match listener.accept() {
            Ok((mut socket, address)) => {
                if !address.ip().is_loopback() { continue; }
                // Windows may inherit the listener's nonblocking mode.
                socket.set_nonblocking(false)?;
                socket.set_read_timeout(Some(Duration::from_secs(2)))?;
                let mut provided = [0_u8; 16];
                if socket.read_exact(&mut provided).is_err() || provided != *expected {
                    continue;
                }
                socket.set_read_timeout(None)?;
                socket.set_nodelay(true)?;
                return Ok(socket);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::TimedOut, "Electron did not authenticate to its MCP bridge"))
}

fn relay(socket: TcpStream, child: &mut Child) -> io::Result<()> {
    let mut outgoing = socket.try_clone()?;
    let (tx, rx) = mpsc::channel::<()>();
    let input_done = tx.clone();
    thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut outgoing);
        let _ = outgoing.shutdown(Shutdown::Write);
        let _ = input_done.send(());
    });
    thread::spawn(move || {
        let mut incoming = socket;
        let mut output = io::stdout().lock();
        let _ = io::copy(&mut incoming, &mut output);
        let _ = output.flush();
        let _ = tx.send(());
    });
    loop {
        if rx.recv_timeout(Duration::from_millis(200)).is_ok() { break; }
        if child.try_wait()?.is_some() { break; }
    }
    Ok(())
}

fn profile_data_path() -> io::Result<PathBuf> {
    if let Some(value) = env::var_os("LNWJING_DATA_PATH") {
        let path = PathBuf::from(value);
        if path.is_absolute() { return Ok(path); }
    }
    if let Some(value) = env::var_os("APPDATA") {
        let path = PathBuf::from(value);
        if path.is_absolute() { return Ok(path.join("lnwjing")); }
    }
    if let Some(value) = env::var_os("USERPROFILE") {
        let path = PathBuf::from(value);
        if path.is_absolute() { return Ok(path.join("AppData").join("Roaming").join("lnwjing")); }
    }
    Err(io::Error::other("Cannot determine the Windows MCP profile data directory"))
}

// The async Windows OSCrypt key lives in Chromium Local State. On a fresh
// profile it is not durable until Electron exits cleanly. Serialize exactly
// this first initialization across independent STDIO launchers using the OS
// file lock; never decrypt, re-encrypt or overwrite an existing checkpoint key.
fn initialize_profile_once(electron: &OsStr, args: &[OsString]) -> io::Result<()> {
    let directory = profile_data_path()?;
    fs::create_dir_all(&directory)?;
    let guard = OpenOptions::new().read(true).write(true).create(true)
        .open(directory.join(".stdio-profile-init.lock"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match guard.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline =>
                thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(io::Error::other(format!("Windows MCP profile initialization is busy: {error}"))),
        }
    }

    let marker = directory.join(".stdio-profile-ready.v1");
    let checkpoint = directory.join("checkpoint-master.key");
    if fs::read(&marker).is_ok_and(|bytes| bytes == b"1") && checkpoint.is_file() {
        return Ok(());
    }
    let mut bootstrap = Command::new(electron)
        .args(args)
        .arg("--mcp-stdio")
        .arg("--mcp-stdio-profile-init")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?;
    let bootstrap_deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match bootstrap.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < bootstrap_deadline =>
                thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = bootstrap.kill();
                let _ = bootstrap.wait();
                return Err(io::Error::new(io::ErrorKind::TimedOut, "Electron MCP secure profile initialization timed out"));
            }
            Err(error) => {
                let _ = bootstrap.kill();
                let _ = bootstrap.wait();
                return Err(error);
            }
        }
    };
    if !status.success() {
        return Err(io::Error::other(format!("Electron MCP secure profile initialization failed: {status}")));
    }
    if !checkpoint.is_file() {
        return Err(io::Error::other("Electron MCP secure profile initialization did not publish a checkpoint key"));
    }
    fs::write(marker, b"1")?;
    Ok(())
}

fn run() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let first = args.next().ok_or_else(|| io::Error::other("Missing Electron host executable"))?;
    let initialize_only = first == "--profile-init-only";
    let electron = if initialize_only {
        args.next().ok_or_else(|| io::Error::other("Missing Electron host executable"))?
    } else { first };
    if !Path::new(&electron).is_absolute() {
        return Err(io::Error::other("Electron host path must be absolute"));
    }
    let electron_args: Vec<OsString> = args.collect();
    initialize_profile_once(&electron, &electron_args)?;
    if initialize_only { return Ok(()); }
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let proof = random_secret()?;
    let proof_hex = proof.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let mut child = Command::new(electron)
        .args(&electron_args)
        .arg("--stdio-bridge-port").arg(port.to_string())
        // Do not expose the bearer secret in Win32_Process.CommandLine.
        .env("LNWJING_MCP_STDIO_BRIDGE_SECRET", proof_hex)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut child_stderr) = child.stderr.take() {
        thread::spawn(move || {
            // Never hold stderr().lock() across a blocking read from Electron:
            // doing so deadlocks the bridge's own errors and teardown.
            let mut buf = [0_u8; 4096];
            loop {
                match child_stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) if io::stderr().write_all(&buf[..n]).is_err() => break,
                    Ok(_) => {}
                }
            }
        });
    }
    let outcome = receive_authenticated_client(&listener, &mut child, &proof)
        .and_then(|connection| relay(connection, &mut child));
    // Closing the client stream asks Electron to finish its own shutdown.
    // Killing it immediately can discard Chromium's persistent OSCrypt key
    // before Local State is flushed, making the next STDIO launch unreadable.
    // Bound the grace period; never leave an orphan Electron when the bridge exits.
    let shutdown_deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait()?.is_none() && Instant::now() < shutdown_deadline {
        thread::sleep(Duration::from_millis(50));
    }
    if child.try_wait()?.is_none() { let _ = child.kill(); }
    let _ = child.wait();
    outcome
}

fn main() {
    if let Err(error) = run() {
        eprintln!("lnwjing MCP console bridge: {error}");
        std::process::exit(1);
    }
}
