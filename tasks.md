# Task

Elenco progressivo dei task di sitescanner. L'utente aggiunge i task in fondo a **Da fare**; i loop agentici li eseguono **uno alla volta**, nell'ordine, e aggiornano questo file a ogni iterazione.

## Protocollo per i loop agentici

A ogni iterazione:

1. Leggi questo file. Se c'è un task in **In corso**, riprendi quello; altrimenti sposta in **In corso** il primo task di **Da fare**. Se entrambe le sezioni sono vuote, fermati: non c'è niente da fare.
2. Lavora solo su quel task. Non iniziarne altri e non riordinare la lista.
3. Prima di chiudere l'iterazione aggiorna il file:
   - avanzamento: spunta i sotto-punti completati (`- [x]`) e aggiungi una riga `> nota:` con lo stato, i problemi o le decisioni prese;
   - task completato (codice, test verdi con `npm test`, specifiche/README/ADR aggiornati se servono): spostalo in **Fatto** con la data (`YYYY-MM-DD`) e un riepilogo di una riga;
   - task bloccato (decisione che spetta all'utente, errore che non sai risolvere): lascialo in **In corso**, marcalo `**BLOCCATO:**` con la domanda precisa e fermati.
4. Non fare commit né push, a meno che il task non lo chieda esplicitamente.

Formato di un task:

```md
- [ ] **Titolo breve**: descrizione di cosa serve e del criterio di completamento.
  - [ ] sotto-punto (facoltativo, lo può aggiungere anche il loop)
```

## In corso

## Da fare

<!-- Aggiungi qui i nuovi task, uno per voce, in fondo alla lista. -->

## Fatto

- 2026-10-24 — **BUG: eliminando un sito restano le sue scan**: «Elimina sito…» apre una finestra con scelta esplicita (nessuna preselezione) tra tenere lo storico o cancellarlo, con il numero di scan; i siti «solo storico» hanno «Elimina storico…». API `DELETE /api/sites/<id>?history=keep|delete` (409 con job in corso), `deleteSiteData` sblocca i file di sola lettura, report rigenerato ripulendo i dati dei siti spariti. Test in `test/web.test.js` (fixture con ritardo per il job in corso); specifiche RF-WEB-07, §8.4, RF-DATA-13. Nota: un fallimento a livello di file di `test/web.test.js` visto una volta durante verifiche parallele con Chromium, non riprodotto in 17 esecuzioni successive.
- 2026-10-24 — **Export PDF dei report**: documento di stampa A4 condiviso (`src/core/print.js`, CSS paged media: copertina con esito e health score, sommario, intestazioni, «Pagina N di M», sezioni e tabelle che non si spezzano) per report di qualità (sola Base) e di regressione (Base + Head); PDF con Chromium da CLI (`sitescanner pdf`), web app (`GET /api/pdf`, link «PDF») e pulsante «PDF» nel report (fallback alla stampa del browser da file/bundle); `SITESCANNER_CHROMIUM` per un Chrome già installato. Test `test/print.test.js` + e2e/web; specifiche §3.11, §7.8, §8; ADR-0015.
- 2026-10-24 — **Potenziare i dati di qualità (livello professionale)**: ricerca comparativa (Screaming Frog, Semrush, Ahrefs, Sitebulb, Lighthouse, ContentKing) e gap analysis in `docs/research/controlli-di-qualita.md`; implementate tutte le voci P1 (da 23 a 74 issue in 15 categorie: indicizzabilità con X-Robots-Tag, canonical, link e profondità di click, sitemap/orfane, contenuti duplicati/thin/lorem ipsum/soft 404, JSON-LD, hreflang, redirect, sicurezza, a11y, HTML/URL), health score, configurazione `quality` (disable/severity/soglie, anche dal form web), nuove differenze `indexability-changed` e `structured-data-changed`, regole non attive in Base declassate a info (ADR-0014). Report: categorie, indicizzabilità, health score. Test `test/analyze.test.js` + compare/web; specifiche §2, §4.4, §4.6, §6, §7. Le voci P2 (risorse esterne rotte, quasi duplicati, Core Web Vitals, HTML renderizzato, schema.org, leggibilità) restano proposte per task futuri.
- 2026-10-24 — **Report: vista diagnostica di una singola scan**: Head vuota → diagnostica di Base (esito, crawl, contatori, issue per codice con pagine, pagine filtrabili, dettaglio con link entranti/uscenti e testo); stato nell'URL; logica pura in `src/core/diagnose.js` (test `test/diagnose.test.js`); `export` senza `--head`; link «Diagnostica» nella web app; specifiche §7.7, ADR-0006 esteso. Corretto anche `npm test` su Node ≥ 22 (`node --test` senza argomenti).
- 2026-10-23 — **Web app + inventario del sito**: `sitescanner ui` (siti con form/YAML, scan e inventari come job con avanzamento SSE e annullamento, storico con label), comando `inventory`, test in `test/web.test.js`, specifiche §8–§9 e ADR 0011–0013.
- 2026-10-22 — **sitescanner 0.1.0**: scansioni as-is, storico, confronto Base/Head e report di regressione (commit `9a26a56`).
