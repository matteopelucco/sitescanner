---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Label e note modificabili in un file overlay separato dalle istantanee

## Contesto e problema

Il comando `label` deve poter assegnare o cambiare label e nota di una scan dopo la sua esecuzione (es. etichettare come `release-2.3` una scan fatta prima di sapere che sarebbe stata quella di riferimento). Le istantanee però sono immutabili ([ADR-0002](0002-storico-su-filesystem-con-istantanee-immutabili.md)).

## Fattori decisionali

* Non violare l'immutabilità delle istantanee.
* Label e nota correnti devono essere visibili ovunque (CLI, risoluzione dei riferimenti, report).
* Scritture sicure anche se interrotte.

## Opzioni considerate

* File `data/<sito>/labels.json` con i valori correnti, che prevalgono su quelli dell'istantanea.
* Riscrivere `label`/`note` dentro `scan.json`.
* Log append-only di eventi di etichettatura.

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "file `labels.json` per sito", perché lascia intatte le istantanee con una sola regola di lettura: il valore in `labels.json`, se presente, prevale su quello salvato nella scan. La scrittura avviene su file temporaneo poi rinominato.

### Conseguenze

* Positivo, perché l'istantanea conserva la label originale data al momento della scan.
* Positivo, perché tutti i punti di lettura (`listScans`, `loadScan`) applicano l'overlay in un solo posto.
* Negativo, perché la storia delle modifiche alle label non è conservata (solo l'ultimo valore e `updatedAt`).
* Negativo, perché copiare una cartella di scan senza `labels.json` fa perdere le label modificate.
* Negativo, perché i dati di scan in cache nel report contengono la label originale: il report deve prendere label e nota dall'indice, rigenerato a ogni `report`.

### Verifica

Il test e2e esegue `label` e verifica che `list` mostri la nuova label e che `scan.json` contenga ancora quella originale.

## Pro e contro delle opzioni

### Overlay `labels.json`

* Positivo, perché semplice e rispetta l'immutabilità.
* Negativo, perché i dati di una scan sono divisi in due posti.

### Riscrivere `scan.json`

* Negativo, perché contraddice l'immutabilità e richiede di togliere e rimettere la sola lettura.

### Log append-only

* Positivo, perché conserva la storia delle modifiche.
* Negativo, perché più complesso da leggere per un beneficio non richiesto oggi.
