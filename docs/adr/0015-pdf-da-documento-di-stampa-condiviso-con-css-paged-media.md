---
status: accepted
date: 2026-10-24
decision-makers: Matteo Pelucco
---

# PDF da un documento di stampa condiviso, impaginato con CSS paged media e reso da Chromium

## Contesto e problema

Servono PDF di alta qualità del report di qualità (una scan) e del report di regressione (Base/Head), da consegnare a clienti o allegare a un rilascio: copertina, sommario, intestazioni e numeri di pagina, sezioni che non si spezzano male. Il report interattivo non è adatto alla stampa (schede, filtri, drawer, elenchi paginati) e deve continuare a funzionare da `file://` e nei bundle di export, dove non c'è un server.

## Fattori decisionali

* Qualità tipografica e impaginazione controllata (numeri di pagina «N di M», intestazioni ripetute, niente righe spezzate).
* Disponibile da CLI, web app e report statico, con lo stesso risultato.
* Nessuna dipendenza nuova (ADR-0001): Playwright è già opzionale per gli screenshot.
* Contenuti dei siti sempre trattati come testo.

## Opzioni considerate

* Un documento HTML di stampa generato da un modulo puro (`src/core/print.js`), impaginato con CSS paged media (`@page`, margin box, `break-*`), trasformato in PDF da Chromium headless (Playwright `page.pdf`) e, nel browser, stampato con la stampa di sistema.
* Una libreria di generazione PDF (pdfkit, jsPDF) che disegna il documento.
* `@media print` sul report interattivo.

## Esito della decisione

Opzione scelta (implementata, confermata il 2026-10-24): "documento di stampa condiviso", perché lo stesso HTML produce il PDF in Node e nel browser, con l'impaginazione del motore di Chromium.

Dettagli:

* `renderPrintHtml({ base, head?, compare, siteName, version })` restituisce un documento autonomo (CSS incluso). È un modulo di `src/core/` come il confronto (ADR-0006): il report lo incorpora e la CLI lo importa.
* Intestazioni e «Pagina N di M» usano i margin box di `@page` (supportati da Chromium dalla versione 131), quindi niente `headerTemplate` di Playwright: il risultato è identico tra `page.pdf` e la stampa del browser. La copertina li nasconde con `@page :first`.
* `page.pdf({ preferCSSPageSize, printBackground, outline, tagged })`: dimensioni dal CSS, colori, segnalibri dai titoli, PDF taggato.
* Gli elenchi lunghi sono troncati con limiti fissi e un rimando al report interattivo, per tenere il documento leggibile.
* Il pulsante «PDF» del report chiede il PDF al server (`GET /api/pdf`) quando è servito da `sitescanner ui`; altrimenti, o se il server non ha Playwright, apre il documento di stampa e avvia la stampa del browser.
* `SITESCANNER_CHROMIUM` permette di usare un Chromium/Chrome già installato, per PDF e screenshot.

### Conseguenze

* Positivo, perché un solo documento, coperto da test unitari, per tutti i canali.
* Positivo, perché l'impaginazione è CSS: facile da rifinire.
* Negativo, perché il PDF da CLI e web app richiede Chromium; senza, resta solo la stampa dal browser.
* Negativo, perché la stampa da browser diversi da Chromium (es. Firefox) può ignorare i margin box: niente intestazioni e numeri di pagina in quel caso.

### Verifica

`test/print.test.js` (struttura, paged media, escaping, troncamenti); `test/e2e.test.js` genera i due PDF con il comando `pdf` (o verifica l'errore d'uso se Chromium non c'è); `test/web.test.js` verifica la validazione di `/api/pdf`.

## Pro e contro delle opzioni

### Documento di stampa condiviso

* Positivo, perché qualità tipografica del browser, testo selezionabile, tabelle con intestazioni ripetute.
* Negativo, perché dipende dal supporto CSS paged media del motore.

### Libreria PDF

* Positivo, perché nessun browser necessario.
* Negativo, perché impaginazione di tabelle e testo da fare a mano, una dipendenza in più e un secondo modo di rappresentare il report.

### `@media print` sul report

* Positivo, perché nessun documento in più.
* Negativo, perché il report è interattivo e paginato: stamperebbe solo la scheda visibile, senza copertina né sommario.
