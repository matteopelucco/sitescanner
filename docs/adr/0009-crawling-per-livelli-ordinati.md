---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Crawling in ampiezza per livelli ordinati, per ottenere scan deterministiche

## Contesto e problema

Con richieste parallele, l'ordine in cui le pagine vengono scoperte dipende dai tempi di risposta. Quando il limite `maxPages` tronca il crawling, due scan dello stesso sito invariato potrebbero quindi visitare insiemi di pagine diversi, generando false differenze «pagina rimossa/aggiunta» nel confronto.

## Fattori decisionali

* A sito invariato, due scan devono visitare le stesse pagine (requisito RNF-07).
* Mantenere la concorrenza per la velocità.
* Privilegiare le pagine più vicine alla home quando si tronca.

## Opzioni considerate

* Crawling per livelli di profondità: si visita tutto il livello N (chiavi in ordine alfabetico, in parallelo) prima di passare al livello N+1.
* Coda unica FIFO con worker paralleli.
* Crawling sequenziale (concorrenza 1).

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "crawling per livelli ordinati", perché l'insieme visitato dipende solo dalla struttura dei link e non dai tempi, e le pagine meno profonde hanno la precedenza.

### Conseguenze

* Positivo, perché il troncamento è riproducibile e le scan sono confrontabili anche con `maxPages` basso.
* Positivo, perché le pagine vicine alla home, di solito le più importanti, sono sempre incluse.
* Negativo, perché alla fine di ogni livello si attende la pagina più lenta prima di proseguire: con un livello piccolo e una pagina lenta il parallelismo è sfruttato poco.
* Negativo, perché la profondità registrata è quella del primo livello in cui la pagina è stata scoperta, non necessariamente il percorso più «naturale».
* Neutro, perché il determinismo vale a sito invariato: se cambiano i link, cambia legittimamente anche l'insieme visitato.

## Pro e contro delle opzioni

### Livelli ordinati

* Positivo, perché deterministico e con priorità alle pagine meno profonde.
* Negativo, perché sincronizzazione a fine livello.

### Coda FIFO parallela

* Positivo, perché massimo sfruttamento dei worker.
* Negativo, perché non deterministica sotto troncamento.

### Sequenziale

* Positivo, perché deterministico.
* Negativo, perché lento sui siti grandi.

## Ulteriori informazioni

Le scan troncate sono marcate (`crawl.truncated`, `crawl.unvisited`) e il report lo segnala, perché le pagine oltre il limite appaiono come rimosse o aggiunte.
