"use strict";

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const FormData   = require('form-data');
const path       = require('path');
const puppeteer  = require('puppeteer');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// FUNÇÃO ORIGINAL — não foi alterada
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
// Chave = valor do cookie CNIB_USER (identifica a sessão do usuário)
// ═══════════════════════════════════════════════════════════
const blazorSessions = new Map();

function getCookieKey(cookieString) {
    const m = cookieString.match(/CNIB_USER=([^;]+)/);
    return m ? m[1].slice(0, 32) : cookieString.slice(0, 32);
}

// Abre o Puppeteer, navega para a página de consulta do ONR com os cookies
// do usuário, pesquisa o documento — isso "suja" a sessão Blazor server-side
// para que o endpoint /relatorio/certidao/tabeliao/empty gere o PDF correto.
async function popularSessaoBlazor(documento, cookieString) {
    const key = getCookieKey(cookieString);

    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    blazorSessions.set(key, { promise, status: 'running', resolveFn, rejectFn });

    console.log(`\n[BLAZOR] Iniciando Puppeteer para doc ${documento.replace(/\D/g,'').slice(0,3)}***`);

    // Roda sem await — totalmente em background
    (async () => {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            });

            const page = await browser.newPage();

            // Bloqueia imagens e mídia para acelerar
            await page.setRequestInterception(true);
            page.on('request', req => {
                const t = req.resourceType();
                if (t === 'image' || t === 'media') req.abort();
                else req.continue();
            });

            // Injeta os cookies da sessão do usuário
            const cookieArray = cookieString.split('; ').map(c => {
                const eq    = c.indexOf('=');
                const name  = c.slice(0, eq).trim();
                const value = c.slice(eq + 1);
                return { name, value, domain: 'indisponibilidade.onr.org.br', path: '/' };
            }).filter(c => c.name && c.value);

            await page.setCookie(...cookieArray);
            console.log(`[BLAZOR] ${cookieArray.length} cookies injetados`);

            // Navega para a página de consulta simplificada (mesma que o usuário usa)
            await page.goto(
                'https://indisponibilidade.onr.org.br/ordem/consulta/simplificada',
                { waitUntil: 'networkidle2', timeout: 45000 }
            );
            console.log('[BLAZOR] Página carregada');

            // Log dos inputs para debug
            const inputsInfo = await page.evaluate(() =>
                Array.from(document.querySelectorAll('input')).map(i => ({
                    id: i.id, name: i.name, type: i.type,
                    placeholder: i.placeholder, maxLength: i.maxLength,
                    visible: i.offsetParent !== null
                }))
            );
            console.log('[BLAZOR] Inputs na página:', JSON.stringify(inputsInfo));

            // Aguarda o campo de documento aparecer (Blazor demora para renderizar)
            let inputHandle = null;
            const seletores = [
                'input[maxlength="14"]',
                'input[maxlength="18"]',
                'input[placeholder*="CPF"]',
                'input[placeholder*="CNPJ"]',
                'input[placeholder*="cpf"]',
                'input[placeholder*="documento"]',
                'input[placeholder*="Documento"]',
                'input[type="text"]:not([readonly]):not([disabled])',
            ];

            for (const sel of seletores) {
                try {
                    inputHandle = await page.waitForSelector(sel, { timeout: 6000, visible: true });
                    if (inputHandle) { console.log(`[BLAZOR] Campo encontrado: ${sel}`); break; }
                } catch { /* tenta próximo */ }
            }

            if (!inputHandle) throw new Error('Campo CPF/CNPJ não encontrado na página');

            // Preenche o documento (sem máscara)
            const docRaw = documento.replace(/\D/g, '');
            await inputHandle.click({ clickCount: 3 });
            await inputHandle.type(docRaw, { delay: 40 });
            await inputHandle.evaluate(el => el.dispatchEvent(new Event('blur', { bubbles: true })));
            await new Promise(r => setTimeout(r, 700));
            console.log(`[BLAZOR] Documento digitado`);

            // Clica no botão de pesquisar
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
                console.log(`[BLAZOR] Botão clicado: "${clicou}"`);
            }

            // Aguarda o Blazor processar — sessão server-side fica populada aqui
            await Promise.race([
                page.waitForFunction(
                    () => !document.querySelector("[class*='loading'],[class*='spinner']"),
                    { timeout: 20000 }
                ),
                new Promise(r => setTimeout(r, 12000)),
            ]).catch(() => {});

            // Pausa extra para garantir que o estado server-side foi atualizado
            await new Promise(r => setTimeout(r, 2000));

            console.log('[BLAZOR] ✓ Sessão populada com sucesso');
            blazorSessions.set(key, { promise, status: 'ready', resolveFn, rejectFn });
            resolveFn('ready');

        } catch (err) {
            console.error('[BLAZOR] ✗ Erro:', err.message);
            blazorSessions.set(key, { promise, status: 'error', resolveFn, rejectFn });
            rejectFn(err);
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    })();

    return promise;
}

// ═══════════════════════════════════════════════════════════
// ROTAS ORIGINAIS — idênticas ao server.js anterior
// ═══════════════════════════════════════════════════════════

app.post('/api/validar', async (req, res) => {
    const { cookies } = req.body;
    console.log('\n--- Nova tentativa de Validação de Cookies ---');

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
    console.log(`\n--- Nova Pesquisa Solicitada: ${documento} ---`);

    if (!cookies) {
        console.log('[ERRO] Requisição chegou sem cookies.');
        return res.status(400).json({ erro: 'Cookies não informados' });
    }

    try {
        const response = await requestONR(documento, cookies);

        if (response.status === 302 || typeof response.data === 'string') {
            console.log('[AVISO] Sessão expirou durante a pesquisa.');
            return res.status(401).json({ erro: 'Sessão expirada' });
        }

        console.log('[OK] Dados enviados ao Front-end com sucesso.');

        // Dispara Puppeteer em BACKGROUND para popular sessão Blazor
        // Não aguarda — resposta ao frontend sai imediatamente
        popularSessaoBlazor(documento, cookies).catch(err =>
            console.error('[BLAZOR-BG] Falha em background:', err.message)
        );

        res.json(response.data);

    } catch (error) {
        res.status(500).json({ erro: 'Falha ao processar a consulta no servidor.' });
    }
});

// ═══════════════════════════════════════════════════════════
// NOVA ROTA — status do PDF (frontend faz polling)
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

// ═══════════════════════════════════════════════════════════
// NOVA ROTA — baixa o PDF após sessão Blazor estar pronta
// ═══════════════════════════════════════════════════════════
app.post('/api/pdf', async (req, res) => {
    const { cookies } = req.body;
    if (!cookies) return res.status(400).json({ erro: 'Cookies não informados.' });

    const key     = getCookieKey(cookies);
    const session = blazorSessions.get(key);
    console.log(`\n[PDF] Sessão Blazor: ${session ? session.status : 'não encontrada'}`);

    try {
        if (!session) {
            return res.status(400).json({ erro: 'Pesquise um documento antes de gerar o PDF.' });
        }

        // Se ainda está rodando, aguarda o Puppeteer terminar (max 35s)
        if (session.status === 'running') {
            console.log('[PDF] Aguardando Puppeteer...');
            await Promise.race([
                session.promise,
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 35000)),
            ]);
        } else if (session.status === 'error') {
            return res.status(500).json({ erro: 'Falha ao preparar PDF. Pesquise o documento novamente.' });
        }

        // Sessão pronta — busca o PDF
        console.log('[PDF] Buscando /relatorio/certidao/tabeliao/empty ...');
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
        console.log(`[PDF] HTTP ${pdfRes.status}, ${buffer.length} bytes, magic: "${magic}"`);

        if (magic === '%PDF') {
            console.log('[PDF] ✓ PDF válido');
            res.set('Content-Type', 'application/pdf');
            res.set('Content-Length', buffer.length);
            return res.send(buffer);
        }

        // Resposta não é PDF — provavelmente HTML de erro
        const text = buffer.toString('utf8');
        console.log('[PDF] Conteúdo não-PDF:', text.slice(0, 400));

        if (text.includes('erro ao gerar') || text.includes('Verifique os parametros') || text.includes('Ocorreu um erro')) {
            return res.status(500).json({ erro: 'ONR retornou erro ao gerar o relatório. Refaça a pesquisa.' });
        }

        return res.status(500).json({ erro: `PDF não reconhecido (${buffer.length} bytes). Verifique o console.` });

    } catch (err) {
        console.error('[PDF] Exceção:', err.message);
        if (err.message === 'timeout') {
            return res.status(504).json({ erro: 'Timeout aguardando PDF. Tente pesquisar novamente.' });
        }
        return res.status(500).json({ erro: `Erro interno: ${err.message}` });
    }
});

// ═══════════════════════════════════════════════════════════
// Limpeza periódica do Map de sessões Blazor
// ═══════════════════════════════════════════════════════════
setInterval(() => {
    let n = 0;
    for (const [k, v] of blazorSessions.entries()) {
        if (v.status !== 'running') { blazorSessions.delete(k); n++; }
    }
    if (n) console.log(`[GC] ${n} sessões Blazor removidas`);
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// Catch-all original
// ═══════════════════════════════════════════════════════════
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`=========================================`);
});