# Windows OCR helper

This helper is deliberately separate from the TypeScript process. `Windows.Media.Ocr` requires package identity for desktop use, so the normal NSIS application keeps its existing installer while a signed sparse package supplies identity for this helper.

The helper reads one JSON request per stdin line and writes one `{ ok, value }` response per stdout line. It accepts the existing `vision` OCR payload (`action: "ocr"`, `image_base64`) and returns `available: false` when package identity or a supported user-profile language is unavailable.

Build on a Windows machine with the .NET 8 SDK:

```powershell
# from the repository root
powershell -File scripts\build-windows-ocr.ps1
```

Register the sparse package (dev mode uses a self-signed certificate; run once
from an elevated prompt so the cert can be trusted in TrustedPeople):

```powershell
powershell -File scripts\register-windows-ocr.ps1
# release: -ReleaseCertPfx <pfx> -ReleaseCertPassword <password>
```

The scripts require the Windows SDK `makeappx.exe`/`signtool.exe` and verify
the result by probing the helper (`{"op":"probe"}`) for `package_identity`.

The runtime discovers the helper through `LNWJING_WINDOWS_OCR_HELPER` or the packaged `windows-ocr\lnwjing-windows-ocr.exe` location. The host performs a one-shot cached identity probe through the helper before delegating, and until a signed sparse package is registered, the public `vision` OCR action remains truthfully unavailable.

The manifest is a release template only. A release pipeline must replace the placeholder publisher, sign the sparse package, register its external location, and include the published helper next to the NSIS application resources (`electron-builder.yml` ships `native/windows-ocr/bin` as the `windows-ocr` extra resource). No certificate or private key belongs in this repository.
