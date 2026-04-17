const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

// Função centralizada para comunicar com o ONR
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
                timeout: 15000, // Aborta se o ONR demorar mais de 15 segundos
                validateStatus: status => status >= 200 && status < 400 
            }
        );
        
        console.log(`[<-] ONR: Resposta recebida. Status: ${response.status}`);
        return response;

    } catch (error) {
        console.error(`[X] ONR: Erro na requisição (Timeout ou Falha de Rede):`, error.message);
        throw error;
    }
}

// --- ROTAS DA API ---

app.post('/api/validar', async (req, res) => {
    const { cookies } = req.body;
    console.log('\n--- Nova tentativa de Validação de Cookies ---');
    
    try {
        const response = await requestONR('00000000000', cookies);
        
        if (response.status === 200 && typeof response.data === 'object') {
            console.log('[OK] Validação bem sucedida.');
            res.json({ sucesso: true });
        } else {
            console.log('[AVISO] ONR recusou o cookie (Status 302 ou não-JSON).');
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
        
        // Se a resposta for um redirecionamento pro login (302) ou HTML em vez de JSON, a sessão caiu
        if (response.status === 302 || typeof response.data === 'string') {
            console.log('[AVISO] Sessão expirou durante a pesquisa.');
            return res.status(401).json({ erro: 'Sessão expirada' });
        }

        console.log('[OK] Dados enviados ao Front-end com sucesso.');
        res.json(response.data);

    } catch (error) {
        res.status(500).json({ erro: 'Falha ao processar a consulta no servidor.' });
    }
});

// Captura qualquer outra rota e joga pro Front-end (Resolve o erro "Cannot GET")
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicia o Servidor
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`=========================================`);
});