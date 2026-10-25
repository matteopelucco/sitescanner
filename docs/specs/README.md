# Specifiche funzionali — sitescanner

Versione di riferimento: **0.1.0**

| # | Documento | Contenuto |
|---|---|---|
| 1 | [Panoramica](01-panoramica.md) | Obiettivo, glossario, perimetro, requisiti non funzionali |
| 2 | [Configurazione dei siti](02-configurazione.md) | File `sites/<id>.yml`, ambienti, opzioni |
| 3 | [Comandi CLI](03-cli.md) | Sintassi, comportamento, output ed exit code di ogni comando |
| 4 | [Scansione](04-scansione.md) | Crawling, dati raccolti per pagina, screenshot, issue di qualità |
| 5 | [Storico e dati](05-storico-e-dati.md) | Istantanee immutabili, label, riferimenti alle scan |
| 6 | [Confronto Base/Head](06-confronto.md) | Abbinamento pagine, redirect map, tipi di differenza e severità |
| 7 | [Report HTML](07-report.md) | Report statico, diagnostica di una scan, confronto, export PDF |
| 8 | [Web app](08-web-app.md) | `sitescanner ui`: siti, scan con avanzamento, job, API locale e sua sicurezza |
| 9 | [Inventario](09-inventario.md) | Misura di dimensione, struttura e profondità di un sito |
| 10 | [Utenti e accesso protetto](10-utenti-e-accesso.md) | Modalità mono/multi-utente, login e sessioni, aree private, gestione degli utenti, sicurezza |
| 11 | [Esecuzione su Vercel](11-vercel.md) | Deploy, storage Postgres + Blob, job a passi, browser headless, limiti *(in parte implementato)* |
| 12 | [Monitoraggio della disponibilità](12-monitoraggio.md) | Healthcheck dei siti, incidenti, notifiche email/Slack/Telegram, KPI e salute |
| 13 | [Monitoraggio: evoluzione (v2)](13-monitoraggio-v2.md) | Esiti e soglie, asserzioni e API, fasi della richiesta, heartbeat/DNS/TCP/SSL, località, politica di allerta, team, segreti, status page, report, monitoring as code *(da implementare)* |

## Convenzioni

- Ogni requisito ha un identificativo stabile (`RF-<AREA>-NN` funzionale, `RNF-NN` non funzionale), da citare in issue, PR e test.
- **DEVE** indica un comportamento obbligatorio; **PUÒ** un comportamento opzionale o configurabile.
- Le motivazioni delle scelte architetturali sono nelle [ADR](../adr/README.md); qui si descrive *cosa* fa il sistema, non *perché* è costruito così.
- Il comportamento verificato automaticamente è indicato con il riferimento al test (`test/e2e.test.js`, `test/compare.test.js`, `test/diagnose.test.js`, `test/analyze.test.js`, `test/print.test.js`, `test/storage.test.js`, `test/auth.test.js`, `test/vercel.test.js`, `test/steps.test.js`, `test/uptime.test.js`, `test/monitor.test.js`, `test/monitor-api.test.js`, `test/notify.test.js`, `test/web.test.js`).
