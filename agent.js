#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// CNIB — Agente Local de Login com Certificado Digital
// Chamado automaticamente pelo protocolo cnib://
// ═══════════════════════════════════════════════════════════

const puppeteer = require('puppeteer');
const { exec }  = require('child_process');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');

const DEBUG_PORT = 9222;
const USER_DATA  = path.join(require('os').tmpdir(), 'cnib-chrome-debug');
const TIMEOUT_MS = 3 * 60 * 1000;

function parseArgs() {
    const raw = process.argv[2] || '';
    if (raw.startsWith('cnib://')) {
        const inner  = raw.slice('cnib://'.length);
        const atIdx  = inner.indexOf('@');
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
    console.error('Sessao invalida. Volte ao sistema e tente novamente.');
    if (process.platform === 'win32') exec('msg * "Sessao invalida. Volte ao sistema e tente novamente."', ()=>{});
    process.exit(1);
}

console.log('');
console.log('CNIB - Login com Certificado Digital');
console.log('Sessao :', SESSION_ID);
console.log('Servidor:', VPS_URL);
console.log('');

function detectChromePath() {
    const homeDir = require('os').homedir();
    return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].find(p => fs.existsSync(p)) || null;
}

async function connectToChrome() {
    try {
        return await puppeteer.connect({ browserURL: `http://localhost:${DEBUG_PORT}`, defaultViewport: null });
    } catch { return null; }
}

function openChrome(chromePath) {
    return new Promise((resolve) => {
        try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch {}
        const cmd = `powershell -Command "Start-Process '${chromePath}' -ArgumentList '--remote-debugging-port=${DEBUG_PORT}','--user-data-dir=${USER_DATA}','--no-first-run'"`;
        exec(cmd, (err) => { if (err) console.warn('aviso:', err.message); });
        resolve();
    });
}

function pushCookies(cookies) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ sessionId: SESSION_ID, cookies });
        const url  = new URL(`${VPS_URL}/api/cert-login/push-cookies`);
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

(async () => {
    console.log('Verificando Chrome na porta', DEBUG_PORT, '...');
    let browser = await connectToChrome();

    if (!browser) {
        const chromePath = detectChromePath();
        if (!chromePath) {
            const msg = 'Google Chrome nao encontrado. Instale o Chrome e tente novamente.';
            console.error(msg);
            if (process.platform === 'win32') exec(`msg * "${msg}"`, ()=>{});
            process.exit(1);
        }
        console.log('Abrindo Chrome...');
        await openChrome(chromePath);
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            process.stdout.write(`aguardando (${i+1}/15)...\r`);
            browser = await connectToChrome();
            if (browser) break;
        }
        process.stdout.write('\n');
        if (!browser) {
            const msg = 'Chrome nao respondeu. Tente novamente.';
            console.error(msg);
            if (process.platform === 'win32') exec(`msg * "${msg}"`, ()=>{});
            process.exit(1);
        }
    }

    console.log('Chrome conectado!\n');
    console.log('Abrindo login do ONR...');
    const page = await browser.newPage();

    await page.goto('https://indisponibilidade.onr.org.br/login/certificate', {
        waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(async (err) => {
        console.error('Erro ao carregar ONR:', err.message);
        await page.close().catch(() => {});
        process.exit(1);
    });

    await page.bringToFront().catch(() => {});

    console.log('');
    console.log('No Chrome que abriu:');
    console.log('  1. Selecione o certificado CERTSIGN RFB');
    console.log('  2. Clique em Acessar');
    console.log('  3. Digite a senha do token');
    console.log('');

    const deadline = Date.now() + TIMEOUT_MS;
    let cookieStr  = null;
    process.stdout.write('Aguardando autenticacao');

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        process.stdout.write('.');
        try { await page.evaluate(() => true); } catch { break; }

        const currentUrl = page.url();
        const cookies    = await page.cookies('https://indisponibilidade.onr.org.br').catch(() => []);
        const cnibUser   = cookies.find(c => c.name === 'CNIB_USER');
        const cnibAuth   = cookies.find(c => c.name === 'CNIB.Auth' || c.name === 'CNIB.AuthC1');

        if (cnibUser || (cnibAuth && currentUrl.includes('indisponibilidade.onr.org.br'))) {
            const all = await page.cookies('https://indisponibilidade.onr.org.br').catch(() => []);
            cookieStr = all.map(c => `${c.name}=${c.value}`).join('; ');
            break;
        }
    }

    process.stdout.write('\n');

    if (!cookieStr) {
        console.error('Timeout - nenhuma autenticacao detectada.');
        await page.close().catch(() => {});
        process.exit(1);
    }

    console.log('Login detectado! Enviando para o servidor...');
    await page.close().catch(() => {});

    try {
        const result = await pushCookies(cookieStr);
        if (result.ok) {
            console.log('\nPronto! Volte ao navegador - voce ja esta autenticado.\n');
            if (process.platform === 'win32') await new Promise(r => setTimeout(r, 3000));
        } else {
            console.error('Servidor recusou:', JSON.stringify(result));
        }
    } catch (err) {
        console.error('Erro ao enviar:', err.message);
    }

    process.exit(0);
})();
