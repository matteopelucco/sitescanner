# 7. Report HTML

## 7.1 Generazione e distribuzione

| ID | Requisito |
|---|---|
| RF-UI-01 | Il report è una pagina HTML5 statica (`index.html`) con stili e script inclusi, più una cartella `data/` con l'indice di siti e scan e un file per scan (e uno per il testo, se presente). Non usa librerie esterne né richieste di rete verso l'esterno. |
| RF-UI-02 | Il report DEVE funzionare aperto da file (`file://`), servito da `sitescanner serve` e, per un bundle di `export`, dopo essere stato spostato. |
| RF-UI-03 | I dati di una scan sono caricati solo quando la scan viene selezionata. |
| RF-UI-04 | Gli screenshot sono referenziati: nel report standard puntano a `data/` del progetto (path relativo), nel bundle sono copiati nella cartella `assets/`. |
| RF-UI-05 | Il piè di pagina mostra versione del tool e data di generazione. |

## 7.2 Selezione di sito e scan

| ID | Requisito |
|---|---|
| RF-UI-10 | Barra superiore con: selettore del sito (con numero di scan), selettore Base, pulsante per invertire Base e Head, selettore Head, caricamento della redirect map, pulsante PDF (§7.8). |
| RF-UI-11 | I selettori di scan elencano le scan dalla più recente, con data e ora, ambiente, label e ultime 4 cifre dell'id. Il selettore Head ha in più, in testa, la voce «— nessuna: diagnostica di Base —». |
| RF-UI-12 | Default: Head è la scan più recente; Base è la scan precedente dello **stesso ambiente**, altrimenti la precedente in assoluto. Se il sito ha una sola scan, quella è Base e Head resta vuota (vista diagnostica). Nel bundle di export valgono le scan preselezionate. |
| RF-UI-13 | Sito, Base, Head, scheda attiva e pagina aperta sono riflessi nel frammento dell'URL (`#site=…&base=…&head=…&tab=…&page=…`) e ripristinati all'apertura, così un link riporta alla stessa vista. Un frammento con `base` e senza `head` (o con `head` vuoto) apre la vista diagnostica di Base. |
| RF-UI-14 | Ogni cambio di selezione ricalcola il confronto (o la diagnostica) nel browser. |
| RF-UI-15 | **Head vuota** → vista diagnostica della sola scan Base (§7.7); **Base e Head** → vista di confronto (§7.4). Con Head vuota il pulsante per invertire è disabilitato. |

## 7.3 Redirect map nel report

| ID | Requisito |
|---|---|
| RF-UI-20 | Il pulsante «Redirect map…» permette di scegliere un file CSV (formato §6.2); il confronto è ricalcolato con la mappa. |
| RF-UI-21 | Con una mappa caricata il pulsante mostra nome del file e numero di voci; cliccandolo la mappa viene rimossa. |

## 7.4 Vista di confronto

| ID | Requisito |
|---|---|
| RF-UI-30 | **Esito**: «Regressioni» se ci sono error, «Da verificare» se ci sono solo warn, «Nessuna regressione» altrimenti, «Stessa scan» se Base = Head; con il conteggio per severità. |
| RF-UI-31 | **Schede scan**: per Base e Head data, ambiente, label, id, `baseUrl`, numero di pagine, troncamento, presenza di screenshot, nota. |
| RF-UI-32 | **Contatori**: pagine Base → Head, health score Base → Head (§4.4), error, warn, info, cambiate, aggiunte, rimosse, invariate. I contatori di severità aprono «Differenze» filtrate su quella severità; quelli di stato aprono «Pagine» filtrate su quello stato. |
| RF-UI-33 | Con Base = Head viene mostrato un suggerimento a scegliere due scan diverse o a lasciare Head vuota per la diagnostica. |

### Scheda «Differenze»

| ID | Requisito |
|---|---|
| RF-UI-40 | Tabella delle differenze con severità, tipo (descrizione in italiano), pagina (con chiave di origine se rimappata) e dettaglio. |
| RF-UI-41 | Filtri combinabili: severità (attivabili singolarmente, con conteggio), tipo (solo tipi presenti, con conteggio), ricerca testuale su pagina, messaggio e tipo. |
| RF-UI-42 | Vengono mostrate 200 righe; «Mostra altri» ne aggiunge 500 alla volta. |

### Scheda «Pagine»

| ID | Requisito |
|---|---|
| RF-UI-50 | Tabella di tutte le pagine abbinate con stato, status in Base e in Head, title e conteggio delle differenze per severità. |
| RF-UI-51 | Filtri per stato (con conteggio) e per path. Stessa paginazione di RF-UI-42. |

### Scheda «Issue»

| ID | Requisito |
|---|---|
| RF-UI-60 | Tabella delle issue di qualità per codice, con severità, numero di occorrenze in Base e in Head e delta (aumento evidenziato come peggioramento). |
| RF-UI-61 | Cliccando un codice si espandono le pagine di Head che lo presentano (con messaggio), o l'indicazione che è stato risolto. |

### Scheda «Storico»

| ID | Requisito |
|---|---|
| RF-UI-70 | Grafico dell'andamento di error e warning (scala comune) e pagine (scala propria) su tutte le scan del sito, con Base e Head evidenziate. Mostrato con almeno due scan. |
| RF-UI-71 | Tabella delle scan dalla più recente: data, id, nota, ambiente, label, pagine, health score, E/W/I, e pulsanti per impostarla come Base, come Head o come scan unica («Solo», vista diagnostica). |

## 7.5 Dettaglio pagina

Si apre cliccando una pagina in qualsiasi scheda; si chiude con il pulsante ✕, cliccando fuori o con Esc.

| ID | Requisito |
|---|---|
| RF-UI-80 | Intestazione con chiave e stato della pagina. |
| RF-UI-81 | Elenco delle differenze della pagina. |
| RF-UI-82 | Tabella di confronto Base/Head con: URL (cliccabile), status, redirect, content-type, title, description, H1, canonical, meta robots, lang, heading, parole, hash del testo, link interni ed esterni, immagini (senza alt), hreflang, OG title e image, tempo di risposta, dimensione, profondità di crawl e di click, indicizzabilità, `X-Robots-Tag`, dati strutturati. Le righe diverse sono evidenziate (tempo, dimensione e profondità esclusi). |
| RF-UI-83 | Issue della pagina in Base e in Head affiancate. |
| RF-UI-84 | Screenshot con modalità: **affiancati**, **slider** (sovrapposizione con cursore), **differenza** (fusione «difference»: nero dove identici), **pixel diff** (pixel diversi evidenziati, con percentuale e dimensioni), **solo Base**, **solo Head**, più link per aprire le immagini. Con un solo screenshot disponibile si mostra solo quello; senza screenshot si mostra il motivo, se noto. |
| RF-UI-85 | Il pixel diff da `file://` non è disponibile per restrizioni del browser: viene mostrato un messaggio che indica `sitescanner serve` o la modalità «differenza». |
| RF-UI-86 | Se entrambe le scan hanno il testo salvato, diff riga per riga del testo visibile con righe aggiunte e rimosse evidenziate, 2 righe di contesto, righe invariate raggruppate («… N righe invariate») e totale righe aggiunte/rimosse; «Testo identico» se non cambia. |

## 7.6 Presentazione

| ID | Requisito |
|---|---|
| RF-UI-90 | Tema chiaro e scuro secondo la preferenza del sistema. |
| RF-UI-91 | A larghezze ridotte (≤ 760 px) selettori, schede scan e screenshot si impilano in colonna e le tabelle scorrono orizzontalmente. |
| RF-UI-92 | Tutti i contenuti provenienti dai siti scansionati sono trattati come testo (escape HTML), mai come markup. |

## 7.7 Vista diagnostica di una singola scan

Si ottiene lasciando vuota Head (RF-UI-15). Mostra lo stato di qualità di una scan, senza confronto. La logica è nel modulo puro `src/core/diagnose.js`, condiviso tra report e CLI come quello di confronto. *(test `test/diagnose.test.js`)*

| ID | Requisito |
|---|---|
| RF-UI-100 | **Esito**: «Errori da correggere» se la scan ha issue `error`, «Da verificare» se ha solo `warn`, «Nessun problema» altrimenti, con health score e conteggio delle issue per severità. |
| RF-UI-101 | **Schede**: la scan (data, ambiente, label, id, `baseUrl`, pagine, troncamento, screenshot, nota) e il crawl (durata, tempo medio di risposta, pagine per classe di status, URL da sitemap, URL non visitati per `maxPages`). |
| RF-UI-102 | **Contatori**: pagine, health score (apre le pagine con error), pagine indicizzabili (e percentuale; apre le non indicizzabili), pagine con issue (e percentuale), error, warn, info, 2xx, 3xx, 4xx + 5xx, non raggiungibili. I contatori di severità aprono «Issue» filtrata su quella severità; gli altri aprono «Pagine» con il filtro corrispondente. |
| RF-UI-103 | Le schede disponibili sono «Issue», «Pagine» e «Storico» (come RF-UI-70/71); la scheda predefinita è «Issue». |
| RF-UI-104 | **Issue**: tabella delle issue di qualità per codice, con severità, descrizione in italiano, codice, categoria, numero di occorrenze e di pagine coinvolte, ordinata per severità e poi per occorrenze. Filtri per severità (con conteggio), per categoria e ricerca su codice, descrizione, pagina e messaggio. |
| RF-UI-105 | Cliccando una issue si espandono le occorrenze: per le issue di pagina la pagina con il messaggio, per quelle di sito (duplicati) il messaggio e l'elenco delle pagine coinvolte; ogni pagina apre il dettaglio. Al massimo 300 occorrenze, poi un invito a restringere la ricerca. |
| RF-UI-106 | **Pagine**: tabella di tutte le pagine con status, motivo di non indicizzabilità, title, profondità di click, numero di link interni entranti e conteggio delle issue per severità (incluse le issue di sito che coinvolgono la pagina), dalla peggiore. Filtri per classe di status (con conteggio), per indicizzabilità e presenza di issue (non indicizzabili, con issue, con error/warning/info, senza issue) e per path o title. Paginazione come RF-UI-42. |
| RF-UI-107 | **Dettaglio pagina** (si apre e chiude come §7.5): issue della pagina e issue di sito che la coinvolgono; tabella con URL e gli stessi campi di RF-UI-82 per la sola scan; link interni entranti e in uscita (cliccabili, al massimo 200); screenshot singolo (o il motivo dell'assenza); testo visibile della pagina, se la scan lo ha salvato. |

## 7.8 Export PDF

Il PDF è generato da un **documento di stampa** (`src/core/print.js`, modulo puro condiviso come il confronto): HTML A4 con CSS paged media, lo stesso sia per Chromium headless sia per la stampa del browser. Motivazioni in [ADR-0015](../adr/0015-pdf-da-documento-di-stampa-condiviso-con-css-paged-media.md). *(test `test/print.test.js`, `test/e2e.test.js`)*

| ID | Requisito |
|---|---|
| RF-PDF-01 | Due tipi di documento: **report di qualità** (sola Base, la diagnostica di §7.7) e **report di regressione** (Base + Head, il confronto di §7.4), scelti come nel report: Head vuota → qualità. |
| RF-PDF-02 | **Copertina** (senza intestazione): tipo di report, nome del sito, `baseUrl` (di Base e Head se diversi), esito con conteggi per severità, health score (Base → Head nel confronto), schede delle scan (data, ambiente, label, id, pagine, troncamento, nota), sommario delle sezioni, data di generazione e versione del tool. |
| RF-PDF-03 | Ogni pagina successiva ha **intestazione** (sito a sinistra; tipo di report e data delle scan a destra) e **piè di pagina** «Pagina N di M». Formato A4. |
| RF-PDF-04 | Report di qualità: 1. Sintesi (health score, pagine, indicizzabili, con issue, error/warn/info, risposta media, barra degli status HTTP, issue per categoria); 2. Issue rilevate (tutte, per codice); 3. Dettaglio di errori e warning (per codice, fino a 25 occorrenze); 4. Pagine con più problemi (fino a 40); 5. Pagine non indicizzabili con il motivo (fino a 80). |
| RF-PDF-05 | Report di regressione: 1. Sintesi (pagine, health score, differenze, stati delle pagine, redirect map usata, differenze per tipo e severità); 2. Regressioni (error) e 3. Da verificare (warning), fino a 400 righe ciascuna; 4. Pagine aggiunte e rimosse (fino a 100 ciascuna); 5. Issue di qualità Base → Head con delta. Le differenze info sono solo riassunte. |
| RF-PDF-06 | Impaginazione: le sezioni principali iniziano su una nuova pagina, i titoli non restano soli in fondo alla pagina, le righe delle tabelle e i riquadri non si spezzano, l'intestazione delle tabelle si ripete su ogni pagina, colonne a larghezza fissa, URL lunghi mandati a capo. Gli elenchi troncati terminano con «… e altre N», che rimanda al report interattivo. |
| RF-PDF-07 | Tutti i contenuti dei siti sono trattati come testo (escape HTML, e nelle stringhe CSS di intestazione). |
| RF-PDF-08 | Il PDF generato con Chromium ha i segnalibri dei titoli (outline) ed è taggato per l'accessibilità. |
| RF-PDF-09 | Nel report il pulsante **PDF** esporta la vista corrente: servito da `sitescanner ui` scarica il PDF generato dal server (§8, `GET /api/pdf`); da file, da un bundle di export, se il server non può generarlo (Playwright assente) o con una redirect map caricata, apre il documento di stampa in una nuova finestra e avvia la stampa del browser («Salva come PDF»). |
