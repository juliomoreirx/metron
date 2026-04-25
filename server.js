"use strict";

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const FormData  = require('form-data');
const path      = require('path');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// PUPPETEER POOL — reutiliza uma única instância do browser
// evita abrir/fechar Chrome a cada pesquisa (economiza ~150MB por sessão)
// ═══════════════════════════════════════════════════════════
let sharedBrowser = null;
let browserPending = null;   // Promise em andamento durante a criação
let browserUseCount = 0;
const BROWSER_RECYCLE_AFTER = 20; // recicla o browser a cada 20 usos

async function getBrowser() {
    // Se já tem browser vivo, retorna ele
    if (sharedBrowser) {
        try {
            // Verifica se ainda está vivo
            await sharedBrowser.version();
            if (browserUseCount >= BROWSER_RECYCLE_AFTER) {
                console.log('[POOL] Reciclando browser após', browserUseCount, 'usos');
                await sharedBrowser.close().catch(() => {});
                sharedBrowser = null;
            } else {
                return sharedBrowser;
            }
        } catch {
            console.log('[POOL] Browser morreu, recriando...');
            sharedBrowser = null;
        }
    }

    // Se já tem uma criação em andamento, aguarda ela
    if (browserPending) return browserPending;

    browserPending = (async () => {
        console.log('[POOL] Criando nova instância do browser...');
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--no-first-run',
                '--no-zygote',
                '--single-process',           // economiza RAM significativamente
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--hide-scrollbars',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-default-browser-check',
                '--safebrowsing-disable-auto-update',
            ],
        });
        browserUseCount = 0;
        sharedBrowser = browser;
        browserPending = null;

        // Se o browser cair inesperadamente, limpa referência
        browser.on('disconnected', () => {
            console.log('[POOL] Browser desconectado');
            sharedBrowser = null;
        });

        return browser;
    })();

    return browserPending;
}

// ═══════════════════════════════════════════════════════════
// FUNÇÃO ORIGINAL — não alterada
// ═══════════════════════════════════════════════════════════
async function requestONR(documento, cookieString) {
    const form = new FormData();
    form.append('HashType', 'ConsultaTabeliao');
    form.append('DocumentNumber', documento);
    form.append('HashFilter', '');

    console.log(`\n[->] ONR: Iniciando consulta para o documento: ${documento}`);

    try {
        const response = await axios.post(
            'https://indisponibilidade.onr.org.br/ordem/consultar/tabeliao/resultado',
            form,
            {
                headers: {
                    ...form.getHeaders(),
                    'Cookie': cookieString,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Origin': 'https://indisponibilidade.onr.org.br',
                    'Referer': 'https://indisponibilidade.onr.org.br/ordem/consultar/tabeliao'
                },
                maxRedirects: 0,
                timeout: 15000,
                validateStatus: status => status >= 200 && status < 400
            }
        );

        console.log(`[<-] ONR: Resposta recebida. Status: ${response.status}`);
        return response;

    } catch (error) {
        console.error(`[X] ONR: Erro na requisição:`, error.message);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════
// SESSÃO BLAZOR — controla o Puppeteer em background
// ═══════════════════════════════════════════════════════════
const blazorSessions = new Map();

function getCookieKey(cookieString) {
    const m = cookieString.match(/CNIB_USER=([^;]+)/);
    return m ? m[1].slice(0, 32) : cookieString.slice(0, 32);
}

async function popularSessaoBlazor(documento, cookieString) {
    const key = getCookieKey(cookieString);

    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    blazorSessions.set(key, { promise, status: 'running', resolveFn, rejectFn });

    const docMasked = documento.replace(/\D/g,'').slice(0,3) + '***';
    console.log(`\n[BLAZOR] Iniciando para doc ${docMasked}`);

    (async () => {
        let page;
        try {
            let browser;
            try {
                browser = await getBrowser();
            } catch (launchErr) {
                console.error('[BLAZOR] ✗ FALHA AO ABRIR BROWSER (Puppeteer):');
                console.error('  → Mensagem:', launchErr.message);
                if (launchErr.message.includes('Could not find') || launchErr.message.includes('No usable sandbox')) {
                    console.error('  → CAUSA PROVÁVEL: Chrome/Chromium não está instalado.');
                    console.error('  → SOLUÇÃO: Execute "npx puppeteer browsers install chrome" ou instale o Chromium:');
                    console.error('             sudo apt-get install -y chromium-browser');
                } else if (launchErr.message.includes('EACCES') || launchErr.message.includes('permission')) {
                    console.error('  → CAUSA PROVÁVEL: Permissão negada ao executável do Chrome.');
                    console.error('  → SOLUÇÃO: chmod +x no binário do Chrome, ou rode sem --no-sandbox com cautela.');
                } else if (launchErr.message.includes('ENOMEM') || launchErr.message.includes('out of memory')) {
                    console.error('  → CAUSA PROVÁVEL: Memória insuficiente no servidor.');
                    console.error('  → SOLUÇÃO: Aumente a RAM ou reduza BROWSER_RECYCLE_AFTER.');
                } else {
                    console.error('  → Stack:', launchErr.stack);
                }
                throw launchErr;
            }
            browserUseCount++;

            page = await browser.newPage();

            // Bloqueia recursos desnecessários para economizar RAM e acelerar
            await page.setRequestInterception(true);
            page.on('request', req => {
                const t = req.resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(t)) req.abort();
                else req.continue();
            });

            // Viewport mínimo
            await page.setViewport({ width: 1024, height: 768 });

            const cookieArray = cookieString.split('; ').map(c => {
                const eq    = c.indexOf('=');
                const name  = c.slice(0, eq).trim();
                const value = c.slice(eq + 1);
                return { name, value, domain: 'indisponibilidade.onr.org.br', path: '/' };
            }).filter(c => c.name && c.value);

            await page.setCookie(...cookieArray);

            let gotoOk = false;
            try {
                await page.goto(
                    'https://indisponibilidade.onr.org.br/ordem/consulta/simplificada',
                    { waitUntil: 'networkidle2', timeout: 45000 }
                );
                gotoOk = true;
            } catch (navErr) {
                console.error('[BLAZOR] ✗ FALHA AO NAVEGAR PARA A PÁGINA:');
                console.error('  → Mensagem:', navErr.message);
                if (navErr.message.includes('net::ERR_NAME_NOT_RESOLVED') || navErr.message.includes('getaddrinfo')) {
                    console.error('  → CAUSA PROVÁVEL: Sem acesso à internet ou DNS falhou.');
                    console.error('  → SOLUÇÃO: Verifique a conectividade do servidor VPS com curl https://indisponibilidade.onr.org.br');
                } else if (navErr.message.includes('net::ERR_CONNECTION_REFUSED')) {
                    console.error('  → CAUSA PROVÁVEL: Servidor ONR recusou a conexão.');
                } else if (navErr.message.includes('timeout')) {
                    console.error('  → CAUSA PROVÁVEL: Timeout ao carregar a página (networkidle2 > 45s).');
                    console.error('  → SOLUÇÃO: Tente aumentar o timeout ou checar a latência da VPS com o ONR.');
                } else if (navErr.message.includes('net::ERR_CERT') || navErr.message.includes('SSL')) {
                    console.error('  → CAUSA PROVÁVEL: Problema de certificado SSL.');
                    console.error('  → SOLUÇÃO: Adicione --ignore-certificate-errors nos args do Puppeteer (temporário).');
                }
                throw navErr;
            }

            // Verifica se o cookie foi aceito (página pode redirecionar p/ login)
            const currentUrl = page.url();
            if (!currentUrl.includes('/ordem/consulta')) {
                const pageTitle = await page.title().catch(() => '?');
                console.error(`[BLAZOR] ✗ REDIRECIONADO PARA URL INESPERADA: ${currentUrl}`);
                console.error(`  → Título da página: "${pageTitle}"`);
                console.error('  → CAUSA PROVÁVEL: Cookie expirado ou rejeitado pelo ONR (sessão inválida).');
                console.error('  → SOLUÇÃO: Renove o cookie no Publisher ou via EditThisCookie.');
                throw new Error(`Redirecionado para ${currentUrl} — cookie pode estar inválido`);
            }
            console.log('[BLAZOR] Página carregada');

            const inputsInfo = await page.evaluate(() =>
                Array.from(document.querySelectorAll('input')).map(i => ({
                    id: i.id, name: i.name, type: i.type,
                    placeholder: i.placeholder, maxLength: i.maxLength,
                    visible: i.offsetParent !== null
                }))
            );
            console.log('[BLAZOR] Inputs:', JSON.stringify(inputsInfo));

            let inputHandle = null;
            const seletores = [
                'input[maxlength="14"]', 'input[maxlength="18"]',
                'input[placeholder*="CPF"]', 'input[placeholder*="CNPJ"]',
                'input[placeholder*="cpf"]', 'input[placeholder*="documento"]',
                'input[placeholder*="Documento"]',
                'input[type="text"]:not([readonly]):not([disabled])',
            ];

            for (const sel of seletores) {
                try {
                    inputHandle = await page.waitForSelector(sel, { timeout: 6000, visible: true });
                    if (inputHandle) { console.log(`[BLAZOR] Campo: ${sel}`); break; }
                } catch { /* tenta próximo */ }
            }

            if (!inputHandle) {
                console.error('[BLAZOR] ✗ CAMPO CPF/CNPJ NÃO ENCONTRADO NA PÁGINA:');
                console.error('  → Inputs encontrados:', JSON.stringify(inputsInfo));
                console.error('  → CAUSA PROVÁVEL: ONR mudou o layout da página, ou a sessão foi redirecionada.');
                console.error('  → SOLUÇÃO: Inspecione a URL atual e o HTML da página via Puppeteer para atualizar os seletores.');
                throw new Error('Campo CPF/CNPJ não encontrado na página');
            }

            const docRaw = documento.replace(/\D/g, '');
            await inputHandle.click({ clickCount: 3 });
            await inputHandle.type(docRaw, { delay: 40 });
            await inputHandle.evaluate(el => el.dispatchEvent(new Event('blur', { bubbles: true })));
            await new Promise(r => setTimeout(r, 700));

            const clicou = await page.evaluate(() => {
                const btns = [...document.querySelectorAll('button, input[type="submit"]')];
                const btn  = btns.find(b =>
                    b.offsetParent !== null &&
                    (b.textContent.match(/pesquis|buscar|consultar|search/i) || b.type === 'submit')
                );
                if (btn) { btn.click(); return btn.textContent.trim() || 'ok'; }
                return null;
            });

            if (!clicou) {
                console.log('[BLAZOR] Botão não encontrado, usando Enter');
                await inputHandle.press('Enter');
            } else {
                console.log(`[BLAZOR] Botão: "${clicou}"`);
            }

            await Promise.race([
                page.waitForFunction(
                    () => !document.querySelector("[class*='loading'],[class*='spinner']"),
                    { timeout: 20000 }
                ),
                new Promise(r => setTimeout(r, 12000)),
            ]).catch(() => {});

            await new Promise(r => setTimeout(r, 2000));

            console.log('[BLAZOR] ✓ Sessão populada');
            blazorSessions.set(key, { promise, status: 'ready', resolveFn, rejectFn });
            resolveFn('ready');

        } catch (err) {
            console.error('[BLAZOR] ✗', err.message);
            blazorSessions.set(key, { promise, status: 'error', resolveFn, rejectFn });
            rejectFn(err);
        } finally {
            // Fecha apenas a PAGE, não o browser — reutilizamos o browser
            if (page) await page.close().catch(() => {});
        }
    })();

    return promise;
}

// ═══════════════════════════════════════════════════════════
// ROTAS ORIGINAIS
// ═══════════════════════════════════════════════════════════

app.post('/api/validar', async (req, res) => {
    const { cookies } = req.body;
    console.log('\n--- Validação de Cookies ---');

    try {
        const response = await requestONR('00000000000', cookies);

        if (response.status === 200 && typeof response.data === 'object') {
            console.log('[OK] Validação bem sucedida.');
            res.json({ sucesso: true });
        } else {
            console.log('[AVISO] ONR recusou o cookie.');
            res.status(401).json({ sucesso: false, erro: 'Cookies inválidos ou expirados no ONR.' });
        }
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: 'Falha interna ao tentar validar.' });
    }
});

app.post('/api/consultar', async (req, res) => {
    const { documento, cookies } = req.body;
    console.log(`\n--- Nova Pesquisa: ${documento} ---`);

    if (!cookies) return res.status(400).json({ erro: 'Cookies não informados' });

    try {
        const response = await requestONR(documento, cookies);

        if (response.status === 302 || typeof response.data === 'string') {
            console.log('[AVISO] Sessão expirou.');
            return res.status(401).json({ erro: 'Sessão expirada' });
        }

        console.log('[OK] Dados enviados ao Front-end.');

        popularSessaoBlazor(documento, cookies).catch(err =>
            console.error('[BLAZOR-BG] Falha:', err.message)
        );

        res.json(response.data);

    } catch (error) {
        res.status(500).json({ erro: 'Falha ao processar a consulta no servidor.' });
    }
});

// ═══════════════════════════════════════════════════════════
// PDF
// ═══════════════════════════════════════════════════════════

app.post('/api/pdf/status', (req, res) => {
    const { cookies } = req.body;
    if (!cookies) return res.json({ status: 'unknown' });
    const session = blazorSessions.get(getCookieKey(cookies));
    if (!session)                     return res.json({ status: 'not_started' });
    if (session.status === 'running') return res.json({ status: 'preparing' });
    if (session.status === 'ready')   return res.json({ status: 'ready' });
    return res.json({ status: 'error' });
});

app.post('/api/pdf', async (req, res) => {
    const { cookies } = req.body;
    if (!cookies) return res.status(400).json({ erro: 'Cookies não informados.' });

    const key     = getCookieKey(cookies);
    const session = blazorSessions.get(key);
    console.log(`\n[PDF] Sessão: ${session ? session.status : 'não encontrada'}`);

    try {
        if (!session) return res.status(400).json({ erro: 'Pesquise um documento antes de gerar o PDF.' });

        if (session.status === 'running') {
            await Promise.race([
                session.promise,
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 35000)),
            ]);
        } else if (session.status === 'error') {
            return res.status(500).json({ erro: 'Falha ao preparar PDF. Pesquise o documento novamente.' });
        }

        const pdfRes = await axios.get(
            'https://indisponibilidade.onr.org.br/relatorio/certidao/tabeliao/empty',
            {
                headers: {
                    'Cookie': cookies,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer': 'https://indisponibilidade.onr.org.br/ordem/consulta/simplificada',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Cache-Control': 'no-cache, no-store',
                    'Pragma': 'no-cache',
                },
                responseType: 'arraybuffer',
                timeout: 20000,
                validateStatus: s => s < 500,
            }
        );

        const buffer = Buffer.from(pdfRes.data);
        const magic  = buffer.slice(0, 4).toString('ascii');
        const contentType = pdfRes.headers['content-type'] || '';
        console.log(`[PDF] HTTP ${pdfRes.status} | ${buffer.length} bytes | magic:"${magic}" | content-type:"${contentType}"`);

        if (magic === '%PDF') {
            res.set('Content-Type', 'application/pdf');
            res.set('Content-Length', buffer.length);
            return res.send(buffer);
        }

        // Não é PDF — tenta entender o que voltou
        const text = buffer.toString('utf8').slice(0, 800);
        console.error('[PDF] ✗ RESPOSTA NÃO É UM PDF:');
        console.error(`  → HTTP Status: ${pdfRes.status}`);
        console.error(`  → Content-Type: ${contentType}`);
        console.error(`  → Tamanho: ${buffer.length} bytes`);
        console.error(`  → Início do conteúdo: ${text.replace(/\s+/g,' ').slice(0,300)}`);

        if (pdfRes.status === 302 || (contentType.includes('text/html') && text.toLowerCase().includes('<html'))) {
            const hasLoginKeyword = text.toLowerCase().includes('login') || text.toLowerCase().includes('entrar') || text.toLowerCase().includes('senha');
            if (hasLoginKeyword) {
                console.error('  → CAUSA PROVÁVEL: Cookie expirado. ONR redirecionou para a tela de login.');
                console.error('  → SOLUÇÃO: Renove a sessão no Publisher ou cole um novo cookie.');
                return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente e refaça a pesquisa.' });
            }
            console.error('  → CAUSA PROVÁVEL: Sessão Blazor não foi populada corretamente (página não fez a consulta).');
            console.error('  → SOLUÇÃO: Refaça a pesquisa do documento e aguarde o indicador "PDF pronto" antes de baixar.');
            return res.status(500).json({ erro: 'PDF não gerado: sessão não estava preparada. Refaça a pesquisa.' });
        }

        if (text.includes('erro ao gerar') || text.includes('Verifique os parametros') || text.includes('Ocorreu um erro')) {
            console.error('  → CAUSA PROVÁVEL: ONR retornou mensagem de erro explícita no corpo da resposta.');
            return res.status(500).json({ erro: 'ONR retornou erro ao gerar o relatório. Refaça a pesquisa.' });
        }

        if (buffer.length < 500) {
            console.error('  → CAUSA PROVÁVEL: Resposta muito pequena — pode ser uma resposta vazia ou de sessão inválida.');
            return res.status(500).json({ erro: `Resposta inválida do ONR (${buffer.length} bytes). Refaça a pesquisa.` });
        }

        console.error('  → CAUSA DESCONHECIDA. Verifique o log acima para mais detalhes.');
        return res.status(500).json({ erro: `PDF não reconhecido (${buffer.length} bytes). Veja o log do servidor.` });

    } catch (err) {
        if (err.message === 'timeout') return res.status(504).json({ erro: 'Timeout aguardando PDF.' });
        return res.status(500).json({ erro: `Erro interno: ${err.message}` });
    }
});

// ═══════════════════════════════════════════════════════════
// Limpeza periódica
// ═══════════════════════════════════════════════════════════
setInterval(() => {
    let n = 0;
    for (const [k, v] of blazorSessions.entries()) {
        if (v.status !== 'running') { blazorSessions.delete(k); n++; }
    }
    if (n) console.log(`[GC] ${n} sessões removidas`);
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// LOGIN COM CERTIFICADO DIGITAL — conecta ao Chrome já aberto
// via remote debugging port 9222
// ═══════════════════════════════════════════════════════════

const { exec, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

let certSession = null;

function detectChromePath() {
    const homeDir = os.homedir();
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function detectUserDataDir() {
    // Usa um diretório temporário dedicado — evita conflito com o Chrome já aberto.
    // O Web PKI é instalado via registro do Windows e aparece em qualquer perfil.
    const debugDir = path.join('C:\\Temp', 'ChromeDebug');
    try { fs.mkdirSync(debugDir, { recursive: true }); } catch {}
    return debugDir;
}

async function connectToChrome() {
    try {
        const browser = await puppeteer.connect({
            browserURL: 'http://localhost:9222',
            defaultViewport: null,
        });
        return browser;
    } catch {
        return null;
    }
}

// Verifica se o Chrome está rodando SEM a porta de debug
// (se sim, precisamos matar e reabrir)
function isChromeRunningWithoutDebug() {
    try {
        if (process.platform === 'win32') {
            const result = execSync('netstat -ano | findstr :9222', { encoding: 'utf8', timeout: 3000 });
            return !result || result.trim() === '';
        }
        return false;
    } catch {
        return true;
    }
}

function openChromeWithDebugging() {
    const chromePath = detectChromePath();
    if (!chromePath) return false;
    const userDataDir = detectUserDataDir();
    const cmd = process.platform === 'win32'
        ? `powershell -Command "Start-Process '${chromePath}' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=${userDataDir}','--no-first-run'"`
        : `"${chromePath}" --remote-debugging-port=9222 --user-data-dir="${userDataDir}" --no-first-run &`;
    console.log('[CERT] Lançando Chrome:', cmd);
    exec(cmd, (err) => { if (err) console.warn('[CERT] exec:', err.message); });
    return true;
}

app.post('/api/cert-login/start', async (req, res) => {
    if (certSession) {
        try { await certSession.page.close(); } catch {}
        certSession = null;
    }

    console.log('\n[CERT] ── Iniciando login com certificado ──');
    console.log('[CERT] Tentando conectar ao Chrome na porta 9222...');

    let browser = await connectToChrome();

    if (!browser) {
        console.log('[CERT] Chrome não está em modo debug. Abrindo automaticamente...');
        const launched = openChromeWithDebugging();
        if (!launched) {
            return res.status(500).json({ ok: false, error: 'Chrome não encontrado no sistema.' });
        }

        // Aguarda até 15s pelo Chrome estar disponível
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            browser = await connectToChrome();
            if (browser) { console.log(`[CERT] ✓ Conectado após ${i+1}s!`); break; }
            console.log(`[CERT]   aguardando Chrome... (${i+1}/15)`);
        }

        if (!browser) {
            return res.status(500).json({
                ok: false,
                error: 'Chrome abriu mas não respondeu na porta 9222 em 15 segundos.',
            });
        }
    } else {
        console.log('[CERT] ✓ Conectado ao Chrome existente!');
    }

    // Abre aba nova no Chrome do usuário e navega para o ONR
    try {
        console.log('[CERT] Abrindo nova aba no Chrome...');
        const page = await browser.newPage();
        certSession = { browser, page, status: 'waiting', cookies: null };

        console.log('[CERT] Navegando para o login do ONR...');
        await page.goto('https://indisponibilidade.onr.org.br/login/certificate', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        console.log('[CERT] URL após navegação:', page.url());
        try { await page.bringToFront(); } catch {}
        console.log('[CERT] ✓ Aba de login aberta. Aguardando autenticação do usuário...');

    } catch (err) {
        console.error('[CERT] Erro ao abrir aba:', err.message);
        certSession = null;
        return res.status(500).json({ ok: false, error: 'Erro ao abrir aba: ' + err.message });
    }

    res.json({ ok: true });

    // Monitora cookies em background
    (async () => {
        const deadline = Date.now() + 3 * 60 * 1000;
        const { page } = certSession;
        try {
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1500));
                if (!certSession) break;

                try { await page.evaluate(() => document.readyState); }
                catch { console.log('[CERT] Aba fechada pelo usuário.'); break; }

                const currentUrl = page.url();
                const cookies = await page.cookies('https://indisponibilidade.onr.org.br').catch(() => []);
                const cnibUser = cookies.find(c => c.name === 'CNIB_USER');
                const cnibAuth = cookies.find(c => c.name === 'CNIB.Auth' || c.name === 'CNIB.AuthC1');

                if (cnibUser || (cnibAuth && currentUrl.includes('indisponibilidade.onr.org.br'))) {
                    const allCookies = await page.cookies('https://indisponibilidade.onr.org.br').catch(() => []);
                    const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
                    console.log(`[CERT] ✓ Login detectado! ${allCookies.length} cookies. URL: ${currentUrl}`);
                    certSession.status  = 'done';
                    certSession.cookies = cookieStr;
                    setTimeout(async () => { try { await page.close(); } catch {} }, 1500);
                    return;
                }
            }

            if (certSession?.status === 'waiting') {
                console.log('[CERT] Timeout — 3 minutos sem login detectado.');
                certSession.status = 'timeout';
                try { await page.close(); } catch {}
            }
        } catch (err) {
            console.error('[CERT] Erro no monitor:', err.message);
            if (certSession) certSession.status = 'error';
            try { await page.close(); } catch {}
        }
    })();
});

app.get('/api/cert-login/status', (req, res) => {
    if (!certSession) return res.json({ status: 'idle' });
    const { status, cookies } = certSession;
    if (status === 'done' && cookies) {
        const c = cookies;
        certSession = null;
        return res.json({ status: 'done', cookies: c });
    }
    return res.json({ status });
});

app.post('/api/cert-login/cancel', async (req, res) => {
    if (certSession) {
        try { await certSession.page.close(); } catch {}
        certSession = null;
    }
    res.json({ ok: true });
});

// Abre o Chrome com remote debugging (chamado pela tela de setup)
app.post('/api/cert-login/open-chrome', (req, res) => {
    const chromePath = detectChromePath();
    if (!chromePath) return res.status(404).json({ ok: false, error: 'Chrome não encontrado.' });

    const userDataDir = detectUserDataDir();

    // Start-Process é necessário no Windows para lançar o Chrome como processo independente
    // com flags — o exec normal às vezes passa para instância existente que ignora as flags
    const cmd = process.platform === 'win32'
        ? `powershell -Command "Start-Process '${chromePath}' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=${userDataDir}','--no-first-run'"`
        : `"${chromePath}" --remote-debugging-port=9222 --user-data-dir="${userDataDir}" --no-first-run &`;

    console.log('[CERT] Abrindo Chrome com debug:', cmd);
    exec(cmd, (err) => { if (err) console.warn('[CERT] exec:', err.message); });
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// Catch-all
// ═══════════════════════════════════════════════════════════
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`=========================================`);
});