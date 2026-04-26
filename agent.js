#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// CNIB — Agente Local de Login com Certificado Digital
//
// Roda na máquina do usuário (Windows) que tem o token A3.
// Abre o Chrome localmente com remote debugging, navega para
// o login do ONR, aguarda a autenticação com o Web PKI,
// captura os cookies e os envia para a VPS.
//
// Uso:
//   node agent.js <sessionId> [url_da_vps]
//
// Exemplo:
//   node agent.js abc123def456 https://cnib.jumoreira.online
//
// O sessionId é gerado pela VPS e exibido na tela do sistema.
// ═══════════════════════════════════════════════════════════

const puppeteer = require('puppeteer');
const { exec }  = require('child_process');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');

// ── Configuração ────────────────────────────────────────────
const SESSION_ID = process.argv[2];
const VPS_URL    = (process.argv[3] || 'https://cnib.jumoreira.online').replace(/\/$/, '');
const DEBUG_PORT = 9222;
const USER_DATA  = 'C:\\Temp\\ChromeDebug';
const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutos para o usuário autenticar

if (!SESSION_ID) {
    console.error('\n❌ Uso: node agent.js <sessionId> [url_da_vps]');
    console.error('   O sessionId é exibido na tela do sistema ao clicar em "Login com Certificado".\n');
    process.exit(1);
}

console.log('═══════════════════════════════════════════════════');
console.log('  CNIB — Agente de Login com Certificado Digital   ');
console.log('═══════════════════════════════════════════════════');
console.log(`  Sessão  : ${SESSION_ID}`);
console.log(`  VPS     : ${VPS_URL}`);
console.log(`  Porta   : ${DEBUG_PORT}`);
console.log('═══════════════════════════════════════════════════\n');

// ── Detecta Chrome ──────────────────────────────────────────
function detectChromePath() {
    const homeDir = require('os').homedir();
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

// ── Tenta conectar ao Chrome na porta de debug ──────────────
async function connectToChrome() {
    try {
        return await puppeteer.connect({
            browserURL: `http://localhost:${DEBUG_PORT}`,
            defaultViewport: null,
        });
    } catch {
        return null;
    }
}

// ── Abre Chrome com remote debugging via PowerShell ─────────
function openChrome(chromePath) {
    return new Promise((resolve) => {
        try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch {}
        const cmd = `powershell -Command "Start-Process '${chromePath}' -ArgumentList '--remote-debugging-port=${DEBUG_PORT}','--user-data-dir=${USER_DATA}','--no-first-run'"`;
        console.log('🌐 Abrindo Chrome com remote debugging...');
        exec(cmd, (err) => { if (err) console.warn('   (aviso exec):', err.message); });
        resolve();
    });
}

// ── Envia cookies para a VPS ────────────────────────────────
function pushCookiesToVPS(cookies) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ sessionId: SESSION_ID, cookies });
        const url  = new URL(`${VPS_URL}/api/cert-login/push-cookies`);
        const lib  = url.protocol === 'https:' ? https : http;

        const req = lib.request({
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            // Aceita certificados autoassinados em dev
            rejectUnauthorized: false,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve({ ok: false }); }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Main ────────────────────────────────────────────────────
(async () => {
    // 1. Tenta conectar ao Chrome já aberto com debug
    console.log('🔍 Verificando Chrome na porta', DEBUG_PORT, '...');
    let browser = await connectToChrome();

    if (!browser) {
        // 2. Chrome não está em modo debug — abre
        const chromePath = detectChromePath();
        if (!chromePath) {
            console.error('\n❌ Chrome não encontrado. Instale o Google Chrome e tente novamente.');
            process.exit(1);
        }

        await openChrome(chromePath);
        console.log('⏳ Aguardando Chrome inicializar...');

        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            process.stdout.write(`   tentativa ${i+1}/15...\r`);
            browser = await connectToChrome();
            if (browser) break;
        }

        if (!browser) {
            console.error('\n❌ Chrome não respondeu na porta', DEBUG_PORT, 'em 15 segundos.');
            console.error('   Tente fechar o Chrome completamente e rodar o agente novamente.');
            process.exit(1);
        }
    }

    console.log('\n✅ Conectado ao Chrome!\n');

    // 3. Abre aba de login do ONR
    console.log('🔐 Abrindo página de login do ONR...');
    const page = await browser.newPage();
    await page.goto('https://indisponibilidade.onr.org.br/login/certificate', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    await page.bringToFront().catch(() => {});

    console.log('─────────────────────────────────────────────────');
    console.log('  👆 Autentique-se na janela do Chrome:');
    console.log('     1. Selecione o certificado CERTSIGN RFB');
    console.log('     2. Clique em Acessar');
    console.log('     3. Digite a senha do token no popup do Web PKI');
    console.log('─────────────────────────────────────────────────\n');

    // 4. Monitora cookies até detectar o login
    const deadline = Date.now() + TIMEOUT_MS;
    let cookieStr  = null;

    process.stdout.write('⏳ Aguardando autenticação');

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        process.stdout.write('.');

        // Verifica se a aba ainda existe
        try { await page.evaluate(() => true); } catch { break; }

        const currentUrl = page.url();
        const cookies    = await page.cookies('https://indisponibilidade.onr.org.br').catch(() => []);
        const cnibUser   = cookies.find(c => c.name === 'CNIB_USER');
        const cnibAuth   = cookies.find(c => c.name === 'CNIB.Auth' || c.name === 'CNIB.AuthC1');

        if (cnibUser || (cnibAuth && currentUrl.includes('indisponibilidade.onr.org.br'))) {
            const allCookies = await page.cookies('https://indisponibilidade.onr.org.br').catch(() => []);
            cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
            break;
        }
    }

    process.stdout.write('\n');

    if (!cookieStr) {
        console.error('\n❌ Timeout — nenhuma autenticação detectada em 3 minutos.');
        try { await page.close(); } catch {}
        process.exit(1);
    }

    console.log(`\n✅ Login detectado! ${cookieStr.split(';').length} cookies capturados.`);

    // 5. Fecha a aba de login
    try { await page.close(); } catch {}

    // 6. Envia cookies para a VPS
    console.log('📤 Enviando cookies para a VPS...');
    try {
        const result = await pushCookiesToVPS(cookieStr);
        if (result.ok) {
            console.log('\n🎉 Sucesso! Você já está autenticado no sistema.');
            console.log('   Volte para o navegador — o sistema detectará o login automaticamente.\n');
        } else {
            console.error('\n❌ VPS recusou os cookies:', JSON.stringify(result));
        }
    } catch (err) {
        console.error('\n❌ Erro ao enviar cookies para a VPS:', err.message);
    }

    process.exit(0);
})();