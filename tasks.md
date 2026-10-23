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

- [ ] **Report: vista diagnostica di una singola scan**: oltre al confronto tra due scan, il report deve mostrare i dettagli di una scan sola. Se l'utente seleziona solo la scan «Base» (Head vuota), la schermata è una diagnostica della scan: errori, SEO, info (issue di qualità per severità e per codice, pagine coinvolte, dettaglio pagina). Se seleziona anche «Head», si vedono le regressioni come ora.
  - criterio di completamento: nel report si può lasciare Head vuota; con la sola Base si vede la diagnostica, con Base + Head il confronto attuale invariato; lo stato è nell'URL (link condivisibili); specifiche `07-report.md` aggiornate.
- [ ] **Potenziare i dati di qualità (livello professionale)**: documentarsi online su cosa rilevano i principali scanner/crawler SEO e di qualità (es. Screaming Frog, Sitebulb, Ahrefs Site Audit, Semrush Site Audit, Lighthouse, ContentKing) e implementare le funzionalità più utili, in modo che sitescanner diventi uno strumento professionale, per cui valga la pena pagare.
  - [ ] ricerca: tabella comparativa dei controlli offerti dagli strumenti di riferimento, con fonti, salvata in `docs/research/` (o simile)
  - [ ] gap analysis rispetto alle issue attuali (§4.4 delle specifiche) e proposta prioritizzata (valore per l'utente / costo), da riportare qui come sotto-punti prima di implementare
  - [ ] implementazione delle voci a priorità più alta: nuove issue in `src/analyze.js`, dati per pagina, eventuali nuove differenze in `src/core/compare.js`, visualizzazione nel report
  - [ ] test, specifiche (`04-scansione.md`, `06-confronto.md`), README e ADR per le scelte rilevanti
  > nota: task ampio; il loop può suddividerlo in più iterazioni, ma la proposta prioritizzata va scritta prima di iniziare a implementare.
- [ ] **Export PDF dei report**: esportare in PDF sia il report di una singola scan (solo Base, la vista diagnostica) sia il report di confronto (Base + Head). PDF di alta qualità: impaginazione curata (copertina/intestazione con sito, ambienti, date e label, sommario, sezioni che non si spezzano male, numeri di pagina), layout pulito e leggibile in stampa.
  - criterio di completamento: export disponibile dal report/web app (ed eventualmente da CLI), entrambi i tipi di report generano un PDF ben impaginato; test e specifiche (`07-report.md`) aggiornati.
  > nota: dipende dal task «Report: vista diagnostica di una singola scan» per il PDF della sola Base.
- [ ] **BUG: eliminando un sito restano le sue scan**: oggi «Elimina configurazione» rimuove solo `sites/<id>.yml` e lo storico in `data/<id>/` resta (il sito rimane come «solo storico» e non c'è modo di toglierlo). L'eliminazione deve chiedere se **tenere** o **cancellare** anche le scan (storico, screenshot, label) e, nel secondo caso, cancellarle davvero.
  - criterio di completamento: alla cancellazione la web app chiede esplicitamente cosa fare dello storico (con il numero di scan coinvolte); scegliendo «cancella», `data/<id>/` viene rimosso (anche i file resi di sola lettura) e il sito sparisce da web app e report (report rigenerato); scegliendo «tieni», comportamento attuale. Deve essere possibile cancellare anche lo storico di un sito «solo storico». Rifiutare se c'è un job in corso sul sito. Test, specifiche (`08-web-app.md` RF-WEB-07, `05-storico-e-dati.md`) aggiornati.

## Fatto

- 2026-10-23 — **Web app + inventario del sito**: `sitescanner ui` (siti con form/YAML, scan e inventari come job con avanzamento SSE e annullamento, storico con label), comando `inventory`, test in `test/web.test.js`, specifiche §8–§9 e ADR 0011–0013.
- 2026-10-22 — **sitescanner 0.1.0**: scansioni as-is, storico, confronto Base/Head e report di regressione (commit `9a26a56`).
