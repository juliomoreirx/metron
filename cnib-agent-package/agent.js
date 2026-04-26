"use strict";
// ═══════════════════════════════════════════════════════════
// CNIB — Agente Local de Login com Certificado Digital
// Chamado pelo protocolo cnib:// ou pelo launcher.vbs
// ═══════════════════════════════════════════════════════════

const { exec, execSync, spawnSync } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const os     = require('os');
const net    = require('net');

const DEBUG_PORT = 9222;
const USER_DATA  = path.join(os.tmpdir(), 'cnib-chrome-debug');
const TIMEOUT_MS = 3 * 60 * 1000;

// ── Parse do argumento cnib://sessionId@host ────────────────
function parseArgs() {
    const raw = process.argv[2] || '';
    if (raw.startsWith('cnib://')) {
        const inner = raw.slice('cnib://'.length);
        const atIdx = inner.indexOf('@');
        if (atIdx === -1) return { sessionId: inner, vpsUrl: 'https://cnib.jumoreira.online' };
        const sessionId = inner.slice(0, atIdx);
        const host      = inner.slice(atIdx + 1);
        const vpsUrl    = host.startsWith('http') ? host : `https://${host}`;
        return { sessionId, vpsUrl };
    }
    return {
        sessionId: process.argv[2] || '',
        vpsUrl:    (process.argv[3] || 'https://cnib.jumoreira.online').replace(/\/$/, ''),
    };
}

const { sessionId: SESSION_ID, vpsUrl: VPS_URL } = parseArgs();

if (!SESSION_ID) {
    showMsg('Sessão inválida. Volte ao sistema e tente novamente.');
    process.exit(1);
}

function showMsg(msg) {
    // No Windows exibe uma caixa de diálogo nativa em vez do terminal
    if (process.platform === 'win32') {
        spawnSync('mshta', [
            'vbscript:Execute("MsgBox """ + msg + """,0,""CNIB"":close")'
                .replace('msg', JSON.stringify(msg).slice(1, -1))
        ], { timeout: 10000 });
    } else {
        console.log(msg);
    }
}

// ── Detecta o executável do Chrome ─────────────────────────
function detectChromePath() {
    const homeDir = os.homedir();
    return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// ── Verifica se a porta 9222 está escutando ─────────────────
function isPortOpen() {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.on('connect', () => { sock.destroy(); resolve(true);  });
        sock.on('error',   () => { sock.destroy(); resolve(false); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(DEBUG_PORT, '127.0.0.1');
    });
}

// ── Abre Chrome via PowerShell (processo independente) ──────
function openChrome(chromePath) {
    return new Promise((resolve) => {
        try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch {}

        // PowerShell Start-Process garante que o Chrome abra como processo
        // completamente independente com as flags corretas
        const args = [
            '--remote-debugging-port=' + DEBUG_PORT,
            '--user-data-dir=' + USER_DATA,
            '--no-first-run',
            '--no-default-browser-check',
        ].join("','");

        const cmd = `powershell -WindowStyle Hidden -Command "Start-Process '${chromePath}' -ArgumentList '${args}'"`;
        exec(cmd, (err) => { if (err) console.error('Chrome launch error:', err.message); });
        resolve();
    });
}

// ── HTTP GET simples para o endpoint DevTools ───────────────
function fetchDevTools() {
    return new Promise((resolve) => {
        const req = http.get('http://localhost:' + DEBUG_PORT + '/json/version', { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// ── Obtém cookies via CDP (sem Puppeteer!) ──────────────────
// Puppeteer bundled não funciona bem no pkg — usamos WebSocket CDP direto
function getCookiesViaCDP(wsUrl, domain) {
    return new Promise((resolve) => {
        const url    = new URL(wsUrl);
        const WS     = require('net');
        let   buffer = '';
        let   msgId  = 1;

        // Handshake WebSocket manual
        const key = Buffer.from(Math.random().toString(36)).toString('base64');
        const sock = WS.createConnection({ host: url.hostname, port: url.port || 9222 }, () => {
            const handshake = [
                `GET ${url.pathname} HTTP/1.1`,
                `Host: ${url.host}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                '', '',
            ].join('\r\n');
            sock.write(handshake);
        });

        let upgraded = false;
        let cookies  = null;

        sock.on('data', (chunk) => {
            if (!upgraded) {
                const str = chunk.toString();
                if (str.includes('101')) {
                    upgraded = true;
                    // Navega para a página do ONR
                    sendCDP(sock, msgId++, 'Page.navigate', { url: 'https://indisponibilidade.onr.org.br/login/certificate' });
                }
                return;
            }

            // Parseia frames WebSocket simples (sem masking, payload < 65535)
            let i = 0;
            while (i < chunk.length) {
                if (i + 2 > chunk.length) break;
                const payloadLen = chunk[i + 1] & 0x7f;
                if (payloadLen >= 126) { i += 2 + (payloadLen === 126 ? 2 : 8); continue; }
                const payload = chunk.slice(i + 2, i + 2 + payloadLen).toString();
                i += 2 + payloadLen;
                try {
                    const msg = JSON.parse(payload);
                    if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.navigatedWithinDocument') {
                        // Pede a URL atual
                        sendCDP(sock, msgId++, 'Runtime.evaluate', { expression: 'location.href' });
                    }
                    if (msg.result && msg.result.result && msg.result.result.value) {
                        const href = msg.result.result.value;
                        if (href && href.includes('indisponibilidade.onr.org.br') && href !== 'about:blank') {
                            // Busca os cookies
                            sendCDP(sock, msgId++, 'Network.getCookies', { urls: ['https://indisponibilidade.onr.org.br'] });
                        }
                    }
                    if (msg.result && msg.result.cookies) {
                        const cnibUser = msg.result.cookies.find(c => c.name === 'CNIB_USER');
                        const cnibAuth = msg.result.cookies.find(c => c.name === 'CNIB.Auth' || c.name === 'CNIB.AuthC1');
                        if (cnibUser || cnibAuth) {
                            cookies = msg.result.cookies.map(c => `${c.name}=${c.value}`).join('; ');
                            sock.destroy();
                            resolve(cookies);
                        }
                    }
                } catch {}
            }
        });

        sock.on('error', () => resolve(null));
        sock.on('close', () => { if (!cookies) resolve(null); });

        // Timeout
        setTimeout(() => { sock.destroy(); resolve(cookies); }, TIMEOUT_MS);
    });
}

function sendCDP(sock, id, method, params) {
    const msg    = JSON.stringify({ id, method, params: params || {} });
    const buf    = Buffer.from(msg);
    const frame  = Buffer.alloc(2 + buf.length);
    frame[0]     = 0x81; // FIN + text frame
    frame[1]     = buf.length;
    buf.copy(frame, 2);
    sock.write(frame);
}

// ── Envia cookies para a VPS ────────────────────────────────
function pushCookies(cookies) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ sessionId: SESSION_ID, cookies });
        const url  = new URL(VPS_URL + '/api/cert-login/push-cookies');
        const lib  = url.protocol === 'https:' ? https : http;
        const req  = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            rejectUnauthorized: false,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── MAIN ────────────────────────────────────────────────────
(async () => {
    // 1. Abre o Chrome se não estiver aberto com debug
    const portJaAberta = await isPortOpen();

    if (!portJaAberta) {
        const chromePath = detectChromePath();
        if (!chromePath) {
            showMsg('Google Chrome não encontrado. Por favor instale o Chrome e tente novamente.');
            process.exit(1);
        }
        await openChrome(chromePath);

        // Aguarda até 15s a porta abrir
        let abriu = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            abriu = await isPortOpen();
            if (abriu) break;
        }

        if (!abriu) {
            showMsg('Chrome não iniciou corretamente. Tente fechar o Chrome e tentar novamente.');
            process.exit(1);
        }
    }

    // 2. Conecta via DevTools para obter a lista de páginas
    await new Promise(r => setTimeout(r, 500)); // pequena pausa para o Chrome estabilizar
    const devtools = await fetchDevTools();

    if (!devtools || !devtools.webSocketDebuggerUrl) {
        showMsg('Não foi possível conectar ao Chrome. Tente novamente.');
        process.exit(1);
    }

    // 3. Abre nova aba em branco e navega para o ONR via CDP
    const newTab = await new Promise((resolve) => {
        // /json/new sem parâmetro abre aba em branco e retorna o ID+wsUrl
        http.get(
            `http://localhost:${DEBUG_PORT}/json/new`,
            { timeout: 5000 },
            (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
            }
        ).on('error', () => resolve(null));
    });

    if (!newTab || !newTab.webSocketDebuggerUrl) {
        showMsg('Não foi possível abrir aba no Chrome. Tente novamente.');
        process.exit(1);
    }

    // Navega para o ONR via CDP Page.navigate na aba recém-aberta
    await new Promise((resolve) => {
        const wsUrl  = new URL(newTab.webSocketDebuggerUrl);
        const key    = Buffer.from('cnib-nav-' + Math.random()).toString('base64').slice(0, 24);
        const navMsg = JSON.stringify({
            id: 1,
            method: 'Page.navigate',
            params: { url: 'https://indisponibilidade.onr.org.br/login/certificate' }
        });
        const buf   = Buffer.from(navMsg);
        const frame = Buffer.alloc(2 + buf.length);
        frame[0] = 0x81; frame[1] = buf.length;
        buf.copy(frame, 2);

        const sock = net.createConnection({ host: '127.0.0.1', port: DEBUG_PORT }, () => {
            sock.write([
                `GET ${wsUrl.pathname} HTTP/1.1`,
                `Host: localhost:${DEBUG_PORT}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                '', '',
            ].join('\r\n'));
        });

        let upgraded = false;
        sock.setTimeout(6000);
        sock.on('data', (chunk) => {
            if (!upgraded) {
                if (chunk.toString().includes('101')) {
                    upgraded = true;
                    sock.write(frame); // envia Page.navigate
                }
                return;
            }
            // Recebeu resposta do navigate — fecha e resolve
            sock.destroy();
            resolve();
        });
        sock.on('error', () => resolve());
        sock.on('timeout', () => { sock.destroy(); resolve(); });
    });

    // Aguarda a página carregar um pouco antes de começar o polling
    await new Promise(r => setTimeout(r, 2000));

    // 4. Monitora cookies via CDP polling (mais simples e compatível com pkg)
    const deadline = Date.now() + TIMEOUT_MS;
    let cookieStr  = null;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));

        // Usa /json/list para verificar a URL atual da aba
        const pages = await new Promise((resolve) => {
            http.get(`http://localhost:${DEBUG_PORT}/json/list`, { timeout: 3000 }, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
            }).on('error', () => resolve([]));
        });

        // Procura a aba do ONR
        const onrTab = pages.find(p =>
            p.url && p.url.includes('indisponibilidade.onr.org.br') && p.type === 'page'
        );

        if (!onrTab) continue;

        // Verifica cookies via Network.getCookies pelo WebSocket
        const cookies = await new Promise((resolve) => {
            const ws = newTab.webSocketDebuggerUrl || onrTab.webSocketDebuggerUrl;
            const reqMsg = JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: ['https://indisponibilidade.onr.org.br'] } });
            const buf    = Buffer.from(reqMsg);
            const frame  = Buffer.alloc(2 + buf.length);
            frame[0] = 0x81; frame[1] = buf.length;
            buf.copy(frame, 2);

            const sock = net.createConnection({ host: '127.0.0.1', port: DEBUG_PORT }, () => {
                // Handshake
                const wsPath = new URL(onrTab.webSocketDebuggerUrl).pathname;
                const key    = Buffer.from('cnib' + Math.random()).toString('base64');
                sock.write([
                    `GET ${wsPath} HTTP/1.1`, `Host: localhost:${DEBUG_PORT}`,
                    'Upgrade: websocket', 'Connection: Upgrade',
                    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
                ].join('\r\n'));
            });

            let upgraded = false;
            let result   = null;
            sock.setTimeout(4000);

            sock.on('data', (chunk) => {
                if (!upgraded) {
                    if (chunk.toString().includes('101')) {
                        upgraded = true;
                        sock.write(frame);
                    }
                    return;
                }
                try {
                    // Extrai payload do frame WebSocket
                    let offset = 2;
                    const len  = chunk[1] & 0x7f;
                    if (len === 126) offset += 2;
                    else if (len === 127) offset += 8;
                    const payload = chunk.slice(offset).toString();
                    const msg     = JSON.parse(payload);
                    if (msg.result && msg.result.cookies) {
                        result = msg.result.cookies;
                        sock.destroy();
                        resolve(result);
                    }
                } catch {}
            });
            sock.on('error', () => resolve(null));
            sock.on('timeout', () => { sock.destroy(); resolve(null); });
            sock.on('close', () => { if (!result) resolve(null); });
        });

        if (cookies) {
            const cnibUser = cookies.find(c => c.name === 'CNIB_USER');
            const cnibAuth = cookies.find(c => c.name === 'CNIB.Auth' || c.name === 'CNIB.AuthC1');
            if (cnibUser || cnibAuth) {
                cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                break;
            }
        }
    }

    if (!cookieStr) {
        showMsg('Tempo esgotado sem autenticação detectada. Tente novamente.');
        process.exit(1);
    }

    // 5. Fecha a aba do ONR
    http.get(`http://localhost:${DEBUG_PORT}/json/close/${newTab.id}`, () => {}).on('error', () => {});

    // 6. Envia cookies para a VPS
    try {
        const result = await pushCookies(cookieStr);
        if (result.ok) {
            // Silencioso — o site detecta automaticamente
        } else {
            showMsg('Erro ao enviar sessão para o servidor. Tente novamente.');
        }
    } catch (err) {
        showMsg('Erro de conexão com o servidor: ' + err.message);
    }

    process.exit(0);
})();