# Registro delle decisioni architetturali

<!-- generato da adr.py index -->

| # | Titolo | Stato | Data |
|---|---|---|---|
| 0001 | [Node.js ESM senza build step, con dipendenze minime e Playwright opzionale](0001-node-js-esm-senza-build-e-dipendenze-minime.md) | proposed | 2026-10-22 |
| 0002 | [Storico su filesystem con istantanee immutabili, scritte in staging e rese di sola lettura](0002-storico-su-filesystem-con-istantanee-immutabili.md) | proposed | 2026-10-22 |
| 0003 | [Label e note modificabili in un file overlay separato dalle istantanee](0003-label-e-note-in-overlay-mutabile.md) | proposed | 2026-10-22 |
| 0004 | [Crawling e analisi via HTTP; browser headless usato solo per gli screenshot](0004-crawling-http-e-browser-solo-per-screenshot.md) | proposed | 2026-10-22 |
| 0005 | [Abbinare le pagine tra scan per chiave path+query normalizzata, con redirect map opzionale](0005-abbinamento-pagine-per-chiave-normalizzata.md) | proposed | 2026-10-22 |
| 0006 | [Un unico modulo di confronto puro, eseguito sia dalla CLI sia dal report nel browser](0006-modulo-di-confronto-puro-condiviso.md) | proposed | 2026-10-22 |
| 0007 | [Report statico che carica i dati con tag script (stile JSONP) per funzionare anche da file://](0007-report-statico-con-caricamento-dati-via-script.md) | proposed | 2026-10-22 |
| 0008 | [Tre livelli di severità fissi per tipo di differenza, con soglie configurabili e `--fail-on` per la CI](0008-tre-livelli-di-severita-e-fail-on-per-la-ci.md) | proposed | 2026-10-22 |
| 0009 | [Crawling in ampiezza per livelli ordinati, per ottenere scan deterministiche](0009-crawling-per-livelli-ordinati.md) | proposed | 2026-10-22 |
| 0010 | [Non salvare le scan in cui nessuna pagina è raggiungibile](0010-non-salvare-scan-senza-pagine-raggiungibili.md) | proposed | 2026-10-22 |
| 0011 | [Job in background nel processo del server, con avanzamento via Server-Sent Events](0011-job-in-background-nel-processo-del-server-con-avanzamento-vi.md) | proposed | 2026-10-23 |
| 0012 | [Server locale della web app: solo loopback, controllo di Host e Origin, scritture solo JSON](0012-server-locale-della-web-app-solo-loopback-controllo-di-host.md) | proposed | 2026-10-23 |
| 0013 | [Inventario del sito come crawl separato dalle scan, senza storico né confronto](0013-inventario-del-sito-come-crawl-separato-dalle-scan-senza-sto.md) | proposed | 2026-10-23 |
| 0014 | [Catalogo delle regole di qualità registrato in ogni scan, per non scambiare regole nuove per regressioni](0014-catalogo-di-regole-di-qualita-registrato-in-ogni-scan.md) | proposed | 2026-10-24 |
| 0015 | [PDF da un documento di stampa condiviso, impaginato con CSS paged media e reso da Chromium](0015-pdf-da-documento-di-stampa-condiviso-con-css-paged-media.md) | accepted | 2026-10-24 |
| 0016 | [Accesso multi-utente con sessioni opache e password scrypt, senza librerie di autenticazione](0016-accesso-multi-utente-con-sessioni-opache-e-password-scrypt-s.md) | proposed | 2026-10-24 |
| 0017 | [Storage a backend intercambiabili: filesystem in locale, Postgres e Vercel Blob su Vercel](0017-storage-a-backend-intercambiabili-filesystem-in-locale-postg.md) | proposed | 2026-10-24 |
| 0018 | [Scan e inventari su Vercel come job a passi riprendibili su Vercel Queues](0018-scan-e-inventari-su-vercel-come-job-a-passi-riprendibili-su.md) | proposed | 2026-10-24 |
| 0019 | [Monitoraggio a giri ogni 5 minuti, con disponibilità calcolata dal tempo coperto dai controlli](0019-monitoraggio-a-giri-ogni-5-minuti-con-disponibilita-calcolat.md) | proposed | 2026-10-25 |
| 0020 | [Mappa del sito come vista dell'inventario esteso](0020-mappa-del-sito-come-vista-dell-inventario-esteso.md) | accepted | 2026-10-26 |
| 0021 | [Librerie d3-force e d3-hierarchy incluse nel repository per il grafo della mappa](0021-librerie-d3-force-e-d3-hierarchy-incluse-nel-repository-per.md) | accepted | 2026-10-26 |
