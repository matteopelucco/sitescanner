---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Crawling e analisi via HTTP; browser headless usato solo per gli screenshot

## Contesto e problema

Per ogni pagina servono status, redirect, metadati, testo e link, e possibilmente uno screenshot. Si poteva fare tutto con un browser headless (vedendo la pagina come un utente, JavaScript incluso) oppure leggere l'HTML via HTTP e usare il browser solo per le immagini.

## Fattori decisionali

* Velocità e consumo di risorse su siti di centinaia di pagine, anche in CI.
* Dati di rete precisi: status reali, catene di redirect, tempi di risposta.
* Funzionare anche senza browser installato ([ADR-0001](0001-node-js-esm-senza-build-e-dipendenze-minime.md)).
* Coprire i siti che generano contenuto lato client.

## Opzioni considerate

* `fetch` HTTP con redirect manuali + parser HTML; Playwright solo per gli screenshot, in una fase separata.
* Playwright per tutto: navigazione, estrazione dal DOM renderizzato, screenshot.
* Scelta configurabile per sito tra le due modalità.

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "`fetch` + parser, Playwright solo per gli screenshot", perché il crawling resta veloce e indipendente dal browser, e i dati HTTP (status, redirect, tempi) sono quelli reali del server.

Gli screenshot si fanno dopo il crawling, solo sulle pagine HTML 2xx, con animazioni disattivate e selettori configurabili da nascondere, per ridurre falsi positivi nei confronti visivi.

### Conseguenze

* Positivo, perché il crawling non richiede Chromium e si può disattivare la fase screenshot (`--no-screenshots`).
* Positivo, perché i redirect seguiti manualmente producono la catena completa.
* Negativo, perché titoli, testo e link generati via JavaScript **non** vengono analizzati né confrontati: nei siti SPA i finding di contenuto sono incompleti (resta solo il confronto visivo).
* Negativo, perché ogni pagina con screenshot viene scaricata due volte (HTTP e browser), e le due richieste potrebbero vedere contenuti leggermente diversi.
* Neutro, perché il tempo di risposta misurato è quello HTTP, non metriche di rendering.

## Pro e contro delle opzioni

### HTTP + parser, browser solo per screenshot

* Positivo, perché veloce, leggero, deterministico.
* Negativo, perché cieco al contenuto generato lato client.

### Playwright per tutto

* Positivo, perché vede la pagina come l'utente.
* Negativo, perché molto più lento e pesante, e il browser diventa obbligatorio.
* Negativo, perché status e catene di redirect sono meno immediati da ricostruire.

### Modalità configurabile

* Positivo, perché copre anche le SPA.
* Negativo, perché due percorsi di estrazione da mantenere e confronti non omogenei tra scan fatte in modalità diverse.

## Ulteriori informazioni

Rivedere se si devono scansionare siti SPA: la modalità configurabile per sito è l'evoluzione naturale. Se introdotta, la modalità usata dovrebbe essere registrata nell'istantanea e il confronto tra scan di modalità diverse segnalato.
