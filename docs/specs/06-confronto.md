# 6. Confronto Base/Head

Il confronto prende due scan dello stesso sito (anche di ambienti diversi) e produce un elenco di **differenze** (*finding*), un **riepilogo** e lo **stato di ogni pagina**. La stessa logica è usata dal comando `compare` e dal report (RNF-08).

## 6.1 Abbinamento delle pagine

| ID | Requisito |
|---|---|
| RF-DIFF-01 | Le pagine sono abbinate per **chiave di pagina** (path + query normalizzata), quindi l'origine non conta: si possono confrontare `stage` e `prod`. |
| RF-DIFF-02 | Una pagina solo in Base è **rimossa**, una solo in Head è **aggiunta**, una presente in entrambe è **cambiata** se genera almeno una differenza (escluso `page-mapped`), altrimenti **invariata**. |
| RF-DIFF-03 | Le pagine non visitate in una scan (per esempio perché nessuno le linka più o per il limite `maxPages`) risultano rimosse o aggiunte. *(test e2e: `/old-page`)* |

## 6.2 Redirect map

File CSV (separatore `,`, `;` o tab) con colonne `from,to`. Le righe vuote e quelle che iniziano con `#` sono ignorate; un'eventuale intestazione (`from`, `old` o `source` nella prima colonna) è ignorata. I valori possono essere URL assoluti o path e vengono ridotti a chiavi di pagina.

| ID | Requisito |
|---|---|
| RF-DIFF-10 | Una pagina di Base con chiave `from` è confrontata con la pagina di Head con chiave `to` e genera `page-mapped` (info). *(test e2e)* |
| RF-DIFF-11 | Se `to` non esiste in Head si genera `mapped-target-missing` (error). *(test unitario)* |
| RF-DIFF-12 | Una pagina di Head usata come destinazione non viene segnalata come aggiunta. |
| RF-DIFF-13 | Nel controllo dei link persi, un link a `from` sostituito da un link a `to` non conta come perso. |
| RF-DIFF-14 | Nel report la redirect map si carica dall'interfaccia (§7.3). |

## 6.3 Regole di confronto

Per le pagine presenti in entrambe le scan:

- status, errore e destinazione dei redirect sono sempre confrontati;
- i campi di contenuto (title, description, canonical, lang, H1, meta robots, hreflang, testo, link, tempo di risposta) sono confrontati **solo se entrambe le pagine sono 2xx senza errori**;
- i testi sono confrontati dopo la normalizzazione degli spazi; canonical e hreflang dopo la riduzione a chiave di pagina;
- le issue di pagina sono confrontate per codice: un codice presente solo in Head è `issue-new`, solo in Base è `issue-resolved`;
- le issue tra pagine (duplicati) sono confrontate per codice e valore duplicato, `broken-links` come issue di pagina.

## 6.4 Tipi di differenza

| Tipo | Severità | Condizione |
|---|---|---|
| `page-removed` | **error** se la pagina in Base era 2xx, altrimenti info | Pagina presente solo in Base. |
| `page-added` | info se 2xx, altrimenti warn | Pagina presente solo in Head. |
| `page-mapped` | info | Abbinamento tramite redirect map. |
| `mapped-target-missing` | **error** | Destinazione della redirect map assente in Head. |
| `status-changed` | **error** se da 2xx a 4xx/5xx/errore; info se torna 2xx o resta nella stessa classe; warn negli altri casi (es. 2xx → 3xx) | Status o presenza di errore diversi. |
| `redirect-changed` | warn | Destinazione finale dei redirect diversa (o redirect comparso/sparito). |
| `title-changed` | warn | |
| `description-changed` | warn | |
| `h1-changed` | warn | Elenco degli H1 diverso. |
| `canonical-changed` | warn | |
| `lang-changed` | warn | |
| `robots-changed` | **error** se compare `noindex`, altrimenti warn | |
| `hreflang-changed` | info | Insieme degli alternate diverso. |
| `content-changed` | warn se la variazione del numero di parole ≥ `contentWarnRatio`, altrimenti info | Hash del testo diverso. Il messaggio riporta parole prima/dopo e variazione percentuale. |
| `links-changed` | warn se perde più del 20% dei link interni, altrimenti info | Link interni aggiunti o persi (fino a 50 per lato nel dettaglio). |
| `perf-regression` | warn | Tempo Head ≥ `perfMinMs`, > `perfFactor` × tempo Base e con un aumento > `perfMinDeltaMs`. |
| `issue-new` | severità della issue | |
| `issue-resolved` | info | |
| `visual-changed` | warn se la quota di pixel diversi ≥ `visualWarn`; info se ≥ `visualInfo` o se cambiano le dimensioni | Solo con confronto visivo (§6.6). |

`compare.ignore` elimina i tipi elencati dal risultato e dai conteggi.

## 6.5 Soglie

| Soglia | Default |
|---|---|
| `contentWarnRatio` | 0.3 (30%) |
| `perfFactor` | 2 |
| `perfMinDeltaMs` | 500 |
| `perfMinMs` | 1000 |
| `visualWarn` | 0.005 (0,5% dei pixel) |
| `visualInfo` | 0.0001 (0,01% dei pixel) |

## 6.6 Confronto visivo

| ID | Requisito |
|---|---|
| RF-DIFF-30 | Per ogni coppia di pagine con screenshot in entrambe le scan si calcola la quota di pixel diversi. |
| RF-DIFF-31 | Immagini di dimensioni diverse vengono estese con bianco alla dimensione maggiore prima del confronto; il cambio di dimensioni è riportato nel messaggio. |
| RF-DIFF-32 | Un errore nel confronto di una coppia viene segnalato e non interrompe il confronto. |

## 6.7 Risultato

| Campo | Contenuto |
|---|---|
| `base`, `head` | id, ambiente, label, data di avvio, numero di pagine. |
| `summary` | Conteggi `error`, `warn`, `info`, `added`, `removed`, `changed`, `unchanged`, `findings`. |
| `pairs[]` | Per ogni pagina: chiave, chiave in Base, chiave in Head, stato, abbinamento da redirect map. |
| `findings[]` | `type`, `severity`, `key` (chiave in Head, o in Base se rimossa), `baseKey` se diversa, `message` leggibile, e quando utile `base`/`head` (valori prima/dopo) e `code` (per le issue). |

Le differenze sono ordinate per severità decrescente, poi per chiave di pagina, poi per tipo.

Esito: con `--fail-on <livello>` il confronto **fallisce** se esiste almeno una differenza di severità pari o superiore al livello (`error` > `warn` > `info`).
