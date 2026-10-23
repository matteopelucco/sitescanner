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
sitescanner export  --site <id> --base <x> --head <y> --out bundle/
sitescanner compare --site <id> --base <x> --head <y> [--redirect-map f.csv] [--fail-on error|warn] [--json out.json] [--visual]
```

- **scan `--all`**: scansiona in sequenza tutti i siti di `sites/`. Ogni sito è isolato: un errore (configurazione non valida, sito irraggiungibile) viene riportato nel riepilogo finale senza fermare gli altri. I siti che non definiscono l'ambiente richiesto vengono saltati. Exit code 1 se almeno un sito è fallito.
- **Riferimenti a una scan** (`--scan`, `--base`, `--head`): id completo, prefisso univoco dell'id, label (vince la più recente), `latest`, `latest~N` (N scan prima dell'ultima).
- **label**: modifica label e nota *dopo* la scan senza toccare l'istantanea (vedi «Dati»).
- **report**: genera `report/index.html`. Si apre anche con doppio clic (`file://`); con `ui` è disponibile in più il «Pixel diff» calcolato nel browser.
- **ui**: avvia la web app (vedi «Web app»). Ascolta solo su `127.0.0.1` per default; con `--host` diverso la web app è raggiungibile da altre macchine **senza autenticazione**.
- **inventory**: misura un sito (vedi «Inventario») e lo salva in `inventory/`.
- **export**: crea una cartella autonoma con il report limitato alle due scan e i relativi screenshot copiati, già preselezionati come Base/Head. Si può zippare e condividere.
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

Credenziali e header sensibili vengono mascherati nella copia della configurazione salvata dentro ogni scan.

## Cosa viene rilevato

**Per pagina** (in ogni scan): status e catena di redirect, content-type, tempo di risposta, dimensione, title, meta description, meta robots, canonical, lang, H1 e conteggio heading, hreflang, Open Graph, numero di parole e hash del testo, link interni/esterni, immagini senza alt, contenuti misti, screenshot.

**Issue di qualità** (vista as-is): `http-4xx`, `http-5xx`, `fetch-failed`, `broken-links`, `redirect-broken`, `redirect-chain`, `slow-response`, `title-missing`, `title-too-long`, `title-duplicate`, `description-missing`, `description-too-long`, `description-duplicate`, `h1-missing`, `h1-multiple`, `img-alt-missing`, `mixed-content`, `noindex`, `canonical-missing`, `canonical-other`, `lang-missing`, `viewport-missing`, `page-heavy`.

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
| `perf-regression` | warn |
| `issue-new` / `issue-resolved` | severità della issue / info |
| `visual-changed` | warn oltre `visualWarn`, info oltre `visualInfo` (solo con `--visual`) |

## Web app

`sitescanner ui` avvia sul proprio computer una web app con:

- **Siti**: elenco con ultima scan ed errori; creazione e modifica della configurazione con un form (che conserva i commenti del YAML) o direttamente in YAML; eliminazione (lo storico resta).
- **Scan**: avvio per ambiente con label, nota, limite di pagine e opzione senza screenshot; avanzamento in tempo reale (fase, pagine visitate/scoperte, URL corrente) e annullamento; storico con label modificabili e link «Confronta con la precedente» al report.
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

I test avviano un piccolo sito locale in due versioni e verificano scan, storico, confronto, redirect map, label, report ed export; `test/web.test.js` verifica API della web app, job, inventario e protezioni del server.

Il modulo [src/core/compare.js](src/core/compare.js) non ha dipendenze ed è incluso così com'è nel report: CLI e browser usano la stessa logica di confronto.

### Limiti noti

- Il crawler legge l'HTML restituito dal server: i contenuti generati solo lato client non vengono analizzati (compaiono però negli screenshot).
- Il supporto a robots.txt copre `User-agent`, `Allow`, `Disallow` con `*` e `$`.
- Il «Pixel diff» nel report richiede `sitescanner ui` (i browser bloccano la lettura dei pixel da `file://`); le altre modalità funzionano ovunque.
