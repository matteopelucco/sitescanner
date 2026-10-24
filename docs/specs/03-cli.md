# 3. Comandi CLI

```
sitescanner init
sitescanner scan    --site <id> --env <env> [--label <txt>] [--note <txt>] [--no-screenshots] [--keep-html] [--max-pages N]
sitescanner scan    --all --env <env> [--label <txt>] [--note <txt>] [--no-screenshots] [--keep-html] [--max-pages N]
sitescanner list    [--site <id>]
sitescanner label   --site <id> --scan <ref> --label <txt> [--note <txt>]
sitescanner report  [--site <id>] [--out report/]
sitescanner ui      [--port 4173] [--host 127.0.0.1] [--open]      (alias: serve)
sitescanner inventory --url <url> | --site <id> --env <env> [--max-pages N] [--max-depth N] [--concurrency N] [--json out.json]
sitescanner export  --site <id> --base <ref> [--head <ref>] --out bundle/
sitescanner pdf     --site <id> --base <ref> [--head <ref>] [--out file.pdf] [--redirect-map f.csv]
sitescanner compare --site <id> --base <ref> --head <ref> [--redirect-map f.csv] [--fail-on error|warn] [--json out.json] [--visual]
```

`<ref>` è un riferimento a una scan (vedi [§5.4](05-storico-e-dati.md#54-riferimenti-a-una-scan)).

## 3.1 Regole generali

| ID | Requisito |
|---|---|
| RF-CLI-01 | `sitescanner`, `sitescanner help`, `--help`/`-h` (anche dopo un comando) mostrano l'aiuto ed escono con 0. `--version`/`-v` stampa la versione. |
| RF-CLI-02 | Opzioni sconosciute, opzioni obbligatorie mancanti, valori non validi e comandi sconosciuti producono un messaggio `Errore: …` ed exit code 2. |
| RF-CLI-03 | Exit code: **0** successo; **1** soglia `--fail-on` superata oppure almeno un sito fallito in `scan --all`; **2** errore d'uso, di configurazione o errore inatteso. |
| RF-CLI-04 | L'output è colorato solo se lo stdout è un terminale e `NO_COLOR` non è impostata. |
| RF-CLI-05 | Ctrl+C (o SIGTERM) durante una scan elimina la cartella temporanea della scan in corso ed esce con 130. |

## 3.2 `init`

| ID | Requisito |
|---|---|
| RF-INIT-01 | Crea `sites/`, `data/`, `report/`, `inventory/` se mancanti. |
| RF-INIT-02 | Crea `sites/example.yml` commentato con tutte le opzioni; se esiste già NON lo modifica e lo segnala. |
| RF-INIT-03 | Crea un `.gitignore` con `report/`, `bundle/` e `inventory/` solo se nella cartella non ne esiste già uno. |

## 3.3 `scan`

| ID | Requisito |
|---|---|
| RF-SCAN-01 | `--env` è obbligatorio; è obbligatorio esattamente uno tra `--site` e `--all`. |
| RF-SCAN-02 | `--site`: esegue la scan del sito sull'ambiente indicato (comportamento in [§4](04-scansione.md)) e, se riuscita, stampa id, numero di pagine, conteggio issue per severità, numero di screenshot e l'eventuale troncamento a `maxPages`. |
| RF-SCAN-03 | `--label` e `--note` vengono registrate nell'istantanea. |
| RF-SCAN-04 | `--no-screenshots` disabilita gli screenshot anche se abilitati nella configurazione. |
| RF-SCAN-05 | `--keep-html` salva l'HTML grezzo di ogni pagina nell'istantanea. |
| RF-SCAN-06 | `--max-pages N` (intero positivo) sostituisce `maxPages` della configurazione per questa scan. |
| RF-SCAN-07 | `--all` scansiona in sequenza, in ordine alfabetico, tutti i siti di `sites/`. Ogni sito è isolato: configurazione non valida o scan fallita producono una riga `✗ <id>: <motivo>` e non interrompono gli altri siti. *(test e2e)* |
| RF-SCAN-08 | Con `--all`, i siti che non definiscono l'ambiente richiesto vengono **saltati** (non contano come falliti). |
| RF-SCAN-09 | Con `--all`, al termine viene stampato un riepilogo (ok, falliti, saltati, con il motivo di ogni fallimento). L'exit code è 1 se almeno un sito è fallito. *(test e2e)* |
| RF-SCAN-10 | `--quiet`/`-q` sopprime l'avanzamento pagina per pagina (opzione aggiuntiva, utile in CI). |

## 3.4 `list`

| ID | Requisito |
|---|---|
| RF-LIST-01 | Senza `--site` elenca tutti i siti (configurati o con dati nello storico); con `--site` solo quello. Un sito sconosciuto produce errore d'uso. |
| RF-LIST-02 | Per ogni sito mostra il numero di scan e, dalla più recente, una riga per scan con: id, label, ambiente, data e ora locali, numero di pagine, issue `E/W/I`, nota. |
| RF-LIST-03 | Label e note mostrate sono quelle correnti (comprese le modifiche fatte con `label`). *(test e2e)* |

## 3.5 `label`

| ID | Requisito |
|---|---|
| RF-LABEL-01 | `--site`, `--scan`, `--label` sono obbligatori; `--note` è opzionale. |
| RF-LABEL-02 | Imposta label (e nota, se indicata) della scan risolta da `--scan`, sovrascrivendo i valori precedenti. Se `--note` è omessa, la nota esistente resta invariata. |
| RF-LABEL-03 | NON modifica l'istantanea (vedi [§5.3](05-storico-e-dati.md#53-label-e-note)). *(test e2e)* |

## 3.6 `report`

| ID | Requisito |
|---|---|
| RF-REP-01 | Genera il report (vedi [§7](07-report.md)) nella cartella `--out` (default `report/`), creandola se manca. |
| RF-REP-02 | Con `--site` il report contiene solo quel sito; se il sito non ha scan, errore d'uso. |
| RF-REP-03 | Stampa il percorso del report e il numero di siti e scan inclusi. |
| RF-REP-04 | Rigenerare il report è idempotente: i dati di scan già presenti nel report non vengono riscritti; i dati di scan non più esistenti vengono rimossi. |

## 3.7 `ui` (alias `serve`)

| ID | Requisito |
|---|---|
| RF-SERVE-01 | Avvia un server HTTP su `<host>:<port>` (default `127.0.0.1:4173`) che espone la web app su `/` (vedi [§8](08-web-app.md)), la sua API su `/api/`, `report/` sotto `/report/` e `data/` sotto `/data/`. `/report` reindirizza a `/report/`. |
| RF-SERVE-02 | Qualsiasi path fuori dalla web app, da `report/` e da `data/` (compresi tentativi di path traversal) risponde 404. |
| RF-SERVE-03 | Se `report/index.html` non esiste, il report viene generato prima di avviare il server. |
| RF-SERVE-04 | Il server resta attivo fino a Ctrl+C. Stampa l'URL della web app, quello del report e la cartella di lavoro. |
| RF-SERVE-05 | Porta già in uso → errore d'uso con l'indicazione di `--port`. |
| RF-SERVE-06 | `--host` diverso da un indirizzo di loopback produce un avviso: la web app è raggiungibile da altre macchine senza autenticazione. |
| RF-SERVE-07 | `--open` apre la web app nel browser predefinito. |

## 3.8 `inventory`

| ID | Requisito |
|---|---|
| RF-INVC-01 | È obbligatorio esattamente uno tra `--url` e `--site`; con `--site` serve anche `--env`. |
| RF-INVC-02 | Esegue e salva un inventario (vedi [§9](09-inventario.md)); `--max-pages`, `--max-depth`, `--concurrency` (interi positivi) sostituiscono i default. |
| RF-INVC-03 | Stampa: URL visitati e pagine HTML, conteggi per classe di status, profondità di click (max, media, istogramma), profondità URL, pagine non collegate, dati della sitemap, le prime 15 sezioni e l'eventuale troncamento. |
| RF-INVC-04 | `--json out.json` scrive l'inventario completo; `--quiet`/`-q` sopprime l'avanzamento. |

## 3.9 `export`

| ID | Requisito |
|---|---|
| RF-EXP-01 | `--site`, `--base`, `--out` sono obbligatori; `--head` è facoltativo. |
| RF-EXP-02 | Crea in `--out` un report autonomo contenente solo il sito indicato e le due scan, con gli screenshot copiati nel bundle, e Base/Head già preselezionati. Senza `--head` il bundle contiene la sola Base e si apre sulla vista diagnostica ([§7.7](07-report.md#77-vista-diagnostica-di-una-singola-scan)). *(test e2e)* |
| RF-EXP-03 | Il bundle DEVE funzionare aperto da file e una volta spostato o compresso, senza riferimenti a `data/`. |
| RF-EXP-04 | Se `--out` esiste, non è vuota e non contiene un bundle precedente (`index.html`), il comando rifiuta di scriverci. Se contiene un bundle precedente, ne sostituisce dati e screenshot. |

## 3.10 `compare`

| ID | Requisito |
|---|---|
| RF-CMP-01 | `--site`, `--base`, `--head` sono obbligatori. Confronta le due scan secondo [§6](06-confronto.md). |
| RF-CMP-02 | Stampa: le due scan (id, label, ambiente, data), il conteggio delle pagine (Base → Head, cambiate, aggiunte, rimosse, invariate), il conteggio delle differenze per severità, l'elenco delle differenze `error` e `warn` (al massimo 50, configurabile con `--limit`) e un riepilogo per tipo delle differenze `info`. |
| RF-CMP-03 | `--redirect-map f.csv` applica la redirect map (formato in [§6.2](06-confronto.md#62-redirect-map)). File mancante → errore d'uso. *(test e2e)* |
| RF-CMP-04 | `--fail-on error\|warn`: se esiste almeno una differenza di severità pari o superiore, stampa `FAIL` ed esce con 1; altrimenti stampa `PASS` ed esce con 0. Altri valori → errore d'uso. Senza `--fail-on` l'exit code è 0. *(test e2e)* |
| RF-CMP-05 | `--json out.json` scrive il risultato completo: sito, data, versione del tool, `failOn`, `passed`, numero di voci della redirect map, metadati Base/Head, `summary`, `pairs`, `findings` (e `visual` se richiesto). |
| RF-CMP-06 | `--visual` confronta pixel per pixel gli screenshot delle pagine abbinate (vedi [§6.6](06-confronto.md#66-confronto-visivo)). Se una delle due scan non ha screenshot viene emesso un avviso e il confronto visivo è parziale o assente. |
| RF-CMP-07 | `compare.ignore` e `compare.thresholds` del sito vengono applicati; se la configurazione del sito non esiste più si usano i default. |

## 3.11 `pdf`

| ID | Requisito |
|---|---|
| RF-PDFC-01 | `--site` e `--base` sono obbligatori. Senza `--head` genera il report di qualità di Base, con `--head` il report di regressione Base → Head (vedi [§7.8](07-report.md#78-export-pdf)). *(test e2e)* |
| RF-PDFC-02 | `--out` è il file da scrivere (le cartelle mancanti sono create); di default `sitescanner-<sito>-<base>[-vs-<head>].pdf` nella cartella corrente. `--redirect-map` come in `compare`; si applicano `compare.ignore` e `compare.thresholds` del sito. |
| RF-PDFC-03 | Richiede Playwright con Chromium (lo stesso degli screenshot); la variabile d'ambiente `SITESCANNER_CHROMIUM` indica un eseguibile di Chromium/Chrome alternativo, usato anche per gli screenshot. Se il browser manca o non si avvia: errore d'uso (exit 2) con l'indicazione di come installarlo. *(test e2e)* |
