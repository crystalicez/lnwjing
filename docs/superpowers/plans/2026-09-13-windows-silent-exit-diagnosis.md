# รายงานวิเคราะห์ lnwjing ปิดตัวเองแบบเงียบ ๆ บน Windows

วันที่ตรวจสอบ: 2026-09-13 (Asia/Bangkok)

สถานะเอกสาร: วิเคราะห์จากโค้ดปัจจุบัน, Git history, Windows Event Log, Reliability Monitor, process state และ crash diagnostics บนเครื่องจริง; ข้อแก้ไขในสาย v4.62.2 ถูกผูกกับแผน Issue #59 และอยู่ระหว่าง exact hosted CI/release verification

## สถานะการตรวจเพิ่มเติม (2026-09-13)

- exact CI run `34759240096` ไม่พบ silent native crash ของ lnwjing บน macOS 26: x64 มีหน้าต่างและ process ยังอยู่ ส่วน arm64 ค้างก่อนสร้างหน้าต่างในช่วง safeStorage/keychain bootstrap
- x64 พบ false negative ใน startup Doctor: MCP identity probe แบบครั้งเดียว timeout ที่ 750 ms ระหว่าง loopback listener กำลังขึ้น แล้ว RequirementRegistry cache ผล fail ไว้ 30 วินาที แก้โดย retry เฉพาะ timeout/transport ภายใน probe budget; identity mismatch จริงยัง fail closed
- arm64 finding เป็นข้อจำกัดของ hosted packaged Keychain ไม่ใช่หลักฐานว่าปัญหา Windows เดิมกลับมา และไม่ใช่ DYLD signature failure; compatibility smoke จึงใช้ explicit in-memory secret fixture ที่เปิดได้เฉพาะ macOS 26 arm64 + packaged E2E flags ขณะที่ production ยังคงบังคับ Electron safeStorage
- ข้อสรุปของ Windows เดิมยังเหมือนเดิม: เหตุที่ยืนยันได้คือ Application Hang และ renderer-recovery race รุ่นเก่า; หากรอบใหม่ยังปิดโดยไม่มี lifecycle record ให้เก็บ `%APPDATA%\\lnwjing\\crashes\\crash-events.ndjson` คู่กับ Event Viewer/WER

## 1. บทสรุป

อาการที่เรียกว่า “lnwjing ปิดตัวเองแบบเงียบ ๆ” มีอย่างน้อย 3 กรณีที่หน้าตาเหมือนกัน แต่กลไกต่างกัน:

1. **Windows ปิด process หลังแอปค้าง** — ยืนยันว่าเคยเกิดจริงกับ v4.44.0 และ v4.51.0 จาก `Application Hang` Event ID 1002
2. **renderer ตาย แล้ว recovery race สั่งปิด main process โดยไม่ตั้งใจ** — ยืนยันจากโค้ดและ Git diff ก่อน commit `4b26cd2`; นี่คือบั๊กที่อธิบาย “ปิดเงียบ” ได้ตรงที่สุด
3. **หน้าต่างถูกซ่อนไป Tray หรือแอปถูก relaunch หลังอัปเดต** — ไม่ใช่ crash แต่ผู้ใช้อาจเห็นเหมือนแอปปิด ปัจจุบันเครื่องนี้ตั้ง `close_behavior=tray` และ process รอบปัจจุบันเริ่มด้วย `--updated`

สาเหตุแบบ chain ที่มีหลักฐานรองรับมากที่สุดคือ:

```text
log/search ปริมาณสูง
  -> main/renderer ทำงานและคัดลอกข้อมูลถี่เกินไป
  -> UI ค้างหรือ renderer หาย
  -> [รุ่นเก่า] renderer recovery ทำลายหน้าต่างสุดท้าย
  -> Electron ส่ง window-all-closed
  -> Windows/Linux handler เรียก app.quit() ทันที
  -> timer ที่จะสร้างหน้าต่างใหม่หลัง 250 ms ไม่ทันทำงาน
  -> ผู้ใช้เห็น lnwjing หายไปโดยไม่มี error dialog
```

แพตช์ลดแรงกดดันจาก log/search อยู่ใน commit `da08ed1` และแพตช์ปิด recovery race อยู่ใน commit `4b26cd2`; ทั้งสอง commit เป็น ancestor ของ tag `v4.62.1`

อย่างไรก็ตาม ยังไม่ควรอ้างว่าเหตุล่าสุดบน v4.62.1 เป็น crash เดิม เพราะ crash log ของรอบปัจจุบันมีเพียง `desktop-started` และไม่พบ `renderer-gone`, `window-all-closed`, `before-quit` หรือ main-process exception

## 2. หลักฐานจาก Windows

### 2.1 เหตุที่ Windows ปิดแอปหลังค้าง

| เวลา (Asia/Bangkok) | รุ่น | หลักฐาน | ความหมาย |
|---|---:|---|---|
| 2026-08-31 11:14:24 | 4.44.0 | `Application Hang`, Event ID 1002 และ `AppHangB1` | โปรแกรมหยุดตอบสนองและถูก Windows ปิด |
| 2026-09-02 04:35:41 | 4.51.0 | `Application Hang`, Event ID 1002 และ `AppHangB1` | โปรแกรมหยุดตอบสนองและถูก Windows ปิด |
| 2026-09-02 04:37:12 | 4.51.0 | `Application Hang`, Event ID 1002 และ `AppHangB1` | เกิดซ้ำในช่วงใกล้กัน |
| 2026-09-06 19:48:24 | 4.54.0 | `RADAR_PRE_LEAK_64` | Windows ตรวจพบรูปแบบการใช้ทรัพยากรที่เข้าข่าย memory-leak warning; ไม่ใช่หลักฐานว่า process ถูก kill ในเหตุนี้ |
| 2026-09-09 02:44:51 | 4.56.1 | `AppHangTransient` | แอปเคยค้างชั่วคราว แต่ event นี้ไม่ยืนยันว่าถูกปิด |

สิ่งที่ Event Log ยืนยันได้คือ “มีการค้างและ Windows ปิดจริง” แต่ไม่มี stack trace หรือ dump เหลืออยู่ จึงระบุฟังก์ชันต้นเหตุของแต่ละ hang จาก WER เพียงอย่างเดียวไม่ได้

ไม่พบ `Microsoft-Windows-Resource-Exhaustion-Detector` event ในช่วง 14 วันที่ตรวจ จึงไม่มีหลักฐานว่า Windows ปิดแอปเพราะ RAM ทั้งระบบหมด

### 2.2 สถานะรอบปัจจุบัน

- executable ที่ติดตั้ง: `%LOCALAPPDATA%\Programs\lnwjing\lnwjing.exe`
- รุ่น: `4.62.1`
- main process เริ่มเวลา `2026-09-13 11:53:47 +07:00`
- command line มี `--updated` แปลว่ารอบนี้ถูกเปิดต่อจากขั้นตอนติดตั้ง/อัปเดต
- ตอนตรวจ main process และ renderer ยังอยู่และตอบสนอง
- crash event file ถูกสร้างเวลา `11:53:48` และมีเพียง:

```json
{"schemaVersion":1,"timestamp":"2026-09-13T04:53:48.223Z","appVersion":"4.62.1","type":"desktop-lifecycle","processType":"main","reason":"desktop-started"}
```

ดังนั้น ถ้าอาการที่ผู้ใช้หมายถึงเกิดใกล้ `11:53` มีความเป็นไปได้สูงว่าเป็น update/install relaunch ไม่ใช่ crash รอบใหม่ แต่ `--updated` อย่างเดียวบอกไม่ได้ว่าเริ่มจากการกดติดตั้งใน UI, การรัน installer ด้วยตนเอง หรือเส้นทาง updater อื่น

### 2.3 หน่วยความจำรอบปัจจุบัน

วัด 7 ครั้งในช่วง 43 วินาทีระหว่างที่ process ยังตอบสนอง:

- main private memory: `700.3 -> 689.2 -> 684.3 -> 734.5 -> 725.2 -> 611.4 -> 608.2 MB`
- process tree private memory: `1352.9 -> 1235.0 MB`
- handle count อยู่ราว `1054-1063`

ตัวเลขค่อนข้างสูง แต่ลดลงหลัง GC/การคืนหน่วยความจำ และไม่โตแบบ monotonic ในช่วงตัวอย่าง จึงยังไม่ใช่หลักฐานว่า v4.62.1 มี memory leak ต่อเนื่อง

## 3. Root cause ที่ยืนยันจากโค้ด

### 3.1 Renderer recovery race

ก่อน commit `4b26cd2` ลำดับใน `configureCrashRecovery()` เป็นดังนี้:

1. รับ `render-process-gone`
2. ตั้ง `mainWindow = null`
3. เรียก `crashedWindow.destroy()`
4. ตั้ง timer 250 ms เพื่อ `createDesktopWindow()`
5. การ destroy หน้าต่างสุดท้ายทำให้ Electron ส่ง `window-all-closed`
6. handler เดิมบน Windows/Linux เรียก `app.quit()` โดยไม่มีเงื่อนไข
7. main process เริ่มปิดก่อน timer recovery ทำงาน

นี่เป็น race ที่ deterministic เมื่อหน้าต่างหลักเป็นหน้าต่างสุดท้าย ไม่ใช่เพียงสมมติฐานเชิงเวลา

commit `4b26cd2` แก้โดยเพิ่ม `RendererRecoveryBarrier`:

- `begin()` เพิ่มจำนวน recovery ที่กำลังทำ
- `window-all-closed` ไม่เรียก `app.quit()` ขณะที่ barrier pending
- เมื่อสร้างหน้าต่างใหม่เสร็จจึง `completeRecovery()`
- เพิ่ม lifecycle event เพื่อแยก `desktop-started`, `window-all-closed` และ `before-quit`

ผลทดสอบปัจจุบัน:

```text
tests/crash-recovery.test.ts                 4 passed
tests/startup-regression-contract.test.ts    8 passed
รวม                                           12 passed
```

ข้อจำกัด: ชุดนี้พิสูจน์ policy และ wiring ที่เคยผิด แต่ยังไม่ใช่ packaged Electron E2E ที่ force-crash renderer จริง

### 3.2 แรงกดดันจาก Live Logs และ ripgrep ก่อนแพตช์ responsiveness

ก่อน commit `da08ed1` มีเส้นทางที่ทำให้แอปช้าหรือกินหน่วยความจำมากเมื่อ output หนาแน่น:

- Live Log แต่ละบรรทัดเรียก React state update แยกครั้งและคัดลอก retained array ใหม่ทั้งก้อน
- `logIds` ที่ใช้ de-duplicate โตต่อเนื่องตลอดอายุ desktop session
- snapshot merge ไม่มีเพดานฝั่ง renderer ที่ชัดเจน
- ripgrep สามารถส่ง stdout ปริมาณมากเข้ามาตลอดจน process จบหรือ timeout แม้ caller ต้องการเพียง `maxResults`
- การต่อ string ซ้ำขณะรับ output ทำให้เกิด allocation/copy churn

แพตช์ `da08ed1` เปลี่ยนเป็น:

- batch Live Log ทุก 40 ms แทน state update ต่อบรรทัด
- จำกัด renderer buffer ที่ 30,000 บรรทัด
- จำกัด de-duplication IDs ที่ 60,000 ค่า
- แสดงผลพร้อมกันสูงสุด 5,000 บรรทัด
- main LogHub เก็บสูงสุด 10,000 บรรทัดต่อ source และ 8 KiB ต่อบรรทัด
- หยุด ripgrep process tree เมื่อพบข้อมูลเกิน `maxResults` แทนการปล่อยให้ stdout ไหลต่อ
- เก็บ stdout/stderr แบบ bounded chunks

ช่วงเวลาของหลักฐานสอดคล้องกัน: WER hang/leak signals ทั้งหมดที่พบเกิดก่อน commit responsiveness เมื่อวันที่ 2026-09-09 15:11 +07:00

นี่ทำให้ load-induced hang เป็นคำอธิบายที่มีน้ำหนักสูงสำหรับเหตุ v4.44.0-v4.56.1 แต่เพราะไม่มี dump จึงควรเรียกว่า “สาเหตุที่สอดคล้องกับหลักฐานและถูกแก้ตรงจุด” ไม่ใช่ stack-level proof ของ WER ทุกเหตุ

## 4. สิ่งที่ไม่ใช่ root cause เดียวกัน

### 4.1 Close to Tray

เครื่องนี้ตั้ง `close_behavior=tray` ดังนั้นการกด X จะ `preventDefault()` และซ่อนหน้าต่าง หาก process/tray icon ยังอยู่ นี่คือพฤติกรรมตามตั้งค่า ไม่ใช่แอปปิดตัวเอง

### 4.2 Update relaunch

ตัว updater ตั้ง `autoInstallOnAppQuit=false`; การตรวจพบและดาวน์โหลดอัตโนมัติไม่ควรติดตั้งเองทันที การเรียก `quitAndInstall()` อยู่ในเส้นทาง install action อย่างชัดเจน แต่ process รอบปัจจุบันมี `--updated` จึงยืนยันได้เพียงว่าเกิดการติดตั้ง/อัปเดตก่อนรอบนี้ ไม่ยืนยันว่าเป็น automatic silent install

### 4.3 Main-process/native crash หรือ external kill

ยังไม่มีหลักฐานของ `Application Error`, minidump, crashpad dump หรือ `main-uncaught-exception` สำหรับ v4.62.1 และไม่ควรสรุปว่า antivirus, Windows OOM, GPU driver หรือ process ภายนอกเป็นผู้ kill โดยไม่มี event/dump รองรับ

## 5. การจัดอันดับสมมติฐาน

| สมมติฐาน | เหตุเก่า | เหตุหลังเริ่ม v4.62.1 | สถานะ |
|---|---:|---:|---|
| App hang จาก log/search pressure แล้ว Windows ปิด | สูง | ต่ำ-กลาง | ยืนยัน hang ใน WER; กลไก pressure สอดคล้องและมีแพตช์แล้ว |
| Renderer crash แล้ว recovery race ปิดทั้งแอป | สูง | ต่ำ | ยืนยันบั๊กในโค้ดเก่า; v4.62.1 มี barrier แล้ว |
| Update/install relaunch | ไม่ทราบ | สูง หากเกิดใกล้ 11:53 | รอบปัจจุบันเริ่มด้วย `--updated` |
| ซ่อนไป Tray | สูง หาก process ยังอยู่ | สูง หาก process ยังอยู่ | ตรงกับ current setting |
| Memory leak ต่อเนื่องใน v4.62.1 | ไม่ทราบ | ต่ำจาก sample ปัจจุบัน | หน่วยความจำลดลงในช่วงวัด; ต้อง soak test จึงจะปิดประเด็นได้ |
| Main/native crash หรือ external kill | ต่ำ | ต่ำ/ยังไม่ทราบ | ไม่มี event หรือ dump รองรับ |

## 6. แผนพิสูจน์และป้องกันกรณีเกิดซ้ำ

### Phase A — เก็บหลักฐานให้แยกสาเหตุได้ในครั้งเดียว

1. เพิ่ม `runId`, main PID, app version และ start reason ลงทุก lifecycle record
2. บันทึกเหตุ `window-close-requested`, `window-hidden-to-tray`, `update-install-requested`, `will-quit`, `quit`, `renderer-recovery-started/completed/failed`
3. flush lifecycle record แบบ atomic ก่อน `app.quit()`, `app.exit()` และ `quitAndInstall()`
4. เปิด Electron `crashReporter`/Crashpad สำหรับ local dump โดยกำหนด retention, ขนาด และการปกป้องข้อมูลชัดเจน
5. บันทึก renderer reason/exitCode และ child type โดยไม่เก็บ command payload หรือ secret

Acceptance:

- เหตุครั้งถัดไปต้องจำแนกได้ว่า `tray`, `intentional quit`, `update`, `renderer crash`, `main crash`, `OS hang/kill` หรือ `unknown hard termination`
- log ต้องอยู่ครบแม้ process ปิดทันทีหลัง event

### Phase B — ทำ Electron E2E สำหรับ recovery จริง

1. เปิด packaged/dev Electron ด้วย temporary userData
2. force-crash main renderer ผ่าน test-only harness
3. ยืนยันว่า main PID เดิมยังอยู่
4. ยืนยันว่าหน้าต่างใหม่ถูกสร้างและพร้อมใช้งาน
5. ยืนยันว่าไม่มี `before-quit`
6. ยืนยัน event sequence: `renderer-gone -> recovery-started -> window-all-closed:recovery-pending -> recovery-completed`
7. ทำซ้ำกับ log viewer และกรณี crash เกิน recovery budget

Acceptance:

- crash 1-3 ครั้งใน 5 นาทีต้อง recover โดยไม่ปิดแอป
- เมื่อเกิน budget ต้องอยู่ในสถานะอธิบายได้และมี diagnostics ไม่หายเงียบ

### Phase C — Stress/soak test สำหรับต้นเหตุ hang

1. ป้อน Live Log burst อย่างน้อย 100,000 records ด้วยขนาดใกล้ 8 KiB
2. รัน search ที่ match จำนวนมากกว่าค่า `maxResults` หลายเท่า
3. วัด renderer/main private bytes, heap, event-loop lag, React commit count และเวลาตอบ IPC
4. รัน soak อย่างน้อย 30-60 นาทีพร้อมเปิด/ปิด Live Logs, filter และ standalone viewer
5. ตรวจว่า GC ทำให้ memory กลับลงและไม่มี handle/thread เพิ่มต่อเนื่อง

Acceptance ที่ควรกำหนดก่อนลงมือ:

- retained log/ID count ไม่เกิน hard limits
- ripgrep child ถูกหยุดหลังได้หลักฐานครบ
- UI ไม่เข้าสู่ `Not Responding`
- private memory หลัง GC ไม่มี slope ต่อเนื่องเกิน threshold ที่ทีมกำหนด

### Phase D — Installed-app acceptance

1. ติดตั้ง build ที่มี instrumentation ในเครื่องทดสอบ
2. ทดสอบ X-to-Tray, Tray Quit, explicit update install, renderer crash และ Windows sign-out/shutdown แยกกัน
3. ตรวจ Event Viewer, crash-events และ dump ให้ timeline ตรงกัน
4. ทดสอบ update จากรุ่นก่อนหน้าเป็นรุ่นใหม่และยืนยันว่าผู้ใช้เห็นสถานะ restart ชัดเจน

## 7. วิธีอ่าน crash log หากเกิดซ้ำ

ไฟล์: `%APPDATA%\lnwjing\crashes\crash-events.ndjson`

| ลำดับที่พบ | ความหมายเบื้องต้น |
|---|---|
| `renderer-gone` แล้ว recovery lifecycle ครบ | renderer crash แต่ recovery สำเร็จ |
| `renderer-gone` แล้ว `window-all-closed:renderer-recovery-pending` แต่ไม่มี recovery complete | recovery path ล้มเหลว/ถูก hard-kill ระหว่างทาง |
| `before-quit` หลัง update action | intentional updater restart |
| `before-quit` โดยไม่มี crash | Tray Quit, OS shutdown หรือ explicit quit; ต้องดู action correlation เพิ่ม |
| มีเพียง start record แล้วรอบถัดไปเริ่มใหม่ | main/native hard crash, OS/external kill หรือไฟดับ; ต้องดู WER/dump |
| ไม่มี event ใหม่และ process ยังอยู่ | หน้าต่างถูกซ่อนหรือ UI state issue ไม่ใช่ process exit |

## 8. ข้อสรุปสุดท้าย

- **ยืนยันแล้ว:** Windows เคยปิด lnwjing รุ่นเก่าเพราะแอปไม่ตอบสนอง
- **ยืนยันแล้ว:** โค้ด recovery รุ่นเก่ามี race ที่เปลี่ยน renderer crash ให้กลายเป็น silent full-app exit
- **มีน้ำหนักสูง:** high-volume Live Logs/ripgrep เป็นแหล่ง pressure ที่อธิบาย hang/leak signals รุ่นเก่า และถูกแก้ตรงกลไกหลัง event ล่าสุดที่พบ
- **ยังไม่ยืนยัน:** v4.62.1 ปิดจาก crash เดิม เพราะรอบปัจจุบันไม่มี crash/quit event และยังรันตอบสนอง
- **หากอาการเกิดราว 11:53 วันนี้:** หลักฐานชี้ไปที่ install/update relaunch มากกว่า crash

ยังไม่ควรแก้โค้ดเพิ่มจากการเดา จุดถัดไปที่ให้ข้อมูลมากที่สุดคือ Electron E2E force-crash และ lifecycle/crash dump instrumentation ตาม Phase A-B
