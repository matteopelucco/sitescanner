---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Storico su filesystem con istantanee immutabili, scritte in staging e rese di sola lettura

## Contesto e problema

Ogni scan deve essere un'istantanea as-is del sito, confrontabile in futuro con qualsiasi altra. Se un'istantanea venisse modificata, o salvata a metà, i confronti successivi non sarebbero più affidabili. Bisognava scegliere dove e come conservare lo storico: dati strutturati (pagine, issue), testo e immagini PNG potenzialmente pesanti.

## Fattori decisionali

* Affidabilità: un'istantanea non deve cambiare dopo la creazione e non devono esistere scan parziali.
* Il report statico deve poter leggere le istantanee (e referenziare gli screenshot) senza un server.
* Lo storico deve essere facile da copiare, archiviare, versionare o cancellare.
* Un'istantanea deve restare interpretabile anche se la configurazione del sito cambia.

## Opzioni considerate

* Una cartella per scan con `scan.json` + file accessori, scritta in staging e resa di sola lettura.
* Database SQLite unico, con immagini su disco.
* File JSON/JSONL di storico per sito, aggiornato a ogni scan.

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "una cartella per scan", perché è il formato più semplice da leggere sia per la CLI sia per il report, e permette una scrittura atomica.

Dettagli:

* `data/<sito>/scans/<scanId>/` contiene `scan.json`, `text.json`, `screenshots/`, `html/`.
* La scan viene scritta in `.<scanId>.partial`; a scan completata i file sono resi di sola lettura (0444) e la cartella è rinominata. In caso di errore o Ctrl+C la cartella temporanea viene eliminata.
* `scan.json` include versione dello schema, versione del tool, opzioni effettive e una copia della configurazione con credenziali mascherate (`***`) e il suo hash.
* L'id (`AAAAMMGGTHHMMSSZ-xxxx`) è ordinabile cronologicamente.

### Conseguenze

* Positivo, perché le scan si copiano, archiviano o cancellano con normali operazioni sui file.
* Positivo, perché una scan interrotta non appare mai nello storico.
* Positivo, perché la sola lettura impedisce modifiche accidentali e rende sicura la cache dei dati nel report.
* Negativo, perché `list` e `report` leggono ogni `scan.json`: con migliaia di scan o scan molto grandi diventano più lenti (nessun indice).
* Negativo, perché la sola lettura è una protezione, non una garanzia: chi ha accesso al disco può ancora modificare o cancellare i file (non c'è firma né checksum).
* Negativo, perché non è previsto un comando per eliminare le scan vecchie: oggi si cancella la cartella a mano.
* Neutro, perché le modifiche a label e note richiedono un meccanismo separato ([ADR-0003](0003-label-e-note-in-overlay-mutabile.md)).

### Verifica

Il test e2e controlla che `scan.json` non sia scrivibile e che le cartelle che iniziano con `.` non vengano elencate come scan.

## Pro e contro delle opzioni

### Una cartella per scan

* Positivo, perché leggibile da qualsiasi strumento e referenziabile dal report via path relativi.
* Positivo, perché la rinomina della cartella rende la scrittura atomica.
* Negativo, perché nessuna interrogazione trasversale tra scan senza leggerle tutte.

### SQLite

* Positivo, perché interrogazioni e indici sullo storico.
* Negativo, perché il report statico non può leggerlo senza un passo di esportazione o una libreria WASM.
* Negativo, perché l'immutabilità andrebbe imposta dal codice, non dal filesystem.

### Storico in un unico file per sito

* Negativo, perché ogni scan riscrive il file: un errore a metà scrittura può corrompere tutto lo storico.

## Ulteriori informazioni

Rivedere se il numero di scan per sito rende lenti `list` e `report`: un indice derivato (rigenerabile) per sito risolverebbe senza toccare le istantanee. Valutare un comando di pulizia (`prune`) e un checksum per scan.
