---
status: proposed
date: 2026-10-24
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Catalogo delle regole di qualità registrato in ogni scan, per non scambiare regole nuove per regressioni

## Contesto e problema

Ogni sito può disattivare alcune regole di qualità o cambiarne la severità (`quality`). Il confronto Base/Head segnala come `issue-new`, con la severità della issue, ogni codice presente solo in Head. Se tra due scan si riattiva una regola (o si aggiorna il catalogo), le sue issue apparirebbero come regressioni, anche `error`, e la CI fallirebbe senza che il sito sia cambiato. La compatibilità con le scan salvate dalle versioni precedenti non è un requisito: il progetto è in sviluppo e si riparte da zero.

## Fattori decisionali

* Un cambio della configurazione `quality` non deve far fallire `compare --fail-on`.
* Le scan sono immutabili: non si possono ricalcolare le issue di una scan senza l'HTML (che di norma non è salvato).
* Le regole devono restare personalizzabili per sito.
* Il confronto resta una funzione pura, condivisa da CLI e report (ADR-0006).

## Opzioni considerate

* Registrare in ogni scan l'elenco dei codici verificati (`options.issueCodes`); nel confronto, un codice non verificato in Base produce `issue-new` di severità info, e un codice non verificato in Head non produce `issue-resolved`.
* Una versione numerica del set di regole nell'istantanea, con una tabella delle regole per versione nel confronto.
* Nessuna gestione: documentare che dopo un aggiornamento si confronta solo tra scan nuove.

## Esito della decisione

Opzione scelta (implementata, da confermare): "elenco dei codici verificati", perché rappresenta esattamente cosa è stato controllato, comprese le regole disattivate per sito, senza tabelle di versioni da mantenere.

Dettagli:

* Il catalogo unico delle regole è `ISSUE_TYPES` in `src/core/diagnose.js` (codice → severità predefinita, categoria, descrizione): da lì derivano le severità usate da `analyze.js`, le descrizioni e le categorie del report e l'elenco registrato nella scan.
* Una scan senza `options.issueCodes` è trattata come se avesse verificato tutte le regole: nessuna tabella delle regole di versioni precedenti.
* Le issue nuove non sono nascoste: restano visibili come info, con il messaggio «regola non attiva in Base».
* Le differenze che dipendono da campi nuovi (dati strutturati) si calcolano solo se entrambe le scan li hanno; l'indicizzabilità si deriva dai campi disponibili, quindi vale anche per le scan vecchie.
* Il health score (quota di URL senza issue `error`, come Ahrefs) è salvato in `stats` e calcolato al volo per le scan vecchie.

### Conseguenze

* Positivo, perché cambiare `quality` tra due scan non genera falsi fallimenti in CI.
* Positivo, perché ogni scan documenta da sola quali controlli ha eseguito.
* Negativo, perché per un confronto pieno su una regola appena riattivata servono due scan fatte con la regola attiva.
* Negativo, perché un codice rinominato in futuro andrà gestito come rimosso + aggiunto (o con un alias nel confronto).

### Verifica

`test/compare.test.js` («issues of rules that Base did not run are info, not regressions»); `test/web.test.js` verifica che una regola disattivata non sia registrata tra quelle verificate.

## Pro e contro delle opzioni

### Elenco dei codici verificati

* Positivo, perché tiene conto anche della configurazione del sito.
* Negativo, perché aggiunge circa 1,5 KB a ogni istantanea.

### Versione del set di regole

* Positivo, perché l'istantanea resta minima.
* Negativo, perché non rappresenta le regole disattivate e richiede di mantenere lo storico delle versioni.

### Nessuna gestione

* Positivo, perché non costa nulla.
* Negativo, perché il primo confronto dopo ogni cambio di regole è inutilizzabile e rompe la CI.
