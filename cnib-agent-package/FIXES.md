# CNIB Agent — Correções de Login com Certificado

## Problemas Corrigidos

### 1. **Agent.js — Loop de Polling de Cookies**

**Problema Original:**
- O agente abria o Chrome corretamente, mas ficava em loop infinito tentando capturar os cookies
- A lógica de parseamento de frames WebSocket era frágil e não tratava mensagens grandes
- O comando `Network.getCookies` era enviado ANTES do handshake WebSocket ser concluído

**Solução Implementada:**
- **Buffer Acumulativo**: Frames WebSocket agora são acumulados em um buffer antes de serem parseados
- **Handshake Garantido**: `Network.getCookies` só é enviado APÓS o handshake ser confirmado (resposta 101)
- **Parseamento Robusto**: 
  - Suporta payloads de qualquer tamanho (26-bit, 64-bit)
  - Remove dados processados do buffer incrementalmente
  - Trata JSON parsing errors sem falhar completamente
- **Timeouts Melhorados**: Aumentado para 6s nas chamadas CDP
- **Logs Detalhados**: Cada etapa está logada no console para debug

### 2. **Frontend — Polling de Status Mais Rápido**

**Alterações:**
- Frequência de polling aumentada de 2500ms → 1500ms
- Logs console adicionados em cada estágio (`[CERT POLLING]`, `[CERT LOGIN]`, etc)
- Tratamento melhor de erros HTTP
- Aguarda 800ms após sucesso antes de fechar modal (UX melhor)
- `_resetCertBtn()` agora garante que polling seja parado

### 3. **Melhor Fechamento de Modal**

- Modal fecha automaticamente após login bem-sucedido
- Botão de cancelamento garante limpeza de state
- Errors mostram mensagem legível e permitem fechar

## Como Testar

1. **No Console do Chrome (DevTools):**
   ```javascript
   // Abrir o developer tools (F12) e colar na console do frontend
   console.log('Agent Status:', _certSessionId);
   ```

2. **Logs do Agent (Node.js):**
   - O agente agora printa logs detalhados quando executado
   - Procure por `[AGENT]` no output

3. **Fluxo de Login Esperado:**
   ```
   1. Clica em "Login com Certificado"
   2. Modal abre com instrução
   3. Clica em "Abrir Agente CNIB"
   4. Chrome abre com página de login do ONR
   5. Usuário seleciona certificado CERTSIGN RFB
   6. Agente detecta cookies (CNIB_USER ou CNIB.Auth)
   7. Modal mostra "Login detectado! Validando..."
   8. Modal fecha automaticamente
   9. Frontend redireciona para página autenticada
   ```

## Código Principal Alterado

### agent.js (lines 240-350)
- Loop de polling com prints em cada tentativa
- Melhor gestão de buffer WebSocket
- Logs de diagnóstico

### public/index.html (lines 2076-2285)
- `loginComCertificado()` - inicia polling mais rápido
- `_verificarStatusCert()` - melhor tratamento de estados
- `_aguardarAgente()` - frequência aumentada
- `_resetCertBtn()` - garante limpeza
- `_certModalErro()` - melhor logging

## Debugging

Se ainda houver loop, verificar:

1. **Agente não abre Chrome:**
   - Certificar que Chrome está instalado em um dos caminhos padrão
   - Tentar fechar todas as instâncias do Chrome antes

2. **Agente abre Chrome mas não encontra aba:**
   - A URL `https://indisponibilidade.onr.org.br/login/certificate` pode estar bloqueada
   - Verificar conexão de internet

3. **Aba abre mas cookies não são capturados:**
   - O usuário pode não ter completado a autenticação com certificado
   - Verificar logs do agente: procurar por `Poll #X: Cookies encontrados mas sem auth válida`

4. **Frontend não sai do "Aguardando...":**
   - Backend pode não estar recebendo os cookies do agente
   - Verificar em `/api/cert-login/status` se está retornando `"status": "done"`
