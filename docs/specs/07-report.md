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
| RF-UI-10 | Barra superiore con: selettore del sito (con numero di scan), selettore Base, pulsante per invertire Base e Head, selettore Head, caricamento della redirect map. |
| RF-UI-11 | I selettori di scan elencano le scan dalla più recente, con data e ora, ambiente, label e ultime 4 cifre dell'id. |
| RF-UI-12 | Default: Head è la scan più recente; Base è la scan precedente dello **stesso ambiente**, altrimenti la precedente in assoluto, altrimenti la stessa scan. Nel bundle di export valgono le scan preselezionate. |
| RF-UI-13 | Sito, Base, Head, scheda attiva e pagina aperta sono riflessi nel frammento dell'URL (`#site=…&base=…&head=…&tab=…&page=…`) e ripristinati all'apertura, così un link riporta alla stessa vista. |
| RF-UI-14 | Ogni cambio di selezione ricalcola il confronto nel browser. |

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
| RF-UI-32 | **Contatori**: pagine Base → Head, error, warn, info, cambiate, aggiunte, rimosse, invariate. I contatori di severità aprono «Differenze» filtrate su quella severità; quelli di stato aprono «Pagine» filtrate su quello stato. |
| RF-UI-33 | Con Base = Head viene mostrato un suggerimento a scegliere due scan diverse. |

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
| RF-UI-71 | Tabella delle scan dalla più recente: data, id, nota, ambiente, label, pagine, E/W/I, e pulsanti per impostarla come Base o Head. |

## 7.5 Dettaglio pagina

Si apre cliccando una pagina in qualsiasi scheda; si chiude con il pulsante ✕, cliccando fuori o con Esc.

| ID | Requisito |
|---|---|
| RF-UI-80 | Intestazione con chiave e stato della pagina. |
| RF-UI-81 | Elenco delle differenze della pagina. |
| RF-UI-82 | Tabella di confronto Base/Head con: URL (cliccabile), status, redirect, content-type, title, description, H1, canonical, meta robots, lang, heading, parole, hash del testo, link interni ed esterni, immagini (senza alt), hreflang, OG title e image, tempo di risposta, dimensione, profondità. Le righe diverse sono evidenziate (tempo, dimensione e profondità esclusi). |
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
