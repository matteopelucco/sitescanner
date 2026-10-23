---
status: proposed
date: 2026-10-23
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Inventario del sito come crawl separato dalle scan, senza storico né confronto

## Contesto e problema

Prima di configurare un sito, o per dimensionarlo, serve sapere quanto è grande e com'è strutturato: numero di pagine, profondità di click dalla home, profondità degli URL, sezioni, pagine presenti solo in sitemap. Le scan esistenti raccolgono già i link, ma sono pensate per il regression test: hanno limiti bassi (`maxPages` 200), salvano testo e screenshot, finiscono nello storico e nel report di confronto.

## Fattori decisionali

* Poter misurare siti grandi (migliaia di URL) in tempi ragionevoli.
* Poterlo fare su un URL qualsiasi, senza creare una configurazione.
* Non inquinare lo storico delle scan e il report di regressione.
* Riutilizzare il crawler esistente, senza un secondo motore.

## Opzioni considerate

* Un comando e un job separati (`inventory`) che riusano il crawler con limiti più alti, non salvano testo né screenshot e scrivono in `inventory/<id>.json`.
* Calcolare le stesse metriche dentro ogni scan e mostrarle nel report.
* Una scan con un flag speciale, salvata nello storico ma esclusa dal confronto.

## Esito della decisione

Opzione scelta (implementata, da confermare): "inventario separato", perché ha uno scopo diverso dalla scan (misurare, non confrontare) e limiti diversi.

Dettagli:

* Default `maxPages` 5000 e `maxDepth` 50, senza screenshot e senza testo. Con un sito configurato valgono le sue regole (perimetro, include/exclude, robots.txt, auth, sitemap); con `--url` si usano i default.
* La profondità di click è calcolata a posteriori con una BFS sul grafo dei link interni (e dei redirect) a partire dalle pagine di `start`. Le pagine raggiunte solo tramite la sitemap risultano «non collegate», invece che a profondità 1 come nel crawler.
* `inventory/<id>.json` contiene riepilogo, albero dei path e un record per URL; `<id>.meta.json` solo il riepilogo, per gli elenchi. Esportabile in CSV.
* Gli inventari non hanno label né confronto e non entrano nel report.

### Conseguenze

* Positivo, perché lo storico delle scan resta pulito e il report di regressione non cambia.
* Positivo, perché un inventario è possibile prima ancora di configurare il sito.
* Negativo, perché due crawl dello stesso sito (scan e inventario) non condividono dati: le metriche di struttura non sono disponibili per le scan passate.
* Negativo, perché non c'è un confronto tra inventari nel tempo; se servirà, andrà progettato a parte.

### Verifica

`test/web.test.js`: test unitario di `analyzeInventory` (BFS, orfane, sitemap, sezioni, albero) e inventario via API sul sito di fixture.

## Pro e contro delle opzioni

### Inventario separato

* Positivo, perché ha limiti e output adatti allo scopo.
* Negativo, perché è un concetto in più da spiegare.

### Metriche dentro ogni scan

* Positivo, perché le metriche si avrebbero nel tempo, gratis.
* Negativo, perché i limiti bassi delle scan danno misure troncate, e non funziona su URL non configurati.

### Scan con flag speciale

* Positivo, perché c'è un solo tipo di dato.
* Negativo, perché complica storico, riferimenti (`latest`) e report con eccezioni.
