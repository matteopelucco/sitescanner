---
status: accepted
date: 2026-10-26
decision-makers: Pelucco Matteo
---

# Mappa del sito come vista dell'inventario esteso

## Contesto e problema

Un microsito generato con Gemini per `corner.ch` ([analisi](../research/mappa-architetturale-gemini.md)) mostra l'architettura di un sito con un grafo interattivo, un albero gerarchico, un catalogo e statistiche di composizione. Serve lo stesso tipo di report in sitescanner, ma generato da un crawl e riproducibile. Il microsito unisce in una sola mappa l'host principale e alcuni sottodomini, raggruppa le pagine in aree tematiche scelte a mano e contiene testo interpretativo (note tecniche, introduzione). Bisogna decidere da quale dato nasce la mappa, come trattare i sottodomini, come assegnare le aree e cosa fare del testo interpretativo.

## Fattori decisionali

* Dati misurati e riproducibili, non numeri scritti a mano.
* Siti grandi (migliaia di pagine) senza appesantire le scan di regressione.
* Crawl prevedibile: il numero di pagine non deve esplodere seguendo i sottodomini.
* Poco lavoro di configurazione per avere una mappa utile, ma possibilità di correggerla.
* Nessuna dipendenza esterna né invio di dati a terzi ([ADR-0001](0001-node-js-esm-senza-build-e-dipendenze-minime.md)).

## Opzioni considerate

Base dei dati:
* estendere l'inventario ([§9](../specs/09-inventario.md));
* nuova scheda del report di una scan;
* entrambi, con lo stesso modulo di analisi.

Sottodomini:
* host aggiuntivi elencati in configurazione ed esplorati;
* tutti i sottodomini del dominio, esplorati;
* pagine dei sottodomini linkate dal sito visitate a un livello, senza esplorarle.

Aree tematiche:
* automatiche (dalle sezioni) con regole di correzione;
* solo regole manuali;
* proposte da un LLM e confermate dall'utente.

Testo interpretativo:
* note scritte a mano;
* insight generati da un LLM;
* nessun testo, solo dati.

## Esito della decisione

Opzioni scelte da Pelucco Matteo il 2026-10-26:

1. **Inventario esteso.** L'inventario ha già scopo (misurare la struttura) e limiti (5000 URL) adatti; si aggiungono H1, description, parole, link classificati per regione, documenti e domini esterni, senza salvare testo né HTML. La mappa è una vista dell'inventario e ne eredita l'assenza di storico e di confronto ([ADR-0013](0013-inventario-del-sito-come-crawl-separato-dalle-scan-senza-sto.md)).
2. **Sottodomini a un livello.** Le pagine degli host fratelli (stesso dominio del sito) linkate o raggiunte con un redirect dall'host principale vengono visitate come «pagine di confine», ma i loro link non vengono seguiti. La mappa ha i bordi completi e il crawl resta limitato.
3. **Aree automatiche con regole.** Un'area per ogni hub di primo livello, con il nome breve della sua pagina; regole in configurazione (prefisso o regex → area) per raggruppare e rinominare.
4. **Note scritte a mano.** La mappa mostra solo dati misurati; il contesto (tecnologie, flussi con gate, motivazioni) si scrive in note per l'inventario e per pagina, incluse negli export.

Il dettaglio è in [§14](../specs/14-mappa-del-sito.md). Lo stesso giorno sono state confermate le scelte tecniche (§14.12):

* **Regioni dei link**: landmark HTML/ARIA, con il rilevamento del modello (link su almeno l'80% delle pagine) come ripiego.
* **Albero**: il genitore è l'antenato di path; le pagine di confine prendono il posto del redirect o si agganciano alla pagina che le linka.
* **SPA**: rendering con il browser solo delle pagine che sembrano vuote, al massimo 50.
* **Documenti**: elencati senza scaricarli; richiesta `HEAD` facoltativa.
* **Grafo**: canvas con d3-force e d3-hierarchy per le posizioni, file inclusi nel repository ([ADR-0021](0021-librerie-d3-force-e-d3-hierarchy-incluse-nel-repository-per.md)).
* **CSV**: due file separati, quello dell'inventario resta invariato.

### Conseguenze

* Positivo, perché la mappa si ottiene da un solo inventario, anche su un URL non configurato, e ogni numero è ricalcolabile.
* Positivo, perché cambiare aree e genitori non richiede un nuovo crawl: la mappa si ricalcola dai record con un modulo puro condiviso tra browser, server ed export.
* Positivo, perché le scan di regressione restano invariate.
* Negativo, perché la mappa non si confronta nel tempo né si collega allo storico delle scan; per vedere come cambia l'architettura bisogna aprire due inventari.
* Negativo, perché i sottodomini sono mappati solo nelle pagine linkate: un microsito con molte pagine interne richiede un suo inventario.
* Negativo, perché le aree automatiche seguono la struttura degli URL: siti con URL piatti o poco parlanti richiedono regole per avere aree significative.
* Negativo, perché il testo interpretativo dipende da chi scrive le note: senza note il report è meno ricco di quello di Gemini.

### Verifica

Test del modulo `src/core/sitemap.js` su un dataset modellato su corner.ch (aree automatiche, regole, aggancio delle pagine di confine); test dell'inventario sulla fixture con un secondo host per verificare che i link delle pagine di confine non vengano seguiti.

## Pro e contro delle opzioni

### Inventario esteso
* Positivo, perché ha limiti alti e funziona su URL liberi.
* Negativo, perché non ha storico.

### Scheda del report di una scan
* Positivo, perché ha già dati ricchi e lo storico.
* Negativo, perché ha limiti bassi e il crawl è appesantito da screenshot e testo.

### Entrambi
* Positivo, perché la mappa sarebbe disponibile ovunque.
* Negativo, perché raddoppia superficie, test e casi limite.

### Sottodomini esplorati (elenco o tutti)
* Positivo, perché mappano a fondo i micrositi.
* Negativo, perché il numero di pagine diventa imprevedibile (login, CDN, app) e serve più configurazione.

### Aree solo manuali
* Positivo, perché il controllo è massimo.
* Negativo, perché senza regole la mappa non ha aree leggibili.

### Aree o note da LLM
* Positivo, perché il risultato è più vicino a quello di Gemini con meno lavoro.
* Negativo, perché servono chiave API e costi, i dati vanno a terzi e il testo va verificato. Resta un'evoluzione possibile, con una sua ADR.
