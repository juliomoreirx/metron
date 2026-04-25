// ==UserScript==
// @name         CNIB - Bulk Ultimate (Oficial/Local + Trava) - MINIMAL DARK
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  Lote síncrono, FAB flutuante, Auto-close e Barra Minimalista. CNPJ Corrigido.
// @author       Julio Moreira (Via Gemini)
// @match        https://*.onr.org.br/*
// @match        https://*.indisponibilidade.org.br/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- INJEÇÃO DO TAILWIND CSS ---
    if (!document.getElementById('tailwindcss-cdn')) {
        const tailwind = document.createElement('script');
        tailwind.id = 'tailwindcss-cdn';
        tailwind.src = 'https://cdn.tailwindcss.com';
        document.head.appendChild(tailwind);
    }

    // --- CONFIGURAÇÕES ---
    const NOME_COPIA_FINAL = "Feito por Julio Moreira";
    const TEMPO_POLLING = 500;

    // --- VARIÁVEIS GLOBAIS ---
    let filaProcessamento = [];
    let listaInvalidos = [];
    let emProcessamento = false;
    let totalProcessados = 0;
    let janelaPdfAtual = null;

    // --- IDENTIFICAÇÃO ---
    function getUsuarioLogado() {
        const el = document.querySelector('.title-user-name-v5');
        if (el) return el.innerText.replace('Dr(a) ', '').trim();
        return 'USUÁRIO DO SISTEMA';
    }

    function getCPFUsuario() {
        if (window.DD_RUM && window.DD_RUM.getUser) {
            const u = window.DD_RUM.getUser();
            if (u && u.documentNumber) return u.documentNumber.substring(0, 3) + '.***.***-**';
        }
        return '***.***.***-**';
    }

    function clicarBotaoPesquisar() {
        const botao = document.getElementById('btnSearch');
        if (botao && !emProcessamento) console.log("[CNIB Script] Ping sessão.");
    }

    // --- UTILITÁRIOS DE MÁSCARA ---
    function aplicarMascaraDocumento(doc) {
        const num = doc.replace(/\D/g, '');
        if (num.length === 11) {
            return num.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
        } else if (num.length === 14) {
            return num.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
        }
        return doc;
    }

    function processarTextoTextarea(texto) {
        if (!texto) return "";
        const linhas = texto.split('\n').filter(l => l.trim().length > 0);

        return linhas.map(linha => {
            let pedido = "";
            let documento = linha;
            const separadores = /[;,\t]/;

            if (separadores.test(linha)) {
                const partes = linha.split(separadores);
                pedido = partes[0].trim();
                documento = partes[1].trim();
            }

            const docFormatado = aplicarMascaraDocumento(documento);
            return pedido ? `${pedido} ; ${docFormatado}` : docFormatado;
        }).join('\n');
    }

    // =================================================================================
    // MÓDULO DE LOTE (FAB & PAINEL FLUTUANTE)
    // =================================================================================

    function inicializarUI() {
        // 1. Criar o Botão Flutuante (FAB) no canto inferior esquerdo
        if (!document.getElementById('btnOpenBulkFAB')) {
            const fab = document.createElement('button');
            fab.id = 'btnOpenBulkFAB';
            fab.className = 'fixed bottom-6 left-6 w-14 h-14 bg-indigo-600/90 text-white rounded-full flex items-center justify-center shadow-[0_4px_20px_rgba(79,70,229,0.5)] hover:bg-indigo-500 hover:scale-105 transition-all z-[9999] border border-indigo-400/30 focus:outline-none backdrop-blur-sm';
            fab.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path></svg>';
            fab.onclick = togglePainelLote;
            document.body.appendChild(fab);
        }

        // 2. Criar o Painel de Lote (oculto por padrão)
        if (!document.getElementById('painelLoteJulio')) {
            const painel = document.createElement('div');
            painel.id = 'painelLoteJulio';
            // Agora ancorado à esquerda, logo acima do FAB
            painel.className = 'hidden fixed bottom-24 left-6 w-[380px] bg-slate-900/95 backdrop-blur-xl rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.6)] border border-slate-700/80 z-[9999] p-6 font-sans transition-all text-sm text-slate-200';

            painel.innerHTML = `
                <div class="flex justify-between items-center mb-5 border-b border-slate-700 pb-3">
                    <h5 class="text-indigo-400 font-bold text-base flex items-center gap-2 tracking-wide">
                        Lote Contínuo
                    </h5>
                </div>

                <div class="flex items-center justify-between mb-5 bg-slate-800/50 p-3 rounded-xl border border-slate-700/50">
                    <div class="flex flex-col pr-4">
                        <span class="font-semibold text-slate-200 text-sm">PDF Oficial do Sistema</span>
                        <span class="text-[10px] text-slate-400 mt-0.5">Usa impressão nativa (lento)</span>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer shrink-0">
                        <input type="checkbox" id="chkBulkOfficial" class="sr-only peer">
                        <div class="w-10 h-5 bg-slate-700 rounded-full peer peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-300 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500/80 peer-checked:after:bg-white shadow-inner"></div>
                    </label>
                </div>

                <div class="space-y-4 mb-6">
                    <div>
                        <input type="text" id="txtBulkPedido" class="w-full px-3 py-2 bg-slate-950/50 border-b border-slate-700 focus:border-indigo-500 rounded-t-md focus:outline-none transition-colors placeholder-slate-600 text-slate-200 text-sm" placeholder="Nº Pedido Geral (Opcional)">
                    </div>
                    <div>
                        <textarea id="txtBulkInput" class="w-full px-3 py-2 bg-slate-950/50 border border-slate-700 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors font-mono text-xs placeholder-slate-600 resize-none text-slate-200 leading-relaxed scrollbar-thin" rows="6" placeholder="Cole os documentos aqui...&#10;123.456.789-00&#10;PEDIDO; 12.345.678/0001-90"></textarea>
                    </div>
                </div>

                <div class="flex gap-3 mb-4">
                    <button id="btnIniciarBulk" class="flex-1 bg-indigo-600/90 hover:bg-indigo-500 text-white font-bold py-2 px-4 rounded-lg shadow-lg shadow-indigo-900/30 transition-all focus:outline-none flex items-center justify-center gap-2 active:scale-95 text-sm border border-indigo-500/50">
                        Iniciar Lote
                    </button>
                    <button id="btnPararBulk" class="flex-1 bg-rose-600/90 hover:bg-rose-500 text-white font-bold py-2 px-4 rounded-lg shadow-lg shadow-rose-900/30 transition-all focus:outline-none flex items-center justify-center gap-2 active:scale-95 text-sm border border-rose-500/50">
                        Parar
                    </button>
                </div>

                <div class="bg-slate-800/80 rounded-lg p-3 border border-slate-700/50 relative overflow-hidden">
                    <div id="statusBulk" class="text-xs font-semibold text-slate-300 flex items-center gap-2 relative z-10">
                        <span class="w-2 h-2 rounded-full bg-slate-500"></span>
                        Pronto para iniciar.
                    </div>
                </div>
            `;

            document.body.appendChild(painel);

            document.getElementById('btnIniciarBulk').onclick = iniciarLote;
            document.getElementById('btnPararBulk').onclick = () => {
                emProcessamento = false;
                atualizarStatus("⛔ Interrompido.", 'text-rose-400', 'bg-rose-500');
            };

            document.getElementById('txtBulkInput').addEventListener('blur', function() {
                this.value = processarTextoTextarea(this.value);
            });
        }

        // 3. Event Listener Global: Fecha o painel se clicar fora dele E fora do botão FAB
        if (!window.hasBulkClickListener) {
            document.addEventListener('click', (e) => {
                const painel = document.getElementById('painelLoteJulio');
                const fab = document.getElementById('btnOpenBulkFAB');
                if (painel && !painel.classList.contains('hidden')) {
                    if (!painel.contains(e.target) && fab && !fab.contains(e.target)) {
                        painel.classList.add('hidden');
                    }
                }
            });
            window.hasBulkClickListener = true;
        }
    }

    function togglePainelLote() {
        const painel = document.getElementById('painelLoteJulio');
        if (painel) painel.classList.toggle('hidden');
    }

    function atualizarStatus(msg, textClass = 'text-indigo-300', dotClass = 'bg-indigo-400') {
        const el = document.getElementById('statusBulk');
        if (el) {
            el.className = `text-xs font-bold flex items-center gap-2 relative z-10 ${textClass}`;
            el.innerHTML = `<span class="w-2 h-2 rounded-full shadow-[0_0_8px_currentColor] ${dotClass} ${emProcessamento ? 'animate-pulse' : ''}"></span> ${msg}`;
        }
    }

    function iniciarLote() {
        const txtInput = document.getElementById('txtBulkInput');
        txtInput.value = processarTextoTextarea(txtInput.value);

        const txt = txtInput.value;
        const pedidoGeral = document.getElementById('txtBulkPedido').value.trim();

        if (!txt.trim()) { alert("⚠️ Cole os documentos na fila antes de iniciar."); return; }

        filaProcessamento = txt.split('\n').filter(l => l.trim().length > 0).map(linha => {
            let pedidoAtribuido = pedidoGeral || "LOTE";
            let docTratado = linha;

            if (linha.includes(';')) {
                const partes = linha.split(';');
                pedidoAtribuido = partes[0].trim();
                docTratado = partes[1].trim();
            }

            return {
                pedido: pedidoAtribuido,
                docOriginal: docTratado,
                docRaw: docTratado.replace(/\D/g, '')
            };
        });

        listaInvalidos = [];
        totalProcessados = 0;
        emProcessamento = true;

        atualizarStatus(`Iniciando fila: ${filaProcessamento.length} itens.`);
        processarProximoDaFila();
    }

    // =================================================================================
    // PROCESSAMENTO E CORREÇÃO DO CNPJ (A MÁGICA CONTINUA AQUI)
    // =================================================================================
    function processarProximoDaFila() {
        if (!emProcessamento) return;
        if (filaProcessamento.length === 0) {
            emProcessamento = false;
            let msg = `🎉 FIM DA FILA!\nTotal Processados: ${totalProcessados}`;
            if (listaInvalidos.length > 0) msg += `\n⚠️ Inválidos: ${listaInvalidos.length}\n` + listaInvalidos.join('\n');

            document.getElementById('txtBulkInput').value = '';
            document.getElementById('txtBulkPedido').value = '';

            alert(msg);
            atualizarStatus("Processo Concluído.", 'text-emerald-400', 'bg-emerald-400');
            return;
        }

        const itemAtual = filaProcessamento.shift();
        atualizarStatus(`🔍 Pesquisando: ${itemAtual.docOriginal} (Restam: ${filaProcessamento.length})`);

        const inputDoc = document.getElementById('txtDocumentNumber');
        const btnLimpar = document.getElementById('btnClear');
        const btnPesquisar = document.getElementById('btnSearch');

        if (btnLimpar) btnLimpar.click();

        setTimeout(() => {
            // Força bruta para injetar os 14 digitos do CNPJ sem a máscara do site cortar
            inputDoc.focus();
            inputDoc.value = itemAtual.docRaw;
            inputDoc.dispatchEvent(new Event('input', { bubbles: true }));

            setTimeout(() => {
                inputDoc.select();
                const inseriu = document.execCommand('insertText', false, itemAtual.docRaw);

                if (!inseriu) inputDoc.value = itemAtual.docRaw;

                inputDoc.dispatchEvent(new Event('input', { bubbles: true }));
                inputDoc.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                inputDoc.blur();
                btnPesquisar.click();

                monitorarResultado(itemAtual);
            }, 100);
        }, 600);
    }

    function monitorarResultado(itemAtual) {
        let tentativas = 0;
        const maxTentativas = 60;

        const checkInterval = setInterval(() => {
            tentativas++;
            if (!emProcessamento) { clearInterval(checkInterval); return; }

            const modalErro = document.getElementById('mdlMessageError');
            const styleModal = modalErro ? window.getComputedStyle(modalErro).display : 'none';
            const spanErro = document.querySelector('span[from-fieldset="txtDocumentNumber"]');

            if (styleModal !== 'none' || (spanErro && spanErro.style.display !== 'none')) {
                clearInterval(checkInterval);
                listaInvalidos.push(`[${itemAtual.pedido}] ${itemAtual.docOriginal}`);
                const btnFecharErro = document.getElementById('btnCancelApproved');
                if (btnFecharErro) btnFecharErro.click();
                atualizarStatus(`❌ Inválido: ${itemAtual.docOriginal}.`, 'text-rose-400', 'bg-rose-500');
                setTimeout(processarProximoDaFila, 1000);
                return;
            }

            const loading = document.getElementById('divProgress');
            if (loading && loading.style.display !== 'none') return;

            const divPositivo = document.getElementById('divPositiveResult');
            const divNegativo = document.getElementById('divNegativeResult');
            const content = document.getElementById('divContent');

            if (content.style.display !== 'none' && (
                (divPositivo && divPositivo.style.display !== 'none') ||
                (divNegativo && divNegativo.style.display !== 'none')
            )) {
                clearInterval(checkInterval);
                totalProcessados++;
                lidarComSucessoBulk(itemAtual, (divNegativo && divNegativo.style.display !== 'none'));
                return;
            }

            if (tentativas >= maxTentativas) {
                clearInterval(checkInterval);
                listaInvalidos.push(`[${itemAtual.pedido}] ${itemAtual.docOriginal} (Timeout)`);
                atualizarStatus("⏰ Timeout.", 'text-amber-400', 'bg-amber-400');
                setTimeout(processarProximoDaFila, 1000);
            }
        }, 500);
    }

    function lidarComSucessoBulk(itemAtual, isNegativo) {
        const labelNome = document.getElementById('lblName').textContent.replace("Nome/Razão Social:", "").trim();
        const labelCpf = document.getElementById('lblDocumentNumber').textContent.replace("CPF/CNPJ:", "").trim();
        const docSemBarra = labelCpf.replace(/\//g, "");

        const statusTexto = isNegativo ? "CNIB NEGATIVO" : "CNIB POSITIVO";
        const textoCopia = `${itemAtual.pedido} - ${statusTexto} - ${labelNome} - ${docSemBarra} - ${NOME_COPIA_FINAL}`;

        navigator.clipboard.writeText(textoCopia).catch(e => console.error("Erro copy", e));

        const usarOficial = document.getElementById('chkBulkOfficial').checked;
        atualizarStatus(usarOficial ? `🖨️ Oficial... Feche aba após.` : `⚡ Gerando... Feche aba após.`);

        if (usarOficial) {
            janelaPdfAtual = abrirPdfServidorBulk();
        } else {
            janelaPdfAtual = gerarPdfClone(labelNome, itemAtual.docOriginal, (isNegativo ? 'NEGATIVO' : 'POSITIVO'), isNegativo);
        }

        monitorarFechamentoAba();
    }

    function monitorarFechamentoAba() {
        if (!janelaPdfAtual) { processarProximoDaFila(); return; }

        const monitor = setInterval(() => {
            if (!emProcessamento) { clearInterval(monitor); return; }
            if (janelaPdfAtual.closed) {
                clearInterval(monitor);
                atualizarStatus("Carregando próximo...", 'text-emerald-400', 'bg-emerald-400');
                setTimeout(processarProximoDaFila, 800);
            }
        }, 500);
    }

    // =================================================================================
    // CONTROLES MANUAIS MINIMALISTAS (PREMIUM) E SEM BUG NO SWITCH
    // =================================================================================

    function executarAcaoManual(modo, btnElemento) {
        const labelNome = document.getElementById('lblName');
        const inputPedido = document.getElementById('inputNumeroPedido');
        const manterPedido = document.getElementById('chkManterPedido').checked;
        const labelCpf = document.getElementById('lblDocumentNumber');

        if (!labelNome || !inputPedido || !labelCpf) { alert("⚠️ Pesquise um documento."); return; }

        const nomeLimpo = labelNome.textContent.replace("Nome/Razão Social:", "").trim();
        const numeroPedido = inputPedido.value.trim();
        const rawDoc = labelCpf.textContent.replace("CPF/CNPJ:", "").trim();
        const docCopia = rawDoc.replace(/\//g, "");

        if (numeroPedido === "") { alert("⚠️ Insira o pedido."); inputPedido.focus(); return; }

        const divNegativo = document.getElementById('divNegativeResult');
        const isNegativo = (divNegativo && divNegativo.style.display !== 'none');
        const statusTexto = isNegativo ? "CNIB NEGATIVO" : "CNIB POSITIVO";

        const textoCopia = `${numeroPedido} - ${statusTexto} - ${nomeLimpo} - ${docCopia} - ${NOME_COPIA_FINAL}`;

        navigator.clipboard.writeText(textoCopia).then(() => {
            const original = btnElemento.innerHTML;
            btnElemento.innerHTML = '✔ Copiado';
            setTimeout(() => { btnElemento.innerHTML = original; }, 1500);

            if (!manterPedido) inputPedido.value = "";
            if (modo === 'LOCAL') gerarPdfClone(nomeLimpo, rawDoc, (isNegativo ? 'NEGATIVO' : 'POSITIVO'), isNegativo);
            else abrirPdfServidorAutoPrint();
        });
    }

    function abrirPdfServidorAutoPrint() {
        const btn = document.getElementById('hpkPrint');
        if (!btn || !btn.href) { alert("Link indisponível."); return; }
        const win = window.open('', '_blank');
        win.document.write(`<html><body style="margin:0;background:#1e293b;"><iframe src="${btn.href}" style="width:100vw;height:100vh;border:none;background:#fff;"></iframe><script>document.querySelector('iframe').onload=function(){setTimeout(()=>{this.contentWindow.print()},1000)}</script></body></html>`);
    }

    function gerarPdfClone(nomeAlvo, docAlvo, statusTexto, isNegativo) {
        let hash = document.querySelector('#txtCopy')?.value || document.querySelector('#spnHashData')?.innerText || "vzkkait5zq";
        const dataObj = new Date();
        const dataHora = dataObj.toLocaleString('pt-BR');

        const iconNegative = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="currentColor" viewBox="0 0 16 16"><path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>`;

        let htmlRes = '';
        if (isNegativo) {
            htmlRes = `<div class="result-container"><div class="result-icon">${iconNegative}</div><div class="result-text-neg">NÃO FORAM ENCONTRADA(S) INDISPONIBILIDADE(S) GENÉRICA(S) E<br>ESPECÍFICA(S) PARA O DOCUMENTO PESQUISADO</div></div>`;
        } else {
            htmlRes = `<div class="result-text-pos">Constam no cadastro da CNIB, as seguintes ocorrências:</div><div class="items-list">`;
            const linhas = document.querySelectorAll('#tbOrdersSpecificBody tr');
            linhas.forEach(tr => {
                const cols = tr.querySelectorAll('td');
                if (cols.length >= 5) {
                    htmlRes += `
                    <div class="item-box">
                        <div class="item-line"><span class="item-label">PROTOCOLO:</span> ${cols[0].innerText.trim()}</div>
                        <div class="item-line"><span class="item-label">NÚMERO DO PROCESSO:</span> ${cols[2].innerText.trim()}</div>
                        <div class="item-line"><span class="item-label">TIPO:</span> ${cols[3].innerText.trim()}</div>
                        <div class="item-line"><span class="item-label">EMISSOR DA ORDEM:</span> ${cols[4].innerText.trim()}</div>
                    </div>`;
                }
            });
            htmlRes += `</div>`;
        }

        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://indisponibilidade.onr.org.br//home/validar`;
        const css = `* { box-sizing: border-box; } body { font-family: Arial, sans-serif; color: #000; margin: 0; padding: 0; font-size: 9.5pt; line-height: 1.3; background: #fff; } @page { margin: 15mm 20mm; size: A4; } .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; border-bottom: 1px solid #000; margin-bottom: 25px; } .logo-cnib { width: 170px; } .logo-onr { width: 150px; } .main-title { font-size: 16pt; font-weight: bold; text-align: left; margin-bottom: 25px; } .sec-header { font-size: 13pt; font-weight: bold; border-bottom: 1px solid #000; padding-bottom: 5px; margin-bottom: 15px; } .dados-grid { display: flex; margin-bottom: 25px; } .dados-col { flex: 1; } .dados-label { font-size: 8pt; font-weight: bold; text-transform: uppercase; margin-bottom: 3px; } .dados-val { font-size: 10pt; text-transform: uppercase;} .res-label { font-size: 13pt; font-weight: bold; margin-bottom: 20px; } .result-container { display: flex; align-items: center; margin-bottom: 35px; padding-left: 5px; } .result-icon { width: 32px; height: 32px; margin-right: 15px; } .result-text-neg { font-weight: bold; font-size: 11pt; } .result-text-pos { margin-bottom: 20px; font-size: 10pt; } .item-box { margin-bottom: 25px; page-break-inside: avoid; } .item-line { margin-bottom: 4px; font-size: 9.5pt; text-transform: uppercase; } .item-label { font-weight: bold; } .legal-text { font-size: 9pt; text-align: justify; margin-bottom: 10px; } .validation-box { border: 1px solid #a0a0a0; border-radius: 5px; padding: 15px; margin-top: 30px; display: flex; align-items: center; page-break-inside: avoid; } .qr-wrapper { border-right: 1px solid #a0a0a0; padding-right: 20px; margin-right: 20px; } .qr-code { width: 80px; height: 80px; display: block; } .val-info { flex: 1; text-align: center; } .val-title { font-weight: bold; font-size: 8.5pt; margin-bottom: 10px; text-transform: none; } .hash-label { font-size: 8pt; margin-bottom: 2px; } .hash-val { font-weight: bold; font-size: 11pt; margin-bottom: 10px; } .url-val { font-size: 7.5pt; color: #000; text-decoration: none; } .footer-table { width: 100%; border: 1px solid #a0a0a0; border-radius: 5px; margin-top: 15px; border-collapse: separate; border-spacing: 0; page-break-inside: avoid; } .footer-table td { padding: 10px; font-size: 8pt; vertical-align: top; border-right: 1px solid #a0a0a0; } .footer-table td:last-child { border-right: none; } .ft-label { font-weight: bold; display: block; margin-bottom: 5px; font-size: 7.5pt;} .page-footer { display: flex; justify-content: space-between; margin-top: 40px; font-size: 7.5pt; border-top: 1px solid #ccc; padding-top: 10px; page-break-inside: avoid; } .footer-right { text-align: right; }`;

        const html = `<html><head><title>Relatório CNIB</title><style>${css}</style></head><body><div class="header"><img src="/img/CNIB-EXTENSO-AZUL.png" class="logo-cnib"><img src="/img/logo-onr-novo.png" class="logo-onr"></div><div class="main-title">Relatório de Consulta de Indisponibilidade de Bens</div><div class="sec-header">Dados Pesquisados</div><div class="dados-grid"><div class="dados-col" style="max-width: 250px;"><div class="dados-label">CPF</div><div class="dados-val">${docAlvo}</div></div><div class="dados-col"><div class="dados-label">NOME</div><div class="dados-val">${nomeAlvo}</div></div></div><div class="res-label">Resultado: ${statusTexto}</div>${htmlRes}<div class="sec-header">Informações Importantes</div><div class="legal-text">Este Relatório foi emitido pela Central Nacional de Indisponibilidade de Bens (CNIB), com base nos artigos 7º e 9º do Provimento CNJ nº 39/2014, de 25/7/2014, da Corregedoria Nacional de Justiça do Conselho Nacional de Justiça (CNJ).</div><div class="legal-text">A informação negativa não significa inexistência de indisponibilidades anteriormente decretadas, assim como eventuais indisponibilidades relacionadas referem-se apenas às ordens que foram cadastradas a partir das referidas datas. Em caso positivo são indicados os números dos processos de execuções trabalhistas, fiscais e cíveis, bem como os respectivos Tribunais em que tramitam, ressalvadas informações de processos que correm em segredo de justiça e em sigilo de justiça. Nessas hipóteses é mantida a informação do resultado positivo, devendo o interessado reportar-se diretamente aos Juízos ou instâncias administrativas competentes que decretaram a indisponibilidade de bens.</div><div class="legal-text">Os dados constantes deste relatório são de responsabilidade direta dos respectivos órgãos do Poder Judiciário e da Administração Pública que os cadastraram.</div><div class="legal-text">Para informações mais completas sobre a situação jurídica da pessoa pesquisada deverão ser feitas pesquisas de maior abrangência nos órgãos do Poder Judiciário e da Administração Pública.</div><div class="validation-box"><div class="qr-wrapper"><img src="${qrUrl}" class="qr-code"></div><div class="val-info"><div class="val-title">Validar autenticidade</div><div class="hash-label">Hash:</div><div class="hash-val">${hash}</div><a href="https://indisponibilidade.org.br" class="url-val">https://indisponibilidade.org.br</a></div></div><table class="footer-table"><tr><td width="30%"><span class="ft-label">Emitido em:</span>${dataHora}</td><td width="40%"><span class="ft-label">Responsável pela Consulta:</span>${typeof getUsuarioLogado === 'function' ? getUsuarioLogado() : 'ARTHUR DA SILVA CRUZ'}</td><td width="30%"><span class="ft-label">CPF do Responsável:</span>${typeof getCPFUsuario === 'function' ? getCPFUsuario() : '176.***.***-**'}</td></tr></table><div class="page-footer"><div>Data e Hora deste Relatório: ${dataHora}<br>https://indisponibilidade.org.br</div><div class="footer-right"><strong>Relatório de Consulta de Indisponibilidade de Bens</strong><br></div></div><script>window.onload = function() { setTimeout(() => { window.print(); }, 800); }</script></body></html>`;

        const win = window.open('', '_blank', 'width=900,height=900');
        win.document.write(html);
        win.document.close();
        return win;
    }

    // --- ELEMENTOS MANUAIS MINIMALISTAS ---
    function criarElementosControle() {
        if (document.getElementById('divControlesJulio')) return;
        const ln = document.getElementById('lblName');
        if(!ln) return;

        const c = document.createElement('div');
        c.id = 'divControlesJulio';
        // Glassmorphism Minimalista (menor padding, borda sutil)
        c.className = 'flex items-center mt-3 gap-2.5 bg-slate-900/40 backdrop-blur-md border border-slate-700/50 p-1.5 rounded-lg shadow-sm w-fit';

        c.innerHTML = `
            <div class="flex items-center gap-1.5 pl-1 pr-2.5 border-r border-slate-700/50">
                <label class="relative inline-flex items-center cursor-pointer shrink-0">
                    <input type="checkbox" id="chkManterPedido" class="sr-only peer">
                    <div class="w-8 h-4 bg-slate-700 rounded-full peer peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-300 after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-indigo-500/80 peer-checked:after:bg-white shadow-inner"></div>
                </label>
                <label for="chkManterPedido" class="text-[10px] font-semibold text-slate-400 cursor-pointer select-none uppercase tracking-wider">Manter</label>
            </div>

            <input type="text" id="inputNumeroPedido" class="px-2 py-1 text-xs bg-transparent border-b border-slate-600 focus:border-indigo-400 outline-none w-28 text-slate-200 placeholder-slate-500 transition-colors" placeholder="Nº Pedido">
        `;

        // Ghost Buttons Minimalistas
        const bl = document.createElement('button');
        bl.className = 'bg-transparent hover:bg-emerald-500/10 text-emerald-400 text-[11px] font-bold py-1 px-2.5 rounded transition-all flex items-center gap-1 border border-emerald-500/30 ml-1';
        bl.innerHTML = '⚡ Rápido';
        bl.onclick = function(){executarAcaoManual('LOCAL', bl);};

        const bs = document.createElement('button');
        bs.className = 'bg-transparent hover:bg-indigo-500/10 text-indigo-400 text-[11px] font-bold py-1 px-2.5 rounded transition-all flex items-center gap-1 border border-indigo-500/30';
        bs.innerHTML = '🖨️ Oficial';
        bs.onclick = function(){executarAcaoManual('SERVER', bs);};

        c.appendChild(bl);
        c.appendChild(bs);
        ln.parentNode.insertBefore(c, ln.nextSibling);
    }

    function iniciarObservador() {
        inicializarUI();
        const o = new MutationObserver(() => {
            if (!document.getElementById('btnOpenBulkFAB')) inicializarUI();
            if (!document.getElementById('divControlesJulio')) criarElementosControle();
        });
        o.observe(document.body, { childList: true, subtree: true });
    }

    iniciarObservador();
    setInterval(clicarBotaoPesquisar, TEMPO_POLLING * 2);

})();