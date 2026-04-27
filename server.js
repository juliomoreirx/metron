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

// ── POST /api/pdf-clone ────────────────────────────────────────
// Gera PDF Clone via Puppeteer - monta HTML correto do CNIB e gera PDF
app.post('/api/pdf-clone', async (req, res) => {
    const { cookies, documento, responsavelNome, responsavelCPF, orders, nomeAlvo, statusTexto } = req.body;
    if (!cookies) return res.status(400).json({ erro: 'Cookies não informados.' });

    const key = getCookieKey(cookies);
    const session = blazorSessions.get(key);
    console.log(`\n[PDF-CLONE] Gerando clone para doc ${documento?.slice(0,3)}***`);

    try {
        if (!session) return res.status(400).json({ erro: 'Pesquise um documento antes de gerar o PDF Clone.' });

        const browser = await getBrowser();
        const page = await browser.newPage();

        // Formatar documento
        const docRaw = documento.replace(/\D/g, '');
        let docFormatted = docRaw;
        if (docRaw.length === 11) {
            docFormatted = docRaw.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        } else if (docRaw.length === 14) {
            docFormatted = docRaw.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3.$4-$5');
        }

        // Escape HTML
        const h = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Dados padrão
        const ordersArray = orders || [];
        const isNeg = ordersArray.length === 0;
        const status = statusTexto || (isNeg ? 'NEGATIVO' : 'POSITIVO');
        const dataHora = new Date().toLocaleString('pt-BR');
        const hash = 'vzkkait5zq';
        const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://indisponibilidade.onr.org.br/home/validar';
        
        // Carrega imagens como Base64 para Puppeteer
        const assetsDir = path.join(__dirname, 'public', 'assets');
        let imgCnibBase64 = '';
        let imgOnrBase64 = '';
        
        try {
            const cnibImagePath = path.join(assetsDir, 'CNIB-EXTENSO-AZUL.png');
            const onrImagePath = path.join(assetsDir, 'logo-onr-novo.png');
            
            if (fs.existsSync(cnibImagePath)) {
                const cnibData = fs.readFileSync(cnibImagePath);
                imgCnibBase64 = 'data:image/png;base64,' + cnibData.toString('base64');
                console.log(`[PDF-CLONE] ✓ Imagem CNIB carregada (${cnibData.length} bytes)`);
            } else {
                console.warn(`[PDF-CLONE] ⚠ Arquivo CNIB não encontrado: ${cnibImagePath}`);
            }
            
            if (fs.existsSync(onrImagePath)) {
                const onrData = fs.readFileSync(onrImagePath);
                imgOnrBase64 = 'data:image/png;base64,' + onrData.toString('base64');
                console.log(`[PDF-CLONE] ✓ Imagem ONR carregada (${onrData.length} bytes)`);
            } else {
                console.warn(`[PDF-CLONE] ⚠ Arquivo ONR não encontrado: ${onrImagePath}`);
            }
        } catch (imgErr) {
            console.error(`[PDF-CLONE] Erro ao carregar imagens: ${imgErr.message}`);
        }

        // HTML dos resultados
        let htmlRes = '';
        if (isNeg) {
            htmlRes = '<div class="result-container"><div class="result-text-neg">NÃO FORAM ENCONTRADA(S) INDISPONIBILIDADE(S) GENÉRICA(S) E<br>ESPECÍFICA(S) PARA O DOCUMENTO PESQUISADO</div></div>';
        } else {
            htmlRes = '<div class="result-text-pos">Constam no cadastro da CNIB, as seguintes ocorrências:</div>';
            
            // Separa indisponibilidades para melhor paginação
            htmlRes += '<div class="items-list">';
            ordersArray.forEach((o, idx) => {
                htmlRes += '<div class="item-box">' +
                    '<div class="item-line"><span class="item-label">PROTOCOLO:</span>' + h(o.protocol || '—') + '</div>' +
                    '<div class="item-line"><span class="item-label">NÚMERO DO PROCESSO:</span>' + h(o.processNumber || '—') + '</div>' +
                    '<div class="item-line"><span class="item-label">TIPO:</span>' + h(o.processName || '—') + '</div>' +
                    '<div class="item-line"><span class="item-label">EMISSOR DA ORDEM:</span>' + h(o.organizationLabel || '—') + '</div>' +
                    '</div>';
            });
            htmlRes += '</div>';
        }

        const css = `
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: Arial, sans-serif; color: #000; font-size: 9.5pt; line-height: 1.3; background: #fff; }
            @page { margin: 15mm 20mm; size: A4; orphans: 2; widows: 2; }
            .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; border-bottom: 1px solid #000; margin-bottom: 25px; page-break-after: avoid; }
            .logo { max-width: 150px; height: auto; }
            .main-title { font-size: 16pt; font-weight: bold; margin-bottom: 25px; page-break-after: avoid; }
            .sec-header { font-size: 13pt; font-weight: bold; border-bottom: 1px solid #000; padding-bottom: 5px; margin-bottom: 15px; page-break-after: avoid; page-break-inside: avoid; }
            .dados-grid { display: flex; margin-bottom: 25px; gap: 40px; page-break-after: avoid; }
            .dados-col { flex: 1; }
            .dados-label { font-size: 8pt; font-weight: bold; text-transform: uppercase; margin-bottom: 3px; }
            .dados-val { font-size: 10pt; text-transform: uppercase; }
            .res-label { font-size: 13pt; font-weight: bold; margin-bottom: 20px; page-break-after: avoid; }
            .result-container { margin-bottom: 35px; }
            .result-text-neg { font-weight: bold; font-size: 11pt; }
            .result-text-pos { margin-bottom: 20px; font-size: 10pt; page-break-after: avoid; }
            .items-list { page-break-inside: avoid; margin-bottom: 25px; }
            .item-box { 
                margin-bottom: 20px; 
                padding: 12px; 
                border: 1px solid #d0d0d0; 
                page-break-inside: auto;
                break-inside: auto;
            }
            .item-box:nth-child(n+2) { page-break-before: auto; }
            .item-line { margin-bottom: 5px; font-size: 9.5pt; text-transform: uppercase; }
            .item-label { font-weight: bold; min-width: 160px; display: inline-block; }
            .legal-text { font-size: 9pt; text-align: justify; margin-bottom: 10px; orphans: 3; widows: 3; }
            .validation-box { border: 1px solid #a0a0a0; padding: 15px; margin-top: 30px; display: flex; align-items: center; page-break-inside: avoid; }
            .qr-wrapper { border-right: 1px solid #a0a0a0; padding-right: 20px; margin-right: 20px; }
            .qr-code { width: 80px; height: 80px; display: block; }
            .val-info { flex: 1; text-align: center; }
            .val-title { font-weight: bold; font-size: 8.5pt; margin-bottom: 10px; }
            .hash-label { font-size: 8pt; margin-bottom: 2px; }
            .hash-val { font-weight: bold; font-size: 11pt; margin-bottom: 10px; }
            .footer-table { width: 100%; border: 1px solid #a0a0a0; margin-top: 15px; border-collapse: collapse; page-break-inside: avoid; }
            .footer-table td { padding: 10px; font-size: 8pt; border-right: 1px solid #a0a0a0; border-bottom: 1px solid #a0a0a0; }
            .footer-table td:last-child { border-right: none; }
            .ft-label { font-weight: bold; display: block; margin-bottom: 5px; font-size: 7.5pt; }
            .page-footer { display: flex; justify-content: space-between; margin-top: 40px; font-size: 7.5pt; border-top: 1px solid #ccc; padding-top: 10px; page-break-inside: avoid; }
        `;

        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Relatório CNIB</title>
    <style>${css}</style>
</head>
<body>
    <div class="header">
        ${imgCnibBase64 ? `<img src="${imgCnibBase64}" class="logo" style="max-width:150px; height:auto;">` : ''}
        ${imgOnrBase64 ? `<img src="${imgOnrBase64}" class="logo" style="max-width:150px; height:auto;">` : ''}
    </div>
    <div class="main-title">Relatório de Consulta de Indisponibilidade de Bens</div>
    <div class="sec-header">Dados Pesquisados</div>
    <div class="dados-grid">
        <div class="dados-col"><div class="dados-label">CPF</div><div class="dados-val">${h(docFormatted)}</div></div>
        <div class="dados-col"><div class="dados-label">NOME</div><div class="dados-val">${h(nomeAlvo || 'DESCONHECIDO')}</div></div>
    </div>
    <div class="res-label">Resultado: ${h(status)}</div>
    ${htmlRes}
    <div class="sec-header">Informações Importantes</div>
    <div class="legal-text">Este Relatório foi emitido pela Central Nacional de Indisponibilidade de Bens (CNIB), com base nos artigos 7º e 9º do Provimento CNJ nº 39/2014, de 25/7/2014, da Corregedoria Nacional de Justiça do Conselho Nacional de Justiça (CNJ).</div>
    <div class="legal-text">A informação negativa não significa inexistência de indisponibilidades anteriormente decretadas, assim como eventuais indisponibilidades relacionadas referem-se apenas às ordens que foram cadastradas a partir das referidas datas.</div>
    <div class="validation-box">
        <div class="qr-wrapper"><img src="${qrUrl}" class="qr-code" onerror="this.style.display='none'"></div>
        <div class="val-info"><div class="val-title">Validar autenticidade</div><div class="hash-label">Hash:</div><div class="hash-val">${h(hash)}</div></div>
    </div>
    <table class="footer-table"><tr>
        <td width="30%"><span class="ft-label">Emitido em:</span>${h(dataHora)}</td>
        <td width="40%"><span class="ft-label">Responsável pela Consulta:</span>${h(responsavelNome || 'DESCONHECIDO')}</td>
        <td width="30%"><span class="ft-label">CPF do Responsável:</span>${h(responsavelCPF || '—')}</td>
    </tr></table>
    <div class="page-footer"><div>Data e Hora deste Relatório: ${h(dataHora)}<br>https://indisponibilidade.org.br</div></div>
</body>
</html>`;

        // Gera PDF via Puppeteer
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        
        // Aguarda imagens carregarem (especialmente importante para Base64)
        try {
            await page.waitForFunction(() => {
                const imgs = Array.from(document.querySelectorAll('img'));
                return imgs.length === 0 || imgs.every(img => img.complete);
            }, { timeout: 3000 }).catch(() => {
                console.warn('[PDF-CLONE] ⚠ Timeout esperando imagens, continuando...');
            });
        } catch (e) {
            console.warn('[PDF-CLONE] ⚠ Erro ao aguardar imagens:', e.message);
        }
        
        const pdfBuffer = await page.pdf({
            format: 'A4',
            margin: { top: '15mm', right: '20mm', bottom: '15mm', left: '20mm' },
            printBackground: true,
            displayHeaderFooter: false,
            scale: 1,
        });

        await page.close();
        browserUseCount++;

        res.set('Content-Type', 'application/pdf');
        res.set('Content-Length', pdfBuffer.length);
        console.log(`[PDF-CLONE] ✓ PDF Clone gerado com ${ordersArray.length} indisponibilidade(s) + 2 logos (${pdfBuffer.length} bytes)`);
        res.send(pdfBuffer);

    } catch (err) {
        console.error(`[PDF-CLONE] ✗ Erro ao gerar: ${err.message}`);
        console.error(`[PDF-CLONE] Stack: ${err.stack}`);
        try {
            await page.close();
        } catch (e) {
            // Ignora erro ao fechar página
        }
        return res.status(500).json({ 
            erro: `Falha ao gerar PDF Clone: ${err.message}`,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
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
// DOWNLOAD DO AGENTE — serve o pacote cnib-agent-setup.zip
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
// LOGIN COM CERTIFICADO DIGITAL — arquitetura agente local
//
// A VPS NÃO toca no Chrome nem no token.
// O agente local (agent.js) roda na máquina do usuário,
// abre o Chrome localmente, captura os cookies e os envia
// para a VPS via POST /api/cert-login/push-cookies.
//
// Fluxo:
//   1. Frontend clica em "Login com Certificado"
//   2. VPS cria uma sessão com ID único (pendente)
//   3. Frontend instrui o usuário a rodar o agente local
//   4. Agente abre Chrome local → usuário autentica com token
//   5. Agente captura cookies e envia para VPS com o session ID
//   6. Frontend em polling detecta os cookies → loga
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');

// Sessões pendentes: Map<sessionId, { status, cookies, created }>
const certSessions = new Map();

// Limpa sessões expiradas a cada 5 minutos
setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 min
    for (const [id, s] of certSessions) {
        if (s.created < cutoff) certSessions.delete(id);
    }
}, 5 * 60 * 1000);

// 1. Frontend solicita início de sessão → VPS cria session ID
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

// 2. Agente local envia os cookies capturados para a VPS
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

// 3. Frontend faz polling para saber se os cookies chegaram
app.get('/api/cert-login/status', (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ status: 'error', error: 'sessionId obrigatório' });

    const session = certSessions.get(sessionId);
    if (!session) return res.json({ status: 'expired' });

    // Timeout de 5 minutos
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