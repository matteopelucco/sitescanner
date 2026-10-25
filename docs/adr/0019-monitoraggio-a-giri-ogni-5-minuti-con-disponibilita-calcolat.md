---
status: proposed
date: 2026-10-25
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Monitoraggio a giri ogni 5 minuti, con disponibilità calcolata dal tempo coperto dai controlli

## Contesto e problema

Il monitoraggio della disponibilità ([§12](../specs/12-monitoraggio.md)) deve girare sempre, su Vercel, senza un processo attivo. Deve anche dare KPI (disponibilità, downtime, MTTR, MTBF, budget di errore) che non mentano quando il monitor stesso si ferma, viene messo in pausa o è in manutenzione. Infine gli stessi KPI devono uscire uguali dai dati grezzi (conservati 30 giorni) e dagli aggregati (conservati per anni) (RF-KPI-07). Le decisioni prese con l'utente il 2026-10-25 sono in §12.11: intervallo minimo di 5 minuti, solo su Vercel, dead man's switch esterno, protezione dai falsi down di massa.

## Fattori decisionali

* Nessun processo sempre attivo: Vercel offre Cron e Function.
* KPI onesti: un periodo senza controlli non è «su».
* Stesso risultato da dati grezzi e da aggregati.
* Stesso motore in locale (sviluppo) e su Vercel, con gli stessi test.

## Opzioni considerate

* Disponibilità dal **tempo coperto**: ogni controllo garantisce un intervallo di controllo; il tempo monitorato è l'unione di questi intervalli meno la manutenzione, e il downtime è la parte degli incidenti che vi cade dentro. Giri a ogni Cron di 5 minuti.
* Disponibilità come **rapporto tra controlli riusciti e controlli totali**.
* Un **processo sempre attivo** (worker esterno) con controlli continui.

## Esito della decisione

Opzione scelta (proposta, da confermare): «tempo coperto», perché pause, giri mancati e giri scartati come non affidabili diventano semplicemente buchi, che non contano né come su né come giù. Inoltre, essendo fatto di intervalli, si somma per ore e giorni senza perdere precisione.

Dettagli:

* `src/core/uptime.js` è puro: aritmetica degli intervalli, copertura, KPI, aggregati, salute, finestre di manutenzione con fuso orario (Intl, senza librerie), soglie degli status attesi. Gli aggregati orari salvano tempo monitorato e downtime, quindi la somma su ore intere coincide esattamente con il calcolo dai dati grezzi. I KPI di un periodo usano gli aggregati delle ore già aggregate e i dati grezzi per il resto.
* Tempi di risposta: media esatta (somma e conteggio); mediana e p95 da un istogramma a fasce fisse, sommabile, quindi approssimati dopo l'ora corrente.
* Aggregati giornalieri su giorni UTC.
* Giro (`runRound`): monitor in scadenza di tutte le aree, lock per monitor (Postgres: `locked_until`), al massimo 20 controlli in parallelo e 2 per host, ritardo fisso per monitor (0–60 s), ripetizione dopo 10 s prima del down. Se falliscono per rete almeno metà dei controlli (e almeno 5) e anche gli URL di riferimento, il giro è scartato e l'admin riceve un evento.
* Il giro ha un budget di tempo (`SITESCANNER_MON_BUDGET_MS`, 4 minuti): i monitor non controllati restano in scadenza e passano al giro successivo, a partire dai più vecchi. La distribuzione su Vercel Queues, prevista da RF-MON-17 se un giro non basta, è rimandata finché i numeri non la richiedono.
* Il prossimo controllo di un monitor è previsto un minuto prima della scadenza esatta, così un monitor a 5 minuti rientra in ogni giro anche se il Cron parte con qualche secondo di ritardo.
* Gli eventi da notificare (giù, su, certificato, lento, rete non affidabile) vanno in una coda per area (`mon_events` / `events.json`), che le notifiche consumano.
* Due store con la stessa interfaccia: file in `<area>/monitoring/` (solo sviluppo) e Postgres (migrazione 3).

### Conseguenze

* Positivo, perché i KPI non premiano i periodi senza dati e mostrano la copertura.
* Positivo, perché grezzi e aggregati coincidono per costruzione: lo verifica un test con buchi, pause, manutenzione e incidenti a cavallo delle ore e dei giorni.
* Negativo, perché la risoluzione è di 5 minuti: un down di 2 minuti tra due controlli non si vede. Il controllo ogni minuto è rimandato (§12.10).
* Negativo, perché un solo punto di osservazione (la regione delle Function): un problema di rete tra Vercel e un singolo server non si distingue da un down vero.
* Negativo, perché il p95 sui periodi lunghi è approssimato alla fascia dell'istogramma.

### Verifica

`test/uptime.test.js` (KPI da grezzi = da aggregati, manutenzione con ora legale, salute), `test/monitor.test.js` (ciclo su → giù → su, ripetizione, manutenzione, falsi down di massa, certificato, sui due store), `test/monitor-api.test.js` (API e isolamento).

## Pro e contro delle opzioni

### Tempo coperto

* Positivo, perché onesto e sommabile.
* Negativo, perché un po' più di calcolo (intervalli invece di contatori).

### Rapporto tra controlli

* Positivo, perché banale.
* Negativo, perché un giro mancato non pesa, cambiare intervallo cambia il peso dei controlli, e il downtime in minuti non si ricava.

### Processo sempre attivo

* Positivo, perché frequenza libera.
* Negativo, perché un'infrastruttura fuori da Vercel, contro la scelta dell'utente.
