---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Node.js ESM senza build step, con dipendenze minime e Playwright opzionale

## Contesto e problema

sitescanner è un tool CLI da usare in locale e in CI, che deve anche produrre un report HTML eseguito nel browser. Serviva scegliere linguaggio e runtime, se introdurre un passo di build e quante dipendenze accettare. Lo screenshot delle pagine richiede un browser headless, che pesa centinaia di MB e non sempre è installabile in CI.

## Fattori decisionali

* Installazione semplice in locale e in CI.
* Possibilità di eseguire la stessa logica di confronto nella CLI e nel browser (vedi [ADR-0006](0006-modulo-di-confronto-puro-condiviso.md)).
* Superficie di dipendenze ridotta e facile da aggiornare.
* Gli screenshot non devono essere un prerequisito per usare il tool.

## Opzioni considerate

* Node.js con ES modules e JavaScript puro, senza build.
* Node.js con TypeScript e passo di compilazione.
* Python (requests/httpx, BeautifulSoup, Playwright for Python).

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "Node.js con ES modules e JavaScript puro, senza build", perché lo stesso linguaggio gira nella CLI e nel report, e il runtime moderno fornisce già `fetch`, `parseArgs`, `node:test`.

Dipendenze: `yaml` (configurazione), `node-html-parser` (analisi HTML), `pngjs` + `pixelmatch` (diff visivo). `playwright` è una dipendenza **opzionale** caricata con `import()` dinamico: se manca o Chromium non parte, la scan prosegue senza screenshot.

### Conseguenze

* Positivo, perché `npm install` basta per usare il tool; nessun artefatto da compilare.
* Positivo, perché il modulo di confronto viene incluso nel report così com'è.
* Positivo, perché senza Playwright il tool resta utilizzabile (scan senza screenshot).
* Negativo, perché manca il controllo dei tipi: i formati dei dati (`scan.json`, risultato del confronto) sono documentati solo nelle specifiche e verificati dai test.
* Negativo, perché richiede Node.js ≥ 20 (per `fetch`, `AbortSignal.timeout`, `parseArgs`).
* Negativo, perché `node-html-parser` è tollerante ma non è un parser HTML5 conforme: su markup molto irregolare i risultati possono differire da quelli di un browser.

### Verifica

`npm test` gira senza build; `package.json` dichiara `engines.node >= 20` e `playwright` in `optionalDependencies`.

## Pro e contro delle opzioni

### Node.js ESM, JavaScript puro

* Positivo, perché un solo linguaggio per CLI e browser.
* Positivo, perché zero configurazione di toolchain.
* Negativo, perché nessun controllo statico dei tipi.

### Node.js con TypeScript

* Positivo, perché tipi espliciti per i formati dei dati.
* Negativo, perché serve un passo di build anche per il codice incluso nel report.
* Neutro, perché si può introdurre in seguito con JSDoc + `tsc --checkJs` senza build.

### Python

* Positivo, perché ecosistema maturo per scraping.
* Negativo, perché la logica di confronto andrebbe scritta due volte (Python e JavaScript per il report), con il rischio che divergano.

## Ulteriori informazioni

Se i formati dei dati crescono, valutare il controllo dei tipi via JSDoc e `tsc --checkJs` prima di introdurre una build.
