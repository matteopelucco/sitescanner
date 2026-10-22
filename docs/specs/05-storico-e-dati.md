# 5. Storico e dati

## 5.1 Struttura su disco

```
data/<sito>/scans/<scanId>/scan.json          istantanea
data/<sito>/scans/<scanId>/text.json          testo per pagina (se storeText)
data/<sito>/scans/<scanId>/screenshots/*.png  (se screenshot)
data/<sito>/scans/<scanId>/html/*.html        (se --keep-html)
data/<sito>/labels.json                       label e note modificate dopo la scan
```

| ID | Requisito |
|---|---|
| RF-DATA-01 | L'id di una scan ha la forma `AAAAMMGGTHHMMSSZ-xxxx` (data e ora UTC di avvio più 4 caratteri esadecimali casuali), così l'ordine alfabetico coincide con quello cronologico. |
| RF-DATA-02 | I file di screenshot e HTML sono nominati con un hash della chiave di pagina, quindi la stessa pagina ha lo stesso nome file in scan diverse. |

## 5.2 Immutabilità

| ID | Requisito |
|---|---|
| RF-DATA-10 | Durante la scan i file vengono scritti in una cartella temporanea `.<scanId>.partial`. Solo a scan completata la cartella viene rinominata nel suo nome definitivo. |
| RF-DATA-11 | Prima della rinomina tutti i file dell'istantanea sono resi di sola lettura. *(test e2e)* |
| RF-DATA-12 | In caso di errore o interruzione la cartella temporanea viene eliminata; le cartelle che iniziano con `.` non sono mai considerate scan. |
| RF-DATA-13 | Nessun comando modifica o cancella un'istantanea. |
| RF-DATA-14 | `scan.json` contiene, oltre a pagine e issue: versione dello schema (`schema: 1`), id, sito e nome, ambiente e `baseUrl`, label e nota iniziali, date di inizio e fine, durata, nome e versione del tool, opzioni effettive (maxPages, screenshot, keepHtml, testo), hash del file di configurazione, **copia della configurazione** con credenziali e header sensibili (nomi contenenti `auth`, `cookie`, `token`, `key`) sostituiti da `***`, dati del crawling (URL da sitemap, URL non visitati, troncamento) e statistiche. |

## 5.3 Label e note

| ID | Requisito |
|---|---|
| RF-DATA-20 | Label e nota passate a `scan` sono salvate nell'istantanea. |
| RF-DATA-21 | Le modifiche successive (`label`) sono salvate in `data/<sito>/labels.json` con data di aggiornamento; la scrittura è atomica (file temporaneo + rinomina). |
| RF-DATA-22 | In lettura, i valori di `labels.json` prevalgono su quelli dell'istantanea, in tutti i comandi e nel report. |
| RF-DATA-23 | Più scan possono avere la stessa label. |

## 5.4 Riferimenti a una scan

Le opzioni `--scan`, `--base`, `--head` accettano, in quest'ordine di risoluzione:

| Forma | Esempio | Risolve in |
|---|---|---|
| `latest` | `latest` | La scan più recente del sito. |
| `latest~N` | `latest~1` | La N-esima scan prima della più recente. |
| id completo | `20261022T123127Z-bd7a` | Quella scan. |
| label | `v1` | La scan **più recente** con quella label. |
| prefisso dell'id | `20261022T1231` | L'unica scan il cui id inizia così. |

| ID | Requisito |
|---|---|
| RF-DATA-30 | Un prefisso che corrisponde a più scan è un errore d'uso che elenca le scan candidate. |
| RF-DATA-31 | Un riferimento che non corrisponde a nulla, o un sito senza scan, è un errore d'uso che ricorda le forme ammesse. *(test e2e)* |
| RF-DATA-32 | Le scan sono ordinate per data di avvio e poi per id. |
