#!/usr/bin/env node

/**
 * Script de teste para /api/pdf-clone
 * Simula uma requisição com múltiplas indisponibilidades
 */

const http = require('http');

const testData = {
    cookies: 'CNIB_USER=test; CNIB.Auth=test123',
    documento: '12345678900',
    responsavelNome: 'JOÃO SILVA DOS SANTOS',
    responsavelCPF: '123.***.***-45',
    nomeAlvo: 'MARIA DOS SANTOS OLIVEIRA',
    statusTexto: 'POSITIVO',
    orders: [
        {
            protocol: 'CNJ-001-2024',
            processNumber: '0000001-50.2024.8.26.0100',
            processName: 'INDISPONIBILIDADE GENÉRICA',
            organizationLabel: 'TRIBUNAL DE JUSTIÇA DO ESTADO DE SÃO PAULO'
        },
        {
            protocol: 'CNJ-002-2024',
            processNumber: '0000002-50.2024.8.26.0100',
            processName: 'INDISPONIBILIDADE ESPECÍFICA - VEÍCULO',
            organizationLabel: 'CARTÓRIO DO 1º OFÍCIO'
        },
        {
            protocol: 'CNJ-003-2024',
            processNumber: '0000003-50.2024.8.26.0100',
            processName: 'INDISPONIBILIDADE GENÉRICA',
            organizationLabel: 'FÓRUM CÍVEL'
        },
        {
            protocol: 'CNJ-004-2024',
            processNumber: '0000004-50.2024.8.26.0100',
            processName: 'INDISPONIBILIDADE ESPECÍFICA - IMÓVEL',
            organizationLabel: 'TRIBUNAL DE JUSTIÇA DO ESTADO DE MINAS GERAIS'
        },
        {
            protocol: 'CNJ-005-2024',
            processNumber: '0000005-50.2024.8.26.0100',
            processName: 'INDISPONIBILIDADE GENÉRICA',
            organizationLabel: 'CARTÓRIO DO 2º OFÍCIO'
        }
    ]
};

const body = JSON.stringify(testData);

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/pdf-clone',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    }
};

const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers: ${JSON.stringify(res.headers)}`);
    
    let data = Buffer.alloc(0);
    
    res.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
        process.stdout.write('.');
    });
    
    res.on('end', () => {
        console.log(`\n\nRecebido: ${data.length} bytes`);
        
        if (res.statusCode === 200 && data.length > 0) {
            // Salva PDF
            const fs = require('fs');
            fs.writeFileSync('test-output.pdf', data);
            console.log('✓ PDF salvo em: test-output.pdf');
        } else {
            // Tenta parsear como JSON error
            try {
                const json = JSON.parse(data.toString());
                console.log('Erro:', JSON.stringify(json, null, 2));
            } catch {
                console.log('Response:', data.toString().slice(0, 500));
            }
        }
    });
});

req.on('error', (e) => {
    console.error(`Erro: ${e.message}`);
});

console.log('Enviando requisição para /api/pdf-clone...');
console.log(`Com ${testData.orders.length} indisponibilidades\n`);
req.write(body);
req.end();
