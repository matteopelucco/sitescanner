---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Un unico modulo di confronto puro, eseguito sia dalla CLI sia dal report nel browser

## Contesto e problema

Il confronto Base/Head serve in due posti: nel comando `compare` (CI, exit code, JSON) e nel report, dove l'utente sceglie liberamente due scan qualsiasi dello storico e può caricare una redirect map. Bisognava decidere dove calcolarlo.

## Fattori decisionali

* CLI e report devono dare sempre lo stesso risultato.
* Il report deve permettere qualsiasi coppia di scan senza rigenerarlo.
* Una sola implementazione da mantenere e testare.

## Opzioni considerate

* Modulo JavaScript senza dipendenze né import (`src/core/compare.js`), incluso testualmente nel report e importato dalla CLI.
* Precalcolare nel report i confronti di tutte le coppie di scan.
* Due implementazioni separate (CLI e browser).

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "modulo puro condiviso", perché garantisce per costruzione lo stesso risultato e rende il report interattivo con un costo di generazione nullo.

Vincolo: `src/core/compare.js` non può avere `import`, né usare API di Node o del DOM. Il generatore del report rimuove le parole chiave `export` e lo incorpora in uno `<script>`.

### Conseguenze

* Positivo, perché un solo codice, coperto dagli stessi test, per CLI e report.
* Positivo, perché nel report si può cambiare coppia di scan e caricare una redirect map al volo.
* Negativo, perché il modulo deve restare autosufficiente: helper condivisi con il resto del codice vanno duplicati o spostati al suo interno (es. `toKey`, usato anche dal crawler).
* Negativo, perché l'incorporazione si basa sulla rimozione testuale di `export` a inizio riga: forme come `export default` o `export { … } from` romperebbero il report.
* Negativo, perché il confronto visivo pixel per pixel non può usare `pngjs`/`pixelmatch` nel browser: la CLI lo calcola con Node, il report con il canvas (solo via http, vedi [ADR-0007](0007-report-statico-con-caricamento-dati-via-script.md)).

### Verifica

Il test e2e controlla che il report generato contenga `function compareScans` e nessuna riga che inizi con `export`. Code review: nessun `import` in `src/core/`.

## Pro e contro delle opzioni

### Modulo puro condiviso

* Positivo, perché coerenza garantita.
* Negativo, perché vincoli di scrittura sul modulo.

### Confronti precalcolati

* Negativo, perché il numero di coppie cresce col quadrato delle scan e la redirect map andrebbe nota al momento della generazione.

### Due implementazioni

* Negativo, perché divergenze inevitabili tra CI e report.
