# sitescanner

CLI e web app locale che scansiona uno o più siti web, salva ogni scansione come **istantanea immutabile** (as-is), mantiene lo **storico** per sito e genera un **report HTML5 statico** per confrontare due scansioni qualsiasi (Base × Head) come regression test. Con l'**inventario** misura dimensione, struttura e profondità di un sito qualsiasi.

## Installazione

Richiede Node.js ≥ 20.

```sh
npm install
npx playwright install chromium   # solo se non già presente: serve per gli screenshot
npm link                          # opzionale: rende disponibile il comando `sitescanner`
```

Playwright è una dipendenza opzionale: senza, le scan funzionano lo stesso e gli screenshot vengono saltati (con un avviso).

## Avvio rapido

```sh
sitescanner init                                        # crea sites/, data/, report/, inventory/ e sites/example.yml
sitescanner ui --open                                   # web app su http://127.0.0.1:4173/
```

Oppure da terminale:

```sh
# modifica sites/example.yml (baseUrl, ambienti…), poi:
sitescanner scan --site example --env prod --label v1
# … deploy …
sitescanner scan --site example --env prod --label v2
sitescanner compare --site example --base v1 --head v2 --fail-on error
sitescanner report && sitescanner ui                    # report su http://127.0.0.1:4173/report/
```

Tutti i comandi lavorano sulla cartella corrente (o su `SITESCANNER_HOME`, se impostata).

## Comandi

```
sitescanner init
sitescanner scan    --site <id> --env <env> [--label <txt>] [--note <txt>] [--no-screenshots] [--keep-html] [--max-pages N]
sitescanner scan    --all --env <env> [--label <txt>]
sitescanner list    [--site <id>]
sitescanner label   --site <id> --scan <id> --label <txt> [--note <txt>]
sitescanner report  [--site <id>] [--out report/]
sitescanner ui      [--port 4173] [--host 127.0.0.1] [--open]      (alias: serve)
sitescanner inventory --url <url> | --site <id> --env <env> [--max-pages N] [--max-depth N] [--concurrency N] [--json out.json]
sitescanner export  --site <id> --base <x> [--head <y>] --out bundle/
sitescanner pdf     --site <id> --base <x> [--head <y>] [--out file.pdf] [--redirect-map f.csv]
sitescanner compare --site <id> --base <x> --head <y> [--redirect-map f.csv] [--fail-on error|warn] [--json out.json] [--visual]
```

- **scan `--all`**: scansiona in sequenza tutti i siti di `sites/`. Ogni sito è isolato: un errore (configurazione non valida, sito irraggiungibile) viene riportato nel riepilogo finale senza fermare gli altri. I siti che non definiscono l'ambiente richiesto vengono saltati. Exit code 1 se almeno un sito è fallito.
- **Riferimenti a una scan** (`--scan`, `--base`, `--head`): id completo, prefisso univoco dell'id, label (vince la più recente), `latest`, `latest~N` (N scan prima dell'ultima).
- **label**: modifica label e nota *dopo* la scan senza toccare l'istantanea (vedi «Dati»).
- **report**: genera `report/index.html`. Si apre anche con doppio clic (`file://`); con `ui` è disponibile in più il «Pixel diff» calcolato nel browser.
- **ui**: avvia la web app (vedi «Web app»). Ascolta solo su `127.0.0.1` per default; con `--host` diverso la web app è raggiungibile da altre macchine **senza autenticazione**.
- **inventory**: misura un sito (vedi «Inventario») e lo salva in `inventory/`.
- **export**: crea una cartella autonoma con il report limitato alle due scan e i relativi screenshot copiati, già preselezionati come Base/Head. Senza `--head` contiene la sola Base e si apre sulla sua diagnostica. Si può zippare e condividere.
- **pdf**: report in PDF A4 da consegnare o allegare: senza `--head` il report di qualità della scan, con `--head` il report di regressione. Copertina con esito e health score, sommario, intestazioni e «Pagina N di M», sezioni impaginate per la stampa. Richiede Playwright con Chromium (come gli screenshot); `SITESCANNER_CHROMIUM` indica un Chrome/Chromium già installato.
- **compare**: confronto da terminale/CI. `--fail-on error|warn` fa uscire con codice 1 se esistono differenze di quel livello o superiore; `--json` salva il risultato completo; `--visual` confronta pixel per pixel gli screenshot; `--redirect-map` accoppia URL vecchi e nuovi (CSV `from,to`, URL assoluti o path).

Exit code: `0` ok · `1` soglia `--fail-on` superata o scan fallite · `2` errore d'uso o di configurazione.

## Configurazione di un sito

Un file YAML per sito in `sites/`; il nome del file è l'id. Vedi l'esempio commentato generato da `init`. Le chiavi principali:

| Chiave | Default | Note |
|---|---|---|
| `envs.<env>.baseUrl` | — | obbligatorio; la scan resta dentro origin + path di `baseUrl` |
| `envs.<env>.auth` | — | Basic auth `{ username, password }`; supporta `${VAR}` d'ambiente |
| `envs.<env>.headers` | — | header extra (anche per gli screenshot) |
| `start` | `["/"]` | URL di partenza |
| `sitemap` | `true` | `true` = `/sitemap.xml` + sitemap di robots.txt; oppure lista di URL. Gli URL vengono riportati sull'ambiente scansionato |
| `maxPages` / `maxDepth` | 200 / 10 | |
| `concurrency` / `delayMs` / `timeoutMs` | 4 / 0 / 15000 | |
| `respectRobots` | `true` | |
| `include` / `exclude` | `[]` | regex sul path |
| `ignoreQuery` | `false` | |
| `ignoreParams` | `[]` | parametri di query da ignorare oltre a quelli di tracciamento già noti (`utm_*`, `gclid`, `fbclid`, `intcmp`, …); `*` finale = qualsiasi suffisso |
| `storeText` | `true` | salva il testo estratto: abilita il diff testuale nel report |
| `screenshots` | abilitati | `width`, `height`, `fullPage`, `maxHeight`, `waitMs`, `concurrency`, `hide` (selettori da nascondere) |
| `compare.ignore` | `[]` | tipi di differenza da ignorare |
| `compare.thresholds` | — | `contentWarnRatio` (0.3), `perfFactor` (2), `perfMinDeltaMs` (500), `perfMinMs` (1000), `visualWarn` (0.005), `visualInfo` (0.0001) |
| `quality.disable` / `quality.severity` | — | issue di qualità da non calcolare / severità diverse dal default, es. `{ thin-content: warn }` |
| `quality.<soglia>` | — | `slowMs` (2000), `titleMin`/`titleMax` (30/65), `descriptionMin`/`descriptionMax` (70/170), `thinWords` (200), `maxClickDepth` (3), `maxDomNodes` (1500), `maxUrlLength` (115) |

Credenziali e header sensibili vengono mascherati nella copia della configurazione salvata dentro ogni scan.

## Cosa viene rilevato

**Per pagina** (in ogni scan): status e catena di redirect, content-type, tempo di risposta, dimensione, header (`X-Robots-Tag`, compressione, header di sicurezza), **indicizzabilità** con il motivo, title, meta description, meta robots, canonical, lang, H1 e struttura degli heading, hreflang, Open Graph, **dati strutturati JSON-LD**, numero di parole e hash del testo, link interni/esterni/nofollow, **profondità di click**, immagini (senza alt, senza dimensioni), accessibilità di base (campi senza label, pulsanti senza nome, iframe senza title), contenuti misti, screenshot.

**Issue di qualità** (vista as-is): 74 controlli, scelti confrontando Screaming Frog, Semrush, Ahrefs, Sitebulb e Lighthouse ([ricerca](docs/research/controlli-di-qualita.md)), in 15 categorie: risposte e soft 404, redirect (catene, loop, temporanei, meta refresh), indicizzabilità, canonical (multipli, verso pagine rotte, redirect o noindex), title e description (assenti, lunghi, corti, multipli, duplicati), heading, contenuti (thin, duplicati, lorem ipsum), link (rotti, verso redirect, pagine senza link in uscita, profonde, anchor vuoti o generici), sitemap e robots (URL non indicizzabili in sitemap, pagine orfane o mancanti), hreflang (codici, ritorno, x-default), dati strutturati, sicurezza (mixed content, form HTTP, header), prestazioni, HTML e URL, accessibilità. Elenco completo con severità in [§4.4 delle specifiche](docs/specs/04-scansione.md#44-issue-di-qualità); ogni regola si può disattivare o cambiare di severità con `quality`.

**Health score**: per ogni scan, la quota (0–100) di URL senza issue `error`; è nello storico, nella diagnostica e nel confronto.

**Differenze Base → Head** (le pagine sono accoppiate per path, quindi si possono confrontare anche ambienti diversi, es. stage vs prod):

| Tipo | Severità |
|---|---|
| `page-removed` | error se la pagina era 2xx, altrimenti info |
| `page-added` | info (warn se non 2xx) |
| `page-mapped` / `mapped-target-missing` | info / error (redirect map) |
| `status-changed` | error se 2xx → 4xx/5xx/errore; info se tornata 2xx; altrimenti warn |
| `redirect-changed` | warn |
| `title-changed`, `description-changed`, `h1-changed`, `canonical-changed`, `lang-changed` | warn |
| `robots-changed` | error se compare `noindex`, altrimenti warn |
| `content-changed` | warn oltre `contentWarnRatio` di variazione parole, altrimenti info |
| `links-changed` | warn se perde > 20% dei link interni, altrimenti info |
| `indexability-changed` | error se la pagina diventa non indicizzabile (es. `X-Robots-Tag: noindex`, canonical altrove), info se torna indicizzabile |
| `structured-data-changed` | warn se spariscono tipi JSON-LD, info se se ne aggiungono |
| `perf-regression` | warn |
| `issue-new` / `issue-resolved` | severità della issue / info; info se la regola non era attiva in Base (scan di una versione precedente o regola disattivata) |
| `visual-changed` | warn oltre `visualWarn`, info oltre `visualInfo` (solo con `--visual`) |

## Web app

`sitescanner ui` avvia sul proprio computer una web app con:

- **Siti**: elenco con ultima scan ed errori; creazione e modifica della configurazione con un form (che conserva i commenti del YAML) o direttamente in YAML; eliminazione con scelta esplicita se tenere lo storico (il sito resta «solo storico») o cancellarlo definitivamente, scan e screenshot compresi.
- **Scan**: avvio per ambiente con label, nota, limite di pagine e opzione senza screenshot; avanzamento in tempo reale (fase, pagine visitate/scoperte, URL corrente) e annullamento; storico con health score, label modificabili e link a diagnostica, PDF e «Confronta con la precedente» nel report.
- **Inventari**: avvio su un sito configurato o su un URL qualsiasi, elenco e dettaglio.
- **Attività**: tutti i job della sessione, con log.

Le scan avviate dalla web app sono identiche a quelle da CLI e il report viene rigenerato dopo ognuna. I job vivono nel processo del server: se lo si chiude, una scan in corso va persa (senza lasciare dati parziali).

## Inventario

Un crawl senza screenshot e senza confronto, con limiti alti (5000 URL, profondità 50), per sapere quanto è grande un sito e com'è fatto:

- URL e pagine HTML, distribuzione degli status e dei content type, peso e tempo di risposta;
- **profondità di click** dalla home (minimo numero di link da seguire) e **profondità degli URL** (segmenti del path), con istogrammi;
- sezioni (primo livello del path) e albero degli URL;
- pagine presenti solo in sitemap (non collegate), pagine collegate assenti dalla sitemap;
- pagine con più link entranti e più profonde; tabella di tutti gli URL, esportabile in CSV.

```sh
sitescanner inventory --url https://www.example.com/ --max-pages 20000
sitescanner inventory --site shop --env prod --json inventario.json
```

Gli inventari non entrano nello storico delle scan né nel report.

## Report

Si sceglie un sito e due scan dalla sua storia (Base e Head, invertibili). Il report mostra l'esito (regressioni / da verificare / nessuna regressione), i contatori, e quattro schede:

- **Differenze**: filtrabili per severità, tipo e testo.
- **Pagine**: tutte le pagine con stato (cambiata, aggiunta, rimossa, invariata) e status Base/Head.
- **Issue**: issue di qualità per codice, con conteggio Base, Head e delta.
- **Storico**: andamento di pagine/errori/warning e scelta rapida di Base e Head.

Cliccando una pagina si apre il dettaglio: differenze, confronto campo per campo, issue, screenshot (affiancati, slider, fusione «difference», pixel diff, singoli) e diff del testo. Si può caricare una redirect map CSV direttamente nel report. Lo stato (sito, scan, pagina aperta) è nell'URL, quindi i link sono condivisibili.

**Diagnostica di una scan**: lasciando vuota Head («— nessuna —») il report mostra lo stato di qualità della sola Base: esito, dati del crawl, contatori per severità e per status, issue raggruppate per codice con le pagine coinvolte, tutte le pagine filtrabili per status e issue, e un dettaglio pagina con issue, campi, link entranti e uscenti, screenshot e testo. È la vista predefinita per un sito con una sola scan.

**PDF**: il pulsante «PDF» esporta la vista corrente (qualità o regressione). Con `sitescanner ui` il PDF è generato dal server; aprendo il report da file o da un bundle si apre il documento di stampa e si salva con «Salva come PDF» del browser (Chrome/Edge per intestazioni e numeri di pagina).

## Dati

```
sites/<id>.yml
data/<id>/scans/<scanId>/scan.json        istantanea (sola lettura)
data/<id>/scans/<scanId>/text.json        testo estratto per pagina
data/<id>/scans/<scanId>/screenshots/*.png
data/<id>/scans/<scanId>/html/*.html      solo con --keep-html
data/<id>/labels.json                     label/note modificate dopo la scan
report/                                   generato, rigenerabile
inventory/<id>.json                       inventari (inventory/<id>.meta.json: solo riepilogo)
```

Una scan viene scritta in una cartella temporanea e spostata al suo posto solo a scansione completata (un'interruzione non lascia scan parziali); i file vengono poi resi di sola lettura. Ogni `scan.json` contiene anche la versione del tool, le opzioni usate e una copia della configurazione (con hash), così resta interpretabile anche se la configurazione cambia. Se nessuna pagina risponde la scan non viene salvata.

## Uso in CI

```sh
sitescanner scan --site shop --env stage --label "$CI_COMMIT_SHA" --no-screenshots
sitescanner compare --site shop --base release --head latest --fail-on error --json compare.json
```

## Documentazione

- [Specifiche funzionali](docs/specs/README.md): requisiti numerati per comandi, scansione, storico, confronto e report.
- [Decisioni architetturali (ADR)](docs/adr/README.md): perché il sistema è costruito così.

## Sviluppo

```sh
npm test
```

I test avviano un piccolo sito locale in due versioni e verificano scan, storico, confronto, redirect map, label, report, export e PDF; `test/analyze.test.js` le regole di qualità, `test/diagnose.test.js` e `test/print.test.js` diagnostica e documento di stampa, `test/web.test.js` API della web app, job, inventario e protezioni del server.

I moduli di [src/core/](src/core/) (`compare.js`, `diagnose.js`, `print.js`) non hanno dipendenze esterne e sono inclusi così come sono nel report: CLI e browser usano la stessa logica di confronto, diagnostica e documento di stampa.

### Limiti noti

- Il crawler legge l'HTML restituito dal server: i contenuti generati solo lato client non vengono analizzati (compaiono però negli screenshot).
- Il supporto a robots.txt copre `User-agent`, `Allow`, `Disallow` con `*` e `$`.
- Il «Pixel diff» nel report richiede `sitescanner ui` (i browser bloccano la lettura dei pixel da `file://`); le altre modalità funzionano ovunque.
