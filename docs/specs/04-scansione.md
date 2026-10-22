# 4. Scansione

## 4.1 Perimetro del crawling

| ID | Requisito |
|---|---|
| RF-CRAWL-01 | Il crawler visita solo URL con la stessa origine di `baseUrl` e un path che inizia con il prefisso di `baseUrl` (es. con `baseUrl` `https://x.it/it/` resta sotto `/it/`). |
| RF-CRAWL-02 | Punti di partenza: gli URL di `start` (profondità 0) e, se `sitemap` è attivo, gli URL delle sitemap (profondità 1). |
| RF-CRAWL-03 | Sitemap: con `sitemap: true` si leggono `sitemap.xml` sotto il prefisso di `baseUrl` e le sitemap dichiarate in `robots.txt`; gli indici di sitemap vengono seguiti (massimo 50 file). Gli URL delle sitemap vengono **riportati sull'origine dell'ambiente scansionato**, perché le sitemap di stage elencano spesso URL di produzione. *(test e2e: `/hidden`)* |
| RF-CRAWL-04 | Da ogni pagina HTML con status < 400 si seguono i link `<a href>` che restano nel perimetro, esclusi `rel="nofollow"`, `javascript:`, `mailto:`, `tel:`, `data:` e ancore, fino a `maxDepth`. `<base href>` è rispettato. |
| RF-CRAWL-05 | Ogni URL è identificato dalla sua **chiave di pagina**: path + query con i parametri ordinati alfabeticamente e i parametri `utm_*` rimossi; il frammento è ignorato; con `ignoreQuery` la query è scartata. Ogni chiave viene visitata una sola volta. |
| RF-CRAWL-06 | Si escludono le chiavi che non soddisfano `include` (se presente), che soddisfano `exclude` o, con `respectRobots`, vietate da `robots.txt` (gruppi `User-agent` specifici per lo user agent configurato, altrimenti `*`; regole `Allow`/`Disallow` con `*` e `$`; vince la regola più lunga, `Allow` a parità). *(test e2e: `/private/x`)* |
| RF-CRAWL-07 | Il crawling procede **per livelli di profondità**; all'interno di un livello le chiavi sono visitate in ordine alfabetico. Il totale di URL visitati non supera `maxPages`; gli URL scoperti e non visitati vengono contati (`crawl.unvisited`) e la scan è marcata come troncata. |
| RF-CRAWL-08 | I redirect sono seguiti manualmente (al massimo 10) registrando la catena. Se la destinazione esce dal perimetro ci si ferma e la pagina è marcata `offsite`. Se la destinazione è nel perimetro e ha una chiave diversa, viene accodata come pagina a sé. Il contenuto di una pagina che redirige non viene analizzato. |
| RF-CRAWL-09 | Il body viene scaricato e analizzato solo per risposte HTML senza redirect; per gli altri tipi si registrano status, content-type ed eventuale `Content-Length`. Si analizzano al massimo 10 MB di HTML. |
| RF-CRAWL-10 | Basic auth e header configurati vengono inviati a ogni richiesta, comprese quelle a `robots.txt` e sitemap. |

## 4.2 Dati raccolti per pagina

| Campo | Descrizione |
|---|---|
| `key`, `url`, `depth`, `foundFrom` | Chiave, URL visitato, profondità, chiave della pagina in cui è stato trovato. |
| `status`, `finalStatus`, `finalUrl`, `redirects[]`, `offsite` | Status della prima risposta, status e URL finali, catena di redirect (`url`, `status`, `location`). |
| `error` | Errore di rete o timeout (al posto dello status). |
| `contentType`, `isHtml`, `bytes`, `etag`, `responseMs` | Metadati della risposta; `responseMs` è il tempo totale incluso il download. |
| `title`, `description`, `robots`, `canonical`, `canonicalKey`, `lang`, `viewport` | Metadati HTML (entità decodificate, spazi normalizzati, canonical risolto in URL assoluto). |
| `h1[]`, `headings` | Testi degli H1 e numero di heading per livello. |
| `hreflang[]`, `og` | Alternate linguistici (`lang`, `href`) e Open Graph (`title`, `description`, `image`). |
| `wordCount`, `textHash` | Parole del testo visibile e hash del testo. |
| `links.internal[]`, `links.external` | Chiavi dei link interni (ordinate, senza duplicati) e numero di link esterni. |
| `images.total`, `images.missingAlt` | Immagini e immagini senza attributo `alt`. |
| `mixedContent` | Risorse `http://` su pagina `https://`. |
| `screenshot`, `screenshotError`, `html` | Percorsi relativi di screenshot e HTML salvato, o errore dello screenshot. |
| `issues[]` | Issue della pagina (§4.4). |

Il **testo visibile** è estratto dal `<body>` escludendo `script`, `style`, `noscript`, `template`, `svg`, `iframe`; ogni elemento di blocco produce una riga. Con `storeText` il testo è salvato separatamente (`text.json`).

## 4.3 Screenshot

| ID | Requisito |
|---|---|
| RF-SHOT-01 | Se abilitati, dopo il crawling si cattura uno screenshot PNG di ogni pagina HTML con status 2xx, con Chromium headless, alla larghezza configurata, a pagina intera limitata a `maxHeight`. |
| RF-SHOT-02 | Prima dello scatto si disattivano animazioni, transizioni e cursore, si nascondono i selettori `hide`, si attende il caricamento, poi fino a 5 s che la rete sia inattiva, poi `waitMs`. |
| RF-SHOT-03 | Credenziali e header dell'ambiente sono usati anche dal browser. |
| RF-SHOT-04 | L'errore su una pagina è registrato in `screenshotError` e non interrompe la scan. |
| RF-SHOT-05 | Se Playwright non è installato o Chromium non si avvia, la scan prosegue senza screenshot, con un avviso; l'istantanea registra il motivo (`options.screenshotsSkipped`). |

## 4.4 Issue di qualità

Calcolate su ogni scan, indipendentemente dal confronto.

**Per pagina**

| Codice | Severità | Condizione |
|---|---|---|
| `fetch-failed` | error | Errore di rete o timeout (esclude le altre regole). |
| `http-5xx` / `http-4xx` | error | Status ≥ 500 / ≥ 400. |
| `redirect-broken` | error | La catena di redirect termina con status ≥ 400. |
| `redirect-chain` | warn | Più di un redirect. |
| `slow-response` | warn | `responseMs` > 2000. |
| `title-missing` | warn | Title assente o vuoto. |
| `title-too-long` | info | Title oltre 65 caratteri. |
| `description-missing` | warn | Meta description assente. |
| `description-too-long` | info | Description oltre 170 caratteri. |
| `h1-missing` | warn | Nessun H1. |
| `h1-multiple` | info | Più di un H1. |
| `img-alt-missing` | warn | Almeno un'immagine senza `alt`. |
| `mixed-content` | warn | Risorse `http://` su pagina `https://`. |
| `noindex` | info | Meta robots contiene `noindex`. |
| `canonical-missing` | info | Nessun link canonical. |
| `canonical-other` | info | Canonical verso un'altra pagina. |
| `lang-missing` | info | `<html>` senza `lang`. |
| `viewport-missing` | info | Meta viewport assente. |
| `page-heavy` | info | HTML oltre 3 MB. |

Le regole sui contenuti si applicano solo a pagine HTML con status < 300.

**Tra pagine**

| Codice | Severità | Condizione |
|---|---|---|
| `broken-links` | error | La pagina linka pagine interne visitate con errore, status ≥ 400 o redirect verso status ≥ 400. Solo le pagine effettivamente visitate sono verificabili. |
| `title-duplicate` | warn | Stesso title (senza distinzione di maiuscole) su più pagine 200 indicizzabili e canoniche. |
| `description-duplicate` | info | Come sopra per la description. |

## 4.5 Esito della scan

| ID | Requisito |
|---|---|
| RF-SCAN-20 | Se non viene visitata alcuna pagina, o se tutte le pagine sono in errore di rete, la scan fallisce e **non** viene salvata. |
| RF-SCAN-21 | Altrimenti la scan viene salvata come istantanea (§5) con statistiche: pagine, pagine HTML, conteggio per classe di status (`2xx`, `3xx`, `4xx`, `5xx`, `fail`), issue per severità, tempo medio di risposta, numero di screenshot. |
