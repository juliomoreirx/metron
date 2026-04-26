#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// Build do pacote de agente CNIB
// Roda na VPS uma vez após gerar o cnib-agent.exe
//
// Pré-requisito:
//   cd cnib-agent-package
//   npm run build   (gera o cnib-agent.exe)
//   cd ..
//   node build-agent.js
//
// Resultado: cnib-agent-setup.zip pronto para download
// ═══════════════════════════════════════════════════════════

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const PKG_DIR  = path.join(__dirname, 'cnib-agent-package');
const ZIP_OUT  = path.join(__dirname, 'cnib-agent-setup.zip');

// Arquivos que vão no zip
const FILES = [
    { src: path.join(PKG_DIR, 'cnib-agent.exe'), name: 'cnib-agent.exe', required: true  },
    { src: path.join(PKG_DIR, 'launcher.vbs'),   name: 'launcher.vbs',   required: true  },
    { src: path.join(PKG_DIR, 'setup.bat'),       name: 'setup.bat',      required: true  },
];

console.log('\n📦 Gerando cnib-agent-setup.zip...\n');

// Verifica arquivos necessários
const missing = FILES.filter(f => f.required && !fs.existsSync(f.src));
if (missing.length > 0) {
    console.error('❌ Arquivos não encontrados:');
    missing.forEach(f => console.error('   -', f.src));
    console.error('\nCertifique-se de ter rodado o build do .exe antes:');
    console.error('  cd cnib-agent-package && npm run build\n');
    process.exit(1);
}

// Usa o zip nativo do Linux ou python para criar o zip
try {
    // Cria pasta temp
    const tmpDir = '/tmp/cnib-agent-build';
    execSync(`rm -rf ${tmpDir} && mkdir -p ${tmpDir}`);

    // Copia arquivos
    FILES.filter(f => fs.existsSync(f.src)).forEach(f => {
        fs.copyFileSync(f.src, path.join(tmpDir, f.name));
        console.log('  ✓', f.name);
    });

    // Gera o zip
    execSync(`cd ${tmpDir} && zip -r ${ZIP_OUT} .`, { stdio: 'pipe' });

    // Limpa temp
    execSync(`rm -rf ${tmpDir}`);

    const size = (fs.statSync(ZIP_OUT).size / 1024 / 1024).toFixed(1);
    console.log(`\n✅ Zip gerado: cnib-agent-setup.zip (${size} MB)`);
    console.log('   O arquivo está disponível em /cnib-agent-setup.zip no sistema.\n');

} catch (err) {
    console.error('❌ Erro ao gerar zip:', err.message);
    process.exit(1);
}