// ═══════════════════════════════════════════════════════════
// CNIB — Setup do Agente (roda UMA VEZ como Administrador)
//
// O que faz:
//   1. Registra o protocolo cnib:// no Windows Registry
//      para que o site possa abrir o agente automaticamente
//   2. Cria atalho na Área de Trabalho (opcional)
//
// Uso:
//   node setup-agent.js          (ou duplo clique no setup.bat)
// ═══════════════════════════════════════════════════════════

const { execSync, exec } = require('child_process');
const path   = require('path');
const fs     = require('fs');

// Caminho do executável do agente (na mesma pasta do setup)
const AGENT_EXE = path.join(__dirname, 'cnib-agent.exe');
const AGENT_JS  = path.join(__dirname, 'agent.js');

// Usa o .exe se existir, senão usa node + agent.js
const HANDLER = fs.existsSync(AGENT_EXE)
    ? `"${AGENT_EXE}" "%1"`
    : `"${process.execPath}" "${AGENT_JS}" "%1"`;

console.log('');
console.log('╔══════════════════════════════════════════════════╗');
console.log('║   CNIB — Configuração do Agente de Certificado   ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log('');
console.log('Handler:', HANDLER);
console.log('');

if (process.platform !== 'win32') {
    console.error('Este setup é apenas para Windows.');
    process.exit(1);
}

// ── Registra o protocolo cnib:// no Registry ────────────────
// Estrutura necessária:
//   HKCU\Software\Classes\cnib
//     (Default) = "URL:CNIB Login Protocol"
//     URL Protocol = ""
//   HKCU\Software\Classes\cnib\shell\open\command
//     (Default) = "C:\path\to\cnib-agent.exe" "%1"
//
// Usamos HKCU (Current User) — NÃO precisa de Admin!

function regAdd(key, name, type, value) {
    const nameArg  = name ? `/v "${name}"` : '/ve';
    const escaped  = value.replace(/"/g, '\\"');
    const cmd      = `reg add "${key}" ${nameArg} /t ${type} /d "${escaped}" /f`;
    try {
        execSync(cmd, { stdio: 'pipe' });
        return true;
    } catch (err) {
        console.error('Erro reg add:', err.message);
        return false;
    }
}

console.log('Registrando protocolo cnib:// no Windows...');

const baseKey = 'HKCU\\Software\\Classes\\cnib';

const ok1 = regAdd(baseKey, '',             'REG_SZ', 'URL:CNIB Login Protocol');
const ok2 = regAdd(baseKey, 'URL Protocol', 'REG_SZ', '');
const ok3 = regAdd(`${baseKey}\\shell\\open\\command`, '', 'REG_SZ', HANDLER);

if (ok1 && ok2 && ok3) {
    console.log('✅ Protocolo cnib:// registrado com sucesso!');
} else {
    console.error('❌ Falha ao registrar protocolo.');
    process.exit(1);
}

// ── Cria atalho na Área de Trabalho ────────────────────────
const desktopPath = path.join(require('os').homedir(), 'Desktop');
const batPath     = path.join(desktopPath, 'CNIB Agent.bat');

// Cria um .bat na área de trabalho para execução manual se necessário
const batContent  = `@echo off\n"${process.execPath}" "${AGENT_JS}" %*\npause\n`;
try {
    fs.writeFileSync(batPath, batContent);
    console.log('✅ Atalho criado na Área de Trabalho: CNIB Agent.bat');
} catch {
    console.warn('⚠️  Não foi possível criar atalho na Área de Trabalho (não crítico).');
}

console.log('');
console.log('══════════════════════════════════════════════════');
console.log('  ✅ Setup concluído!');
console.log('');
console.log('  O sistema CNIB agora pode abrir o agente');
console.log('  automaticamente quando você clicar em');
console.log('  "Login com Certificado Digital".');
console.log('');
console.log('  Você não precisa rodar este setup novamente.');
console.log('══════════════════════════════════════════════════');
console.log('');

// Mantém janela aberta por 5s
setTimeout(() => process.exit(0), 5000);
