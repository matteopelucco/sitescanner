# 9. Inventario

Un inventario misura dimensione, struttura e profondità di un sito. Usa il crawler delle scan ([§4.1](04-scansione.md#41-perimetro-del-crawling)) ma è un oggetto separato: non entra nello storico, nel confronto né nel report ([ADR-0013](../adr/0013-inventario-del-sito-come-crawl-separato-dalle-scan-senza-sto.md)). Si avvia da CLI ([§3.8](03-cli.md#38-inventory)) o dalla web app ([§8](08-web-app.md)). La mappa del sito ([§14](14-mappa-del-sito.md), da implementare) estende la raccolta dei dati e aggiunge le viste di architettura.

## 9.1 Esecuzione

| ID | Requisito |
|---|---|
| RF-INV-01 | Sorgente: un **sito configurato** con un ambiente (valgono perimetro, include/exclude, robots.txt, auth, header e sitemap del sito) oppure un **URL qualsiasi** (http/https, configurazione di default). |
| RF-INV-02 | Limiti di default più alti delle scan: `maxPages` 5000, `maxDepth` 50; si possono cambiare insieme a `concurrency`. Niente screenshot, testo né HTML. |
| RF-INV-03 | Se non viene trovata nessuna pagina, o nessuna è raggiungibile, l'inventario non viene salvato e l'errore è riportato. |
| RF-INV-04 | Se il limite di URL viene raggiunto, l'inventario è marcato come troncato e riporta il numero di URL scoperti e non visitati. |

## 9.2 Metriche

| ID | Requisito |
|---|---|
| RF-INV-10 | Per ogni URL visitato: chiave, status (ed eventuale destinazione del redirect o errore), content type, se è una pagina HTML valida (2xx, HTML, senza redirect), title, peso, tempo di risposta, profondità di click, profondità URL, sezione, link entranti e uscenti, chi linka la pagina (RF-INV-17), presenza nella sitemap. |
| RF-INV-11 | **Profondità di click**: distanza minima, in link interni, dalle pagine di `start`. I redirect contano come un link verso la destinazione. Una pagina raggiunta solo tramite la sitemap (o non raggiungibile con i link) non ha profondità ed è **non collegata**. *(test/web.test.js)* |
| RF-INV-12 | **Profondità URL**: numero di segmenti del path (`/a/b/c` = 3; la query non conta). **Sezione**: primo segmento del path (`/` per la home). |
| RF-INV-13 | Riepilogo: URL visitati, pagine HTML, conteggio per classe di status (2xx, 3xx, 4xx, 5xx, errori di rete), content type, peso HTML totale, tempo di risposta medio; profondità di click massima, media e istogramma; profondità URL massima e istogramma; pagine non collegate. |
| RF-INV-14 | Per sezione: pagine, pagine collegate, profondità di click media e massima, profondità URL massima. |
| RF-INV-15 | Sitemap: URL elencati, quanti visitati, pagine solo in sitemap (non collegate), pagine collegate assenti dalla sitemap. Più il numero di link interni verso URL non visitati (esclusi o oltre i limiti). |
| RF-INV-16 | Albero dei path delle pagine HTML, con il numero di pagine per ramo. Le 20 pagine con più link entranti e le 20 più profonde. |
| RF-INV-17 | **Da dove arriva una pagina**: ogni URL riporta `linkedFrom`, l'elenco ordinato delle pagine che lo linkano (link interni; una pagina raggiunta con un redirect è linkata dalla pagina che reindirizza). `inlinks` resta il conteggio completo; l'elenco è limitato a 20 chiavi, a 200 per le pagine che non si caricano (errore di rete, 4xx, 5xx), che sono il motivo per cui lo si consulta. Una pagina trovata solo da sitemap o URL di partenza ha l'elenco vuoto. L'export CSV ha la colonna `linkedFrom` (chiavi separate da ` \| `). Nella web app le pagine che non si caricano mostrano subito le prime tre pagine che le linkano; il numero di link entranti apre l'elenco di ogni pagina. Le pagine di un host fratello ([§14.2.2](14-mappa-del-sito.md)) portano l'etichetta «host fratello» con il dominio, il link della riga punta al loro host e c'è il filtro «Host fratelli». *(test/web.test.js)* |

## 9.3 Dati e visualizzazione

| ID | Requisito |
|---|---|
| RF-INV-20 | Ogni inventario è salvato in `inventory/<id>.json` (completo) e `inventory/<id>.meta.json` (solo riepilogo, per gli elenchi), con scrittura atomica. L'id ha lo stesso formato degli id di scan. |
| RF-INV-21 | L'export CSV ha una riga per URL con i campi di RF-INV-10. *(test/web.test.js)* |
| RF-INV-22 | La web app elenca gli inventari dal più recente e mostra per ciascuno: indicatori principali, distribuzione degli status, istogrammi di profondità di click e URL, sezioni, albero navigabile, dati della sitemap, pagine più collegate e più profonde, e la tabella degli URL filtrabile (testo, HTML, non collegate, assenti dalla sitemap, errori, redirect) e ordinabile. |
| RF-INV-23 | Un inventario si può eliminare dalla web app. |
