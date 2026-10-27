# 2. Configurazione dei siti

## 2.1 Struttura del progetto

Il tool lavora sulla cartella corrente o, se impostata, sulla cartella indicata dalla variabile d'ambiente `SITESCANNER_HOME`.

```
sites/      configurazioni dei siti (una per file)
data/       storico delle scan
report/     report generato
```

## 2.2 File di sito

| ID | Requisito |
|---|---|
| RF-CFG-01 | Ogni sito è descritto da un file `sites/<id>.yml` (o `.yaml`). L'`id` è il nome del file e DEVE contenere solo lettere, cifre, `_`, `.` e `-`. |
| RF-CFG-02 | Il file DEVE definire almeno un ambiente in `envs`, ognuno con un `baseUrl` che sia un URL valido. In caso contrario il comando termina con errore di configurazione (exit code 2) indicando file e chiave. |
| RF-CFG-03 | I valori del file POSSONO contenere `${NOME}`, sostituito con la variabile d'ambiente `NOME` (stringa vuota se assente). Serve a tenere le credenziali fuori dal file. |
| RF-CFG-04 | Le chiavi non indicate assumono i valori di default della tabella 2.3. |
| RF-CFG-05 | YAML non valido DEVE produrre un errore di configurazione con il messaggio del parser. |

Esempio:

```yaml
name: Shop
envs:
  prod:
    baseUrl: https://www.shop.it/
  stage:
    baseUrl: https://stage.shop.it/
    auth: { username: ${STAGE_USER}, password: ${STAGE_PASS} }
    headers: { X-Preview: "1" }
maxPages: 500
exclude: ["^/checkout", "\\.(pdf|zip)$"]
screenshots:
  hide: [".cookie-banner"]
compare:
  ignore: [perf-regression]
quality:
  disable: [anchor-generic]
  severity: { thin-content: warn }
  thinWords: 150
```

## 2.3 Opzioni

| Chiave | Default | Descrizione |
|---|---|---|
| `name` | id del sito | Nome visualizzato. |
| `envs.<env>.baseUrl` | — | Obbligatorio. Definisce origine e prefisso di path entro cui si muove il crawler. |
| `envs.<env>.auth` | — | Basic auth `{ username, password }`, usata anche dal browser degli screenshot. |
| `envs.<env>.headers` | — | Header HTTP aggiuntivi per l'ambiente; si sommano a `headers`. |
| `headers` | `{}` | Header HTTP comuni a tutti gli ambienti. |
| `start` | `["/"]` | URL di partenza, relativi a `baseUrl`. |
| `sitemap` | `true` | `true`: usa `sitemap.xml` e le sitemap dichiarate in `robots.txt`; lista: usa quegli URL; `false`: nessuna sitemap. |
| `maxPages` | 200 | Numero massimo di URL visitati per scan (sovrascrivibile con `--max-pages`). |
| `maxDepth` | 10 | Profondità massima di link seguiti dagli URL di partenza. |
| `concurrency` | 4 | Richieste HTTP parallele. |
| `delayMs` | 0 | Pausa dopo ogni richiesta, per ogni worker. |
| `timeoutMs` | 15000 | Timeout di ogni richiesta HTTP. |
| `respectRobots` | `true` | Esclude gli URL vietati da `robots.txt`. |
| `include` | `[]` | Regex sulla chiave di pagina: se presenti, si visitano solo le pagine che ne soddisfano almeno una. |
| `exclude` | `[]` | Regex sulla chiave di pagina: le pagine corrispondenti non vengono visitate. |
| `ignoreQuery` | `false` | Se `true`, la query string viene scartata (`/a?x=1` e `/a` sono la stessa pagina). |
| `ignoreParams` | `[]` | Parametri di query da ignorare, in aggiunta a quelli di tracciamento predefiniti (vedi [§4.1](04-scansione.md#41-perimetro-del-crawling), RF-CRAWL-05). Un `*` finale indica qualsiasi suffisso (es. `ref_*`). |
| `userAgent` | `sitescanner/0.1 (+regression-scan)` | User-Agent delle richieste HTTP. |
| `storeText` | `true` | Salva il testo estratto di ogni pagina, necessario per il diff testuale nel report. |
| `screenshots.enabled` | `true` | Abilita gli screenshot. |
| `screenshots.width` / `height` | 1366 / 900 | Dimensioni del viewport. |
| `screenshots.fullPage` | `true` | Cattura l'intera pagina. |
| `screenshots.maxHeight` | 10000 | Altezza massima in pixel di uno screenshot a pagina intera. |
| `screenshots.waitMs` | 300 | Attesa dopo il caricamento prima dello scatto. |
| `screenshots.concurrency` | 2 | Schede del browser in parallelo. |
| `screenshots.hide` | `[]` | Selettori CSS resi invisibili prima dello scatto (banner cookie, contenuti variabili). |
| `compare.ignore` | `[]` | Tipi di differenza da non riportare (vedi [§6.4](06-confronto.md#64-tipi-di-differenza)). |
| `compare.thresholds` | vedi §6.5 | Soglie del confronto. |
| `quality.disable` | `[]` | Codici di issue di qualità da non calcolare (vedi [§4.4](04-scansione.md#44-issue-di-qualità)). |
| `quality.severity` | `{}` | Severità diversa da quella predefinita per singoli codici (`error`, `warn`, `info`). |
| `quality.<soglia>` | vedi §4.4 | `slowMs` (2000), `titleMin`/`titleMax` (30/65), `descriptionMin`/`descriptionMax` (70/170), `thinWords` (200), `maxClickDepth` (3), `maxDomNodes` (1500), `maxUrlLength` (115). |
| `map.*` | vedi §14.4 | Opzioni della mappa del sito (vedi [§14.4](14-mappa-del-sito.md#144-configurazione)). Implementate le chiavi di raccolta: `siblings` (`true`), `siteDomain`, `siblingHosts` (`[]`), `siblingExclude` (`[]`), `maxSiblingPages` (200), `render` (`auto`), `maxRendered` (50), `documentTypes` (`[pdf]`), `checkDocuments` (`false`), `maxDocuments` (1000), `navSelectors` (`[]`), `templateRatio` (0,8); le altre (aree, genitori) arrivano con le fasi successive. |
