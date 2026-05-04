"use strict";

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const FormData  = require('form-data');
const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ═══════════════════════════════════════════════════════════
// PUPPETEER POOL
// ═══════════════════════════════════════════════════════════
let sharedBrowser = null;
let browserPending = null;
let browserUseCount = 0;
const BROWSER_RECYCLE_AFTER = 20;

async function getBrowser() {
    if (sharedBrowser) {
        try {
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
                '--single-process',
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

        browser.on('disconnected', () => {
            console.log('[POOL] Browser desconectado');
            sharedBrowser = null;
        });

        return browser;
    })();

    return browserPending;
}

// ═══════════════════════════════════════════════════════════
// FUNÇÃO ORIGINAL
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
// SESSÃO BLAZOR
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
                    console.error('  → SOLUÇÃO: Execute "npx puppeteer browsers install chrome"');
                } else if (launchErr.message.includes('EACCES') || launchErr.message.includes('permission')) {
                    console.error('  → CAUSA PROVÁVEL: Permissão negada ao executável do Chrome.');
                } else if (launchErr.message.includes('ENOMEM') || launchErr.message.includes('out of memory')) {
                    console.error('  → CAUSA PROVÁVEL: Memória insuficiente no servidor.');
                } else {
                    console.error('  → Stack:', launchErr.stack);
                }
                throw launchErr;
            }
            browserUseCount++;

            page = await browser.newPage();

            await page.setRequestInterception(true);
            page.on('request', req => {
                const t = req.resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(t)) req.abort();
                else req.continue();
            });

            await page.setViewport({ width: 1024, height: 768 });

            const cookieArray = cookieString.split('; ').map(c => {
                const eq    = c.indexOf('=');
                const name  = c.slice(0, eq).trim();
                const value = c.slice(eq + 1);
                return { name, value, domain: 'indisponibilidade.onr.org.br', path: '/' };
            }).filter(c => c.name && c.value);

            await page.setCookie(...cookieArray);

            try {
                await page.goto(
                    'https://indisponibilidade.onr.org.br/ordem/consulta/simplificada',
                    { waitUntil: 'networkidle2', timeout: 45000 }
                );
            } catch (navErr) {
                console.error('[BLAZOR] ✗ FALHA AO NAVEGAR PARA A PÁGINA:', navErr.message);
                throw navErr;
            }

            const currentUrl = page.url();
            if (!currentUrl.includes('/ordem/consulta')) {
                console.error(`[BLAZOR] ✗ REDIRECIONADO PARA URL INESPERADA: ${currentUrl}`);
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
                console.error('[BLAZOR] ✗ CAMPO CPF/CNPJ NÃO ENCONTRADO NA PÁGINA');
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

        const text = buffer.toString('utf8').slice(0, 800);
        console.error('[PDF] ✗ RESPOSTA NÃO É UM PDF:');
        console.error(`  → HTTP Status: ${pdfRes.status}`);
        console.error(`  → Content-Type: ${contentType}`);
        console.error(`  → Tamanho: ${buffer.length} bytes`);
        console.error(`  → Início do conteúdo: ${text.replace(/\s+/g,' ').slice(0,300)}`);

        if (pdfRes.status === 302 || (contentType.includes('text/html') && text.toLowerCase().includes('<html'))) {
            const hasLoginKeyword = text.toLowerCase().includes('login') || text.toLowerCase().includes('entrar') || text.toLowerCase().includes('senha');
            if (hasLoginKeyword) {
                return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente e refaça a pesquisa.' });
            }
            return res.status(500).json({ erro: 'PDF não gerado: sessão não estava preparada. Refaça a pesquisa.' });
        }

        if (text.includes('erro ao gerar') || text.includes('Verifique os parametros') || text.includes('Ocorreu um erro')) {
            return res.status(500).json({ erro: 'ONR retornou erro ao gerar o relatório. Refaça a pesquisa.' });
        }

        if (buffer.length < 500) {
            return res.status(500).json({ erro: `Resposta inválida do ONR (${buffer.length} bytes). Refaça a pesquisa.` });
        }

        return res.status(500).json({ erro: `PDF não reconhecido (${buffer.length} bytes). Veja o log do servidor.` });

    } catch (err) {
        if (err.message === 'timeout') return res.status(504).json({ erro: 'Timeout aguardando PDF.' });
        return res.status(500).json({ erro: `Erro interno: ${err.message}` });
    }
});

// ═══════════════════════════════════════════════════════════
// FIX #3: PDF CLONE — layout corrigido para indisponibilidades
// Cada indisponibilidade em bloco próprio, campos empilhados,
// sem corte entre páginas, emissor completo sem truncar.
// ═══════════════════════════════════════════════════════════
app.post('/api/pdf-clone', async (req, res) => {
    const { cookies, documento, responsavelNome, responsavelCPF, orders, nomeAlvo, statusTexto } = req.body;
    if (!cookies) return res.status(400).json({ erro: 'Cookies não informados.' });

    const key = getCookieKey(cookies);
    const session = blazorSessions.get(key);
    console.log(`\n[PDF-CLONE] Gerando clone para doc ${documento?.slice(0,3)}***`);
    let page = null;

    try {
        if (!session) return res.status(400).json({ erro: 'Pesquise um documento antes de gerar o PDF Clone.' });

        const browser = await getBrowser();
        page = await browser.newPage();

        // ── Formatar documento ────────────────────────────
        const docRaw = (documento || '').replace(/\D/g, '');
        let docFormatted = docRaw;
        if (docRaw.length === 11) {
            docFormatted = docRaw.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        } else if (docRaw.length === 14) {
            // CNPJ sem barra para o PDF (igual ao PDF oficial)
            docFormatted = docRaw.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3.$4-$5');
        }

        // ── Escape HTML ───────────────────────────────────
        const h = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // ── Dados ─────────────────────────────────────────
        const ordersArray  = Array.isArray(orders) ? orders : [];
        const isNeg        = ordersArray.length === 0;
        const status       = statusTexto || (isNeg ? 'NEGATIVO' : 'POSITIVO');
        const dataHora     = new Date().toLocaleString('pt-BR');
        const hash         = 'vzkkait5zq';
        const qrUrl        = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://indisponibilidade.onr.org.br/home/validar';

        // ── Carrega logos como Base64 ─────────────────────
        const assetsDir = path.join(__dirname, 'public', 'assets');
        let imgCnibBase64 = '';
        let imgOnrBase64  = '';

        try {
            const cnibPath = path.join(assetsDir, 'CNIB-EXTENSO-AZUL.png');
            const onrPath  = path.join(assetsDir, 'logo-onr-novo.png');
            if (fs.existsSync(cnibPath)) {
                imgCnibBase64 = 'data:image/png;base64,' + fs.readFileSync(cnibPath).toString('base64');
                console.log('[PDF-CLONE] ✓ Logo CNIB carregada');
            }
            if (fs.existsSync(onrPath)) {
                imgOnrBase64 = 'data:image/png;base64,' + fs.readFileSync(onrPath).toString('base64');
                console.log('[PDF-CLONE] ✓ Logo ONR carregada');
            }
        } catch (imgErr) {
            console.warn('[PDF-CLONE] ⚠ Erro ao carregar logos:', imgErr.message);
        }

        // ── Ícone de resultado negativo (X em documento) ──
        const iconNegative = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"
            fill="currentColor" viewBox="0 0 16 16">
            <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14
            4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0
            1-1V4.5h-2z"/>
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708
            L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0
            1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
        </svg>`;

        // ── Bloco de resultado ────────────────────────────
        let htmlRes = '';

        if (isNeg) {
            // Resultado NEGATIVO — igual ao original
            htmlRes = `
            <div class="result-container">
                <div class="result-icon">${iconNegative}</div>
                <div class="result-text-neg">
                    NÃO FORAM ENCONTRADA(S) INDISPONIBILIDADE(S) GENÉRICA(S) E<br>
                    ESPECÍFICA(S) PARA O DOCUMENTO PESQUISADO
                </div>
            </div>`;
        } else {
            // ── FIX #3: Resultado POSITIVO ─────────────────
            // Cada indisponibilidade = 1 bloco com os 4 campos empilhados,
            // largura total, sem grid, sem corte entre páginas.
            htmlRes = `<p class="result-intro">Constam no cadastro da CNIB, as seguintes ocorrências:</p>`;

            ordersArray.forEach((o, idx) => {
                // Protocolo: exibe exatamente como vem da API (ex: 201410.0916.00040349-IA-650)
                const protocolo    = h(o.protocol       || '—');
                const numProcesso  = h(o.processNumber  || '—');
                const tipo         = h(o.processName    || '—');
                // Emissor pode ser longo (vários níveis separados por /)
                // Quebramos em múltiplas linhas para facilitar leitura
                const emissores    = (o.organizationLabel || '—').split('/').map(s => s.trim()).filter(Boolean);
                const emissorHtml  = emissores.map(s => h(s)).join('<br>');

                htmlRes += `
                <div class="order-block">
                    <div class="order-number">Indisponibilidade ${idx + 1}</div>
                    <table class="order-table">
                        <tr>
                            <td class="field-label">PROTOCOLO:</td>
                            <td class="field-value">${protocolo}</td>
                        </tr>
                        <tr>
                            <td class="field-label">NÚMERO DO PROCESSO:</td>
                            <td class="field-value">${numProcesso}</td>
                        </tr>
                        <tr>
                            <td class="field-label">TIPO:</td>
                            <td class="field-value">${tipo}</td>
                        </tr>
                        <tr>
                            <td class="field-label">EMISSOR DA ORDEM:</td>
                            <td class="field-value emissor">${emissorHtml}</td>
                        </tr>
                    </table>
                </div>`;
            });
        }

        // ── CSS completo ──────────────────────────────────
        const css = `
            * { box-sizing: border-box; margin: 0; padding: 0; }

            body {
                font-family: Arial, sans-serif;
                color: #000;
                font-size: 9.5pt;
                line-height: 1.4;
                background: #fff;
            }

            @page { margin: 15mm 20mm 20mm 20mm; size: A4; }

            /* CABEÇALHO */
            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding-bottom: 14px;
                border-bottom: 2px solid #000;
                margin-bottom: 22px;
            }
            .logo-cnib { width: 160px; }
            .logo-onr  { width: 140px; }

            /* TÍTULO */
            .main-title {
                font-size: 15pt;
                font-weight: bold;
                margin-bottom: 22px;
            }

            /* SEÇÃO */
            .sec-header {
                font-size: 12pt;
                font-weight: bold;
                border-bottom: 1px solid #000;
                padding-bottom: 4px;
                margin-bottom: 12px;
                page-break-after: avoid;
            }

            /* DADOS PESQUISADOS */
            .dados-grid {
                display: flex;
                gap: 40px;
                margin-bottom: 22px;
            }
            .dados-col { flex: 1; }
            .dados-label {
                font-size: 8pt;
                font-weight: bold;
                text-transform: uppercase;
                margin-bottom: 2px;
                color: #444;
            }
            .dados-val {
                font-size: 10.5pt;
                text-transform: uppercase;
                font-weight: bold;
            }

            /* RESULTADO LABEL */
            .res-label {
                font-size: 12pt;
                font-weight: bold;
                margin-bottom: 18px;
            }

            /* NEGATIVO */
            .result-container {
                display: flex;
                align-items: center;
                margin-bottom: 30px;
                padding: 14px;
                border: 1px solid #ccc;
                border-radius: 4px;
            }
            .result-icon { margin-right: 14px; flex-shrink: 0; }
            .result-text-neg { font-weight: bold; font-size: 10.5pt; line-height: 1.5; }

            /* POSITIVO — intro */
            .result-intro {
                font-size: 10pt;
                margin-bottom: 14px;
            }

            /* POSITIVO — cada bloco de indisponibilidade */
            .order-block {
                border: 1px solid #bbb;
                border-radius: 4px;
                margin-bottom: 12px;
                page-break-inside: avoid;
                break-inside: avoid;
                overflow: hidden;
            }
            .order-number {
                background: #f0f0f0;
                font-size: 8.5pt;
                font-weight: bold;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                padding: 5px 10px;
                border-bottom: 1px solid #bbb;
                color: #333;
            }
            .order-table {
                width: 100%;
                border-collapse: collapse;
            }
            .order-table tr { border-bottom: 1px solid #e8e8e8; }
            .order-table tr:last-child { border-bottom: none; }
            .field-label {
                font-size: 8pt;
                font-weight: bold;
                text-transform: uppercase;
                color: #444;
                white-space: nowrap;
                vertical-align: top;
                padding: 6px 8px 6px 10px;
                width: 1%;
            }
            .field-value {
                font-size: 9.5pt;
                text-transform: uppercase;
                vertical-align: top;
                padding: 6px 10px 6px 4px;
                word-break: break-word;
                line-height: 1.5;
            }
            /* Emissor tem quebra de linha entre os níveis */
            .field-value.emissor {
                text-transform: none;
                font-size: 9pt;
                line-height: 1.6;
            }

            /* INFORMAÇÕES LEGAIS */
            .legal-text {
                font-size: 8.5pt;
                text-align: justify;
                margin-bottom: 8px;
                line-height: 1.5;
            }

            /* VALIDAÇÃO */
            .validation-box {
                border: 1px solid #a0a0a0;
                border-radius: 5px;
                padding: 14px;
                margin-top: 24px;
                display: flex;
                align-items: center;
                page-break-inside: avoid;
                break-inside: avoid;
            }
            .qr-wrapper {
                border-right: 1px solid #a0a0a0;
                padding-right: 18px;
                margin-right: 18px;
                flex-shrink: 0;
            }
            .qr-code { width: 75px; height: 75px; display: block; }
            .val-info { flex: 1; text-align: center; }
            .val-title { font-weight: bold; font-size: 8pt; margin-bottom: 8px; }
            .hash-label { font-size: 7.5pt; margin-bottom: 2px; color: #555; }
            .hash-val { font-weight: bold; font-size: 10.5pt; margin-bottom: 8px; }
            .url-val { font-size: 7pt; color: #000; text-decoration: none; }

            /* RODAPÉ DA TABELA */
            .footer-table {
                width: 100%;
                border: 1px solid #a0a0a0;
                border-radius: 4px;
                margin-top: 12px;
                border-collapse: separate;
                border-spacing: 0;
                page-break-inside: avoid;
                break-inside: avoid;
            }
            .footer-table td {
                padding: 9px 10px;
                font-size: 8pt;
                vertical-align: top;
                border-right: 1px solid #a0a0a0;
            }
            .footer-table td:last-child { border-right: none; }
            .ft-label {
                font-weight: bold;
                display: block;
                margin-bottom: 4px;
                font-size: 7.5pt;
                color: #444;
            }

            /* RODAPÉ DE PÁGINA */
            .page-footer {
                display: flex;
                justify-content: space-between;
                margin-top: 30px;
                font-size: 7.5pt;
                border-top: 1px solid #ccc;
                padding-top: 8px;
                page-break-inside: avoid;
                break-inside: avoid;
            }
            .footer-right { text-align: right; }
        `;

        // ── HTML completo ─────────────────────────────────
        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Relatório CNIB</title>
    <style>${css}</style>
</head>
<body>

    <!-- Cabeçalho com logos -->
    <div class="header">
        ${imgCnibBase64 ? `<img src="${imgCnibBase64}" class="logo-cnib" alt="CNIB">` : '<div style="width:160px;"></div>'}
        ${imgOnrBase64  ? `<img src="${imgOnrBase64}"  class="logo-onr"  alt="ONR">` : '<div style="width:140px;"></div>'}
    </div>

    <div class="main-title">Relatório de Consulta de Indisponibilidade de Bens</div>

    <!-- Dados pesquisados -->
    <div class="sec-header">Dados Pesquisados</div>
    <div class="dados-grid">
        <div class="dados-col">
            <div class="dados-label">CPF / CNPJ</div>
            <div class="dados-val">${h(docFormatted)}</div>
        </div>
        <div class="dados-col">
            <div class="dados-label">Nome / Razão Social</div>
            <div class="dados-val">${h(nomeAlvo || 'DESCONHECIDO')}</div>
        </div>
    </div>

    <!-- Resultado -->
    <div class="res-label">Resultado: ${h(status)}</div>
    ${htmlRes}

    <!-- Informações importantes -->
    <div class="sec-header">Informações Importantes</div>
    <p class="legal-text">
        Este Relatório foi emitido pela Central Nacional de Indisponibilidade de Bens (CNIB), com base nos artigos 7º e 9º
        do Provimento CNJ nº 39/2014, de 25/7/2014, da Corregedoria Nacional de Justiça do Conselho Nacional de Justiça (CNJ).
    </p>
    <p class="legal-text">
        A informação negativa não significa inexistência de indisponibilidades anteriormente decretadas, assim como eventuais
        indisponibilidades relacionadas referem-se apenas às ordens que foram cadastradas a partir das referidas datas.
        Em caso positivo são indicados os números dos processos de execuções trabalhistas, fiscais e cíveis, bem como os
        respectivos Tribunais em que tramitam, ressalvadas informações de processos que correm em segredo de justiça e em
        sigilo de justiça. Nessas hipóteses é mantida a informação do resultado positivo, devendo o interessado reportar-se
        diretamente aos Juízos ou instâncias administrativas competentes que decretaram a indisponibilidade de bens.
    </p>
    <p class="legal-text">
        Os dados constantes deste relatório são de responsabilidade direta dos respectivos órgãos do Poder Judiciário e
        da Administração Pública que os cadastraram.
    </p>
    <p class="legal-text">
        Para informações mais completas sobre a situação jurídica da pessoa pesquisada deverão ser feitas pesquisas de
        maior abrangência nos órgãos do Poder Judiciário e da Administração Pública.
    </p>

    <!-- QR + Hash -->
    <div class="validation-box">
        <div class="qr-wrapper">
            <img src="${qrUrl}" class="qr-code" alt="QR Code">
        </div>
        <div class="val-info">
            <div class="val-title">Validar autenticidade</div>
            <div class="hash-label">Hash:</div>
            <div class="hash-val">${h(hash)}</div>
            <a href="https://indisponibilidade.org.br" class="url-val">https://indisponibilidade.org.br</a>
        </div>
    </div>

    <!-- Responsável -->
    <table class="footer-table">
        <tr>
            <td width="30%"><span class="ft-label">Emitido em:</span>${h(dataHora)}</td>
            <td width="40%"><span class="ft-label">Responsável pela Consulta:</span>${h(responsavelNome || 'DESCONHECIDO')}</td>
            <td width="30%"><span class="ft-label">CPF do Responsável:</span>${h(responsavelCPF || '—')}</td>
        </tr>
    </table>

    <!-- Rodapé -->
    <div class="page-footer">
        <div>Data e Hora deste Relatório: ${h(dataHora)}<br>https://indisponibilidade.org.br</div>
        <div class="footer-right"><strong>Relatório de Consulta de Indisponibilidade de Bens</strong></div>
    </div>

</body>
</html>`;

        // ── Gera PDF via Puppeteer ────────────────────────
        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        // Aguarda imagens (logos Base64 + QR Code externo)
        await page.waitForFunction(() => {
            const imgs = Array.from(document.querySelectorAll('img'));
            return imgs.every(img => img.complete);
        }, { timeout: 5000 }).catch(() => {
            console.warn('[PDF-CLONE] ⚠ Timeout aguardando imagens');
        });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            margin: { top: '15mm', right: '20mm', bottom: '20mm', left: '20mm' },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `<div style="width:100%;font-size:7px;color:#888;
                padding:0 20mm 5mm 20mm;">
                <div style="border-top:1px solid #ddd;padding-top:3px;text-align:right;">
                    Página <span class="pageNumber"></span> de <span class="totalPages"></span>
                </div>
            </div>`,
            scale: 1,
        });

        await page.close();
        browserUseCount++;

        const qtd = ordersArray.length;
        console.log(`[PDF-CLONE] ✓ PDF gerado — ${qtd} indisponibilidade(s) — ${pdfBuffer.length} bytes`);

        res.set('Content-Type', 'application/pdf');
        res.set('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);

    } catch (err) {
        console.error(`[PDF-CLONE] ✗ Erro: ${err.message}`);
        console.error(`[PDF-CLONE] Stack: ${err.stack}`);
        if (page) { try { await page.close(); } catch {} }
        return res.status(500).json({
            erro: `Falha ao gerar PDF Clone: ${err.message}`,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

// ═══════════════════════════════════════════════════════════
// Limpeza periódica de sessões
// ═══════════════════════════════════════════════════════════
setInterval(() => {
    let n = 0;
    for (const [k, v] of blazorSessions.entries()) {
        if (v.status !== 'running') { blazorSessions.delete(k); n++; }
    }
    if (n) console.log(`[GC] ${n} sessões removidas`);
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// DOWNLOAD DO AGENTE
// ═══════════════════════════════════════════════════════════
app.get('/cnib-agent-setup.zip', (req, res) => {
    const zipPath = path.join(__dirname, 'cnib-agent-setup.zip');
    if (fs.existsSync(zipPath)) {
        res.download(zipPath, 'cnib-agent-setup.zip');
    } else {
        res.status(404).json({
            error: 'Pacote do agente não encontrado no servidor.',
            info: 'Execute: npm run build-agent na VPS para gerar o pacote.'
        });
    }
});

// ═══════════════════════════════════════════════════════════
// LOGIN COM CERTIFICADO DIGITAL
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

const certSessions = new Map();

setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, s] of certSessions) {
        if (s.created < cutoff) certSessions.delete(id);
    }
}, 5 * 60 * 1000);

app.post('/api/cert-login/start', (req, res) => {
    const sessionId = crypto.randomBytes(16).toString('hex');
    certSessions.set(sessionId, {
        status: 'waiting',
        cookies: null,
        created: Date.now(),
    });
    console.log(`\n[CERT] Nova sessão criada: ${sessionId}`);
    res.json({ ok: true, sessionId });
});

app.post('/api/cert-login/push-cookies', (req, res) => {
    const { sessionId, cookies } = req.body;

    if (!sessionId || !cookies) {
        return res.status(400).json({ ok: false, error: 'sessionId e cookies são obrigatórios.' });
    }

    const session = certSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ ok: false, error: 'Sessão não encontrada ou expirada.' });
    }

    session.status  = 'done';
    session.cookies = cookies;
    console.log(`[CERT] ✓ Cookies recebidos do agente para sessão ${sessionId}`);
    res.json({ ok: true });
});

app.get('/api/cert-login/status', (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ status: 'error', error: 'sessionId obrigatório' });

    const session = certSessions.get(sessionId);
    if (!session) return res.json({ status: 'expired' });

    if (Date.now() - session.created > 5 * 60 * 1000 && session.status === 'waiting') {
        certSessions.delete(sessionId);
        return res.json({ status: 'timeout' });
    }

    if (session.status === 'done') {
        const cookies = session.cookies;
        certSessions.delete(sessionId);
        return res.json({ status: 'done', cookies });
    }

    res.json({ status: 'waiting' });
});

app.post('/api/cert-login/cancel', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) certSessions.delete(sessionId);
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