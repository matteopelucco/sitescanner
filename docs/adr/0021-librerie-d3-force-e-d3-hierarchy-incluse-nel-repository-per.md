---
status: accepted
date: 2026-10-26
decision-makers: Pelucco Matteo
---

# Librerie d3-force e d3-hierarchy incluse nel repository per il grafo della mappa

## Contesto e problema

La mappa del sito ([§14](../specs/14-mappa-del-sito.md), [ADR-0020](0020-mappa-del-sito-come-vista-dell-inventario-esteso.md)) mostra un grafo interattivo con tre disposizioni: radiale, a livelli e a forza. Serve calcolare le posizioni di migliaia di nodi (il limite di default dell'inventario è 5000), anche in un Web Worker, e disegnare lo stesso diagramma in modo statico nel PDF. [ADR-0001](0001-node-js-esm-senza-build-e-dipendenze-minime.md) privilegia poche dipendenze e nessun passo di build; il report deve funzionare da `file://` e nel bundle offline ([ADR-0007](0007-report-statico-con-caricamento-dati-via-script.md)).

## Fattori decisionali

* Funzionare offline, da `file://` e su Vercel, senza richieste a terzi.
* Disposizione a forza affidabile e prestazioni collaudate, senza riscriverle.
* Pieno controllo di stile, etichette e archi curvi nel disegno.
* Nessun passo di build.
* Licenza compatibile e peso contenuto.

## Opzioni considerate

Libreria:
* canvas senza librerie, con le disposizioni scritte nel progetto;
* d3-force (simulazione) e d3-hierarchy (albero e radiale), solo per le posizioni;
* sigma.js con graphology (render WebGL).

Inclusione:
* file minificato nel repository, con la sua licenza;
* dipendenza npm servita da `node_modules`;
* CDN.

## Esito della decisione

Scelte da Pelucco Matteo il 2026-10-26: **d3-force e d3-hierarchy**, inclusi come **file nel repository**.

Dettagli:

* I file stanno in `src/web/vendor/` insieme alla licenza (ISC); la versione è fissata e un piccolo script la aggiorna e verifica l'integrità.
* Le librerie calcolano solo le posizioni; il disegno su canvas, le etichette, l'interazione e gli archi curvi restano nel codice del progetto.
* d3-hierarchy serve anche a posizionare il diagramma radiale statico del PDF ([§14.7](../specs/14-mappa-del-sito.md#147-export)).
* Il bundle HTML offline contiene la stessa copia delle librerie.
* Questa è un'eccezione circoscritta alla regola di ADR-0001: nessuna altra libreria di visualizzazione è ammessa senza una nuova decisione.

### Conseguenze

* Positivo, perché la disposizione a forza è collaudata e si calcola in un Web Worker.
* Positivo, perché nessuna richiesta di rete: il report e il bundle restano autonomi.
* Positivo, perché lo stile resta quello del resto del prodotto.
* Negativo, perché c'è codice di terzi da tenere aggiornato nel repository (un file e uno script).
* Negativo, perché oltre qualche migliaio di nodi le prestazioni non bastano più: per questo il grafo parte aggregato oltre 1500 nodi. Per siti molto più grandi servirebbe un render WebGL (sigma.js) e una nuova decisione.
* Neutro, perché ADR-0001 resta valida per tutto il resto del progetto.

### Verifica

Test di caricamento delle librerie da `file://` nel bundle offline, in un browser headless, e misura dei fotogrammi con 1500 nodi (RNF-MAP-02).

## Pro e contro delle opzioni

### Canvas senza librerie
* Positivo, perché nessuna dipendenza e nessuna eccezione a ADR-0001.
* Negativo, perché simulazione a forza e altre disposizioni vanno scritte e rifinite da zero.

### d3-force + d3-hierarchy
* Positivo, perché piccole, mature e senza vincoli sul disegno.
* Negativo, perché il rendering e le interazioni restano da scrivere.

### sigma.js + graphology
* Positivo, perché rendering WebGL di decine di migliaia di nodi.
* Negativo, perché più pesante, con meno controllo su etichette e archi curvi, WebGL difficile da testare in headless e PDF da disegnare a parte.

### File nel repository
* Positivo, perché funziona offline e senza build.
* Negativo, perché l'aggiornamento è manuale (con uno script).

### Dipendenza npm
* Positivo, perché aggiornamenti e licenze gestiti da npm.
* Negativo, perché servono rotte per servirla e una copia nel bundle offline.

### CDN
* Positivo, perché nessun file da mantenere.
* Negativo, perché non funziona offline né da `file://` e dipende da terzi.
