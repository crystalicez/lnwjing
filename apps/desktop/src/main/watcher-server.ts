import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export type WatcherStatus = 'running' | 'analyzing' | 'verifying' | 'waiting' | 'blocked' | 'idle' | 'done' | 'error';

export interface WatcherActivityEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: string;
  readonly status: WatcherStatus;
  readonly actor: string;
  readonly summary: string;
  readonly detail?: string;
  readonly workspaceId?: string;
}

export interface WatcherGoalSnapshot {
  readonly id: string;
  readonly key: string;
  readonly status: WatcherStatus;
  readonly currentTask: string;
  readonly blockers: readonly string[];
  readonly milestones: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  }>;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  /** The durable record remains active until finish_goal completes. */
  readonly lifecycle?: 'active';
  readonly completionReady?: boolean;
  readonly objective?: string;
  readonly currentPhase?: string;
  readonly acceptanceCriteria?: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: 'pending' | 'completed' | 'blocked' }>;
  readonly activeTaskCount?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastCheckpointAt?: string;
}

export interface WatcherGitSnapshot {
  readonly branch: string;
  readonly commit: string;
  readonly clean: boolean;
  readonly changedFiles: number;
  readonly latestSubject?: string;
  readonly latestAt?: string;
}

export interface WatcherWorkspaceSnapshot {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
  readonly activeOperations: number;
  readonly goals: readonly WatcherGoalSnapshot[];
  readonly git: WatcherGitSnapshot;
}

export interface WatcherSnapshot {
  readonly protocolVersion: 1;
  readonly serverTime: string;
  readonly runtime: { readonly version: string; readonly status: WatcherStatus; readonly activeOperations: number };
  readonly instance: {
    readonly id: string;
    readonly name: string;
    readonly platform: 'windows' | 'macos' | 'linux' | 'unknown';
  };
  readonly goal: WatcherGoalSnapshot | null;
  readonly workspaces: readonly WatcherWorkspaceSnapshot[];
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly status: WatcherStatus;
    readonly task?: string;
    readonly workspaceId?: string;
    readonly workspaceName?: string;
    readonly provider?: 'lnwjing' | 'codex';
    readonly toolName?: string;
    readonly startedAt?: string;
  }>;
  readonly plugins?: ReadonlyArray<{
    readonly name: string;
    readonly provider: 'mcp';
    readonly enabled: boolean;
    readonly connected: boolean;
    readonly excluded: boolean;
    readonly lifecycle: 'disconnected' | 'connected' | 'termination_unverified';
  }>;
  readonly activity: readonly WatcherActivityEvent[];
  readonly git: WatcherGitSnapshot;
}

export interface WatcherServerOptions {
  readonly port: number;
  readonly pairingPort: number;
  /** Only automatic ports may move on EADDRINUSE; explicit choices fail closed. */
  readonly fallbackOnPortInUse?: boolean;
  /** Pairing may fall back independently when only one port is configured explicitly. */
  readonly fallbackOnPairingPortInUse?: boolean;
  readonly accessToken: string;
  readonly buildSnapshot: (recentActivity: readonly WatcherActivityEvent[]) => Promise<WatcherSnapshot>;
  readonly subscribeActivity: (listener: (event: WatcherActivityEvent) => void) => () => void;
}

export interface WatcherServerHandle {
  readonly endpoint: URL;
  readonly pairingEndpoint: URL;
  close(): Promise<void>;
}

const MAX_ACTIVITY = 100;
const WS_AUTH_TIMEOUT_MS = 5_000;

/** Keep pairing secrets on literal loopback hosts; reject rebinding Host and remote browser origins. */
function trustedPairingRequest(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true; // Native clients and navigation omit Origin.
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || null;
}

function cors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function json(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function pairingPage(endpoint: string, token: string): string {
  const safeEndpoint = escapeHtml(endpoint);
  const safeToken = escapeHtml(token);
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LNWJING Watcher Pairing</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#070b12;color:#f7f2e7}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 0%,#51381333,transparent 30rem),linear-gradient(180deg,#0b1019,#070b12)}main{width:min(720px,100%);border:1px solid #344155;border-radius:24px;padding:28px;background:linear-gradient(180deg,#121924fa,#0b111afa);box-shadow:0 28px 80px #000a}.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px}.mark{width:48px;height:48px;border:1px solid #765723;border-radius:15px;display:grid;place-items:center;color:#ffcf65;background:#21190c;font-size:24px}.brand strong{display:block;letter-spacing:.08em}.brand span{display:block;color:#f4b93f;font-size:.78rem;letter-spacing:.12em;margin-top:3px}.eyebrow{color:#f4b93f;font-size:.74rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(1.8rem,5vw,2.7rem);margin:8px 0 10px;letter-spacing:-.03em}p{color:#a6b2c0;line-height:1.65}.notice{margin:20px 0;padding:13px 14px;border:1px solid #5f4720;border-radius:14px;background:#21190d;color:#e6c67b}.field{margin-top:16px}.label{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:7px;color:#cbd3dc;font-weight:700}.value{display:block;width:100%;padding:13px 14px;border:1px solid #2b3748;border-radius:13px;background:#080d14;color:#f3d487;font:500 .88rem ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;user-select:all}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}button,a.button{min-height:44px;border-radius:12px;padding:10px 15px;font:inherit;font-size:.92rem;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid #39475a;background:#121a25;color:#e7edf4}.primary{border-color:#e3a936!important;background:linear-gradient(180deg,#efb743,#bd8120)!important;color:#130d04!important}button:focus-visible,a:focus-visible{outline:2px solid #ffcf65;outline-offset:3px}.foot{margin-top:22px;padding-top:18px;border-top:1px solid #263244;color:#7f8c9b;font-size:.8rem;line-height:1.6}.copied{color:#4ed28b}@media(max-width:560px){main{padding:20px;border-radius:20px}.actions>*{width:100%}}
</style>
</head>
<body>
<main>
  <div class="brand"><div class="mark" aria-hidden="true">◉</div><div><strong>LNWJING</strong><span>WATCHER PAIRING</span></div></div>
  <div class="eyebrow">Local pairing · จับคู่บนเครื่องนี้เท่านั้น</div>
  <h1>Connect LNWJING Watcher</h1>
  <p>คัดลอก <strong>Session token</strong> ไปใส่ใน LNWJING Watcher. หน้านี้เปิดได้เฉพาะเครื่องที่รัน LNWJING และไม่ควรถูกเผยแพร่ผ่าน tunnel.</p>
  <div class="notice">🔒 ห้ามนำ port <strong>17891</strong> ออก Public Internet. หากต้องดูจากมือถือหรือเครื่องอื่น ให้ tunnel เฉพาะ Watcher API port <strong>17890</strong>.</div>
  <div class="field"><div class="label"><span>Session token</span><span id="token-status"></span></div><code class="value" id="token">${safeToken}</code></div>
  <div class="actions"><button class="primary" id="copy-token" type="button">Copy Session token · คัดลอก Token</button></div>
  <div class="field"><div class="label"><span>Local Watcher endpoint</span><span id="endpoint-status"></span></div><code class="value" id="endpoint">${safeEndpoint}</code></div>
  <div class="actions"><button id="copy-endpoint" type="button">Copy endpoint</button><a class="button" href="?format=json">View JSON</a></div>
  <div class="foot">Session token เป็นความลับสำหรับอ่านสถานะ Watcher. Watcher Web/PWA รุ่นใหม่สามารถจำ token ใน browser ได้สูงสุด 60 วัน ส่วนแอป Desktop/มือถือจะเก็บไว้ในเครื่องจนกว่าผู้ใช้จะล้างออก. หลีกเลี่ยงการบันทึกบนเครื่องที่ใช้ร่วมกับผู้อื่น.</div>
</main>
<script>
async function copyValue(sourceId,statusId,buttonId){const value=document.getElementById(sourceId).textContent||'';const status=document.getElementById(statusId);const button=document.getElementById(buttonId);try{await navigator.clipboard.writeText(value);status.textContent='Copied ✓';status.className='copied';const original=button.textContent;button.textContent='Copied ✓';setTimeout(()=>{status.textContent='';button.textContent=original},1600)}catch{window.prompt('Copy manually:',value)}}
document.getElementById('copy-token').addEventListener('click',()=>copyValue('token','token-status','copy-token'));
document.getElementById('copy-endpoint').addEventListener('click',()=>copyValue('endpoint','endpoint-status','copy-endpoint'));
</script>
</body>
</html>`;
}

function html(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  response.end(body);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('error', onError); reject(error); };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('Watcher server did not expose a TCP address'));
      resolve(address.port);
    });
  });
}

function isPortInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE';
}

async function listenWithFallback(server: Server, port: number, enabled: boolean): Promise<number> {
  try {
    return await listen(server, port);
  } catch (error) {
    if (!enabled || port === 0 || !isPortInUse(error)) throw error;
    return listen(server, 0);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

export async function startWatcherServer(options: WatcherServerOptions): Promise<WatcherServerHandle> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error('Watcher port must be an integer from 0 to 65535');
  if (!Number.isInteger(options.pairingPort) || options.pairingPort < 0 || options.pairingPort > 65_535) throw new Error('Watcher pairing port must be an integer from 0 to 65535');
  if (options.accessToken.trim().length < 32) throw new Error('Watcher access token must contain at least 32 characters');

  const recentActivity: WatcherActivityEvent[] = [];
  const authorizedSockets = new Set<WebSocket>();

  const apiServer = createServer((request, response): void => {
    void (async (): Promise<void> => {
      cors(response);
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== '/api/v1/snapshot') {
        json(response, 404, { error: 'not_found' });
        return;
      }

      const token = bearerToken(request);
      if (token === null || !tokenMatches(options.accessToken, token)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        json(response, 401, { error: 'unauthorized' });
        return;
      }

      json(response, 200, await options.buildSnapshot(recentActivity));
    })().catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'internal_error' });
      else response.destroy();
    });
  });

  const webSockets = new WebSocketServer({ noServer: true });
  apiServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/v1/events') {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit('connection', client, request));
  });

  webSockets.on('connection', (client) => {
    const authTimer = setTimeout(() => client.close(4401, 'authentication required'), WS_AUTH_TIMEOUT_MS);
    authTimer.unref();

    const authenticate = (raw: Buffer): void => {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { readonly type?: unknown; readonly token?: unknown };
        if (parsed.type !== 'auth' || typeof parsed.token !== 'string' || !tokenMatches(options.accessToken, parsed.token)) {
          client.close(4401, 'authentication failed');
          return;
        }
        clearTimeout(authTimer);
        authorizedSockets.add(client);
        client.off('message', authenticate);
        client.send(JSON.stringify({ type: 'ready', protocolVersion: 1 }));
      } catch {
        client.close(4400, 'invalid authentication frame');
      }
    };

    client.on('message', authenticate);
    client.on('close', () => {
      clearTimeout(authTimer);
      authorizedSockets.delete(client);
    });
  });

  const apiPort = await listenWithFallback(apiServer, options.port, options.fallbackOnPortInUse === true);

  let pairingPort = 0;
  const pairingServer = createServer((request, response) => {
    if (!trustedPairingRequest(request, pairingPort)) {
      json(response, 403, { error: 'forbidden' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== '/api/v1/pair') {
      json(response, 404, { error: 'not_found' });
      return;
    }
    const pair = {
      protocolVersion: 1 as const,
      endpoint: `http://127.0.0.1:${apiPort}`,
      token: options.accessToken,
    };
    if (url.searchParams.get('format') !== 'json' && request.headers.accept?.includes('text/html')) {
      html(response, 200, pairingPage(pair.endpoint, pair.token));
      return;
    }
    json(response, 200, pair);
  });

  try {
    pairingPort = await listenWithFallback(pairingServer, options.pairingPort,
      (options.fallbackOnPairingPortInUse ?? options.fallbackOnPortInUse) === true);
  } catch (error) {
    await closeServer(apiServer).catch(() => undefined);
    webSockets.close();
    throw error;
  }

  const unsubscribe = options.subscribeActivity((event) => {
    recentActivity.unshift(event);
    if (recentActivity.length > MAX_ACTIVITY) recentActivity.length = MAX_ACTIVITY;
    const message = JSON.stringify(event);
    for (const client of authorizedSockets) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  });

  const heartbeat = setInterval(() => {
    for (const client of authorizedSockets) if (client.readyState === WebSocket.OPEN) client.ping();
  }, 20_000);
  heartbeat.unref();

  return {
    endpoint: new URL(`http://127.0.0.1:${apiPort}`),
    pairingEndpoint: new URL(`http://127.0.0.1:${pairingPort}/api/v1/pair`),
    async close(): Promise<void> {
      unsubscribe();
      clearInterval(heartbeat);
      for (const client of authorizedSockets) client.close(1001, 'runtime shutdown');
      authorizedSockets.clear();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await Promise.all([closeServer(apiServer), closeServer(pairingServer)]);
    },
  };
}
