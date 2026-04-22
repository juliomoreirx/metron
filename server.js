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

    console.log(`\n[BLAZOR] Iniciando para doc ${documento.replace(/\D/g,'').slice(0,3)}***`);

    (async () => {
        let page;
        try {
            const browser = await getBrowser();
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

            await page.goto(
                'https://indisponibilidade.onr.org.br/ordem/consulta/simplificada',
                { waitUntil: 'networkidle2', timeout: 45000 }
            );
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

            if (!inputHandle) throw new Error('Campo CPF/CNPJ não encontrado na página');

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
        console.log(`[PDF] ${pdfRes.status}, ${buffer.length}b, magic:"${magic}"`);

        if (magic === '%PDF') {
            res.set('Content-Type', 'application/pdf');
            res.set('Content-Length', buffer.length);
            return res.send(buffer);
        }

        const text = buffer.toString('utf8');
        if (text.includes('erro ao gerar') || text.includes('Verifique os parametros') || text.includes('Ocorreu um erro')) {
            return res.status(500).json({ erro: 'ONR retornou erro ao gerar o relatório. Refaça a pesquisa.' });
        }

        return res.status(500).json({ erro: `PDF não reconhecido (${buffer.length} bytes).` });

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