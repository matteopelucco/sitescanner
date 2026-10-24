# 4. Scansione

## 4.1 Perimetro del crawling

| ID | Requisito |
|---|---|
| RF-CRAWL-01 | Il crawler visita solo URL con la stessa origine di `baseUrl` e un path che inizia con il prefisso di `baseUrl` (es. con `baseUrl` `https://x.it/it/` resta sotto `/it/`). |
| RF-CRAWL-02 | Punti di partenza: gli URL di `start` (profondità 0) e, se `sitemap` è attivo, gli URL delle sitemap (profondità 1). |
| RF-CRAWL-03 | Sitemap: con `sitemap: true` si leggono `sitemap.xml` sotto il prefisso di `baseUrl` e le sitemap dichiarate in `robots.txt`; gli indici di sitemap vengono seguiti (massimo 50 file). Gli URL delle sitemap vengono **riportati sull'origine dell'ambiente scansionato**, perché le sitemap di stage elencano spesso URL di produzione. *(test e2e: `/hidden`)* |
| RF-CRAWL-04 | Da ogni pagina HTML con status < 400 si seguono i link `<a href>` che restano nel perimetro, esclusi `rel="nofollow"`, `javascript:`, `mailto:`, `tel:`, `data:` e ancore, fino a `maxDepth`. `<base href>` è rispettato. |
| RF-CRAWL-05 | Ogni URL è identificato dalla sua **chiave di pagina**: path + query con i parametri ordinati alfabeticamente e senza parametri di tracciamento; il frammento è ignorato; con `ignoreQuery` la query è scartata. Ogni chiave viene visitata una sola volta. Parametri di tracciamento predefiniti: `utm_*`, `gclid`, `gclsrc`, `dclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `yclid`, `twclid`, `ttclid`, `li_fat_id`, `mc_cid`, `mc_eid`, `_ga`, `_gl`, `mkt_tok`, `srsltid`, `intcmp`, `icid`, `cmpid`, più quelli di `ignoreParams`. |
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
| `links.internal[]`, `links.external`, `links.nofollow` | Chiavi dei link interni (ordinate, senza duplicati), numero di link esterni e di link interni nofollow. |
| `clickDepth` | Profondità di click: clic minimi dagli URL di partenza (null se non raggiungibile dai link). |
| `indexable`, `indexability` | Indicizzabilità e motivo dell'esclusione (§4.4). |
| `xRobots`, `compressed`, `securityHeaders[]`, `charset` | Header `X-Robots-Tag`, presenza di `Content-Encoding`, header di sicurezza presenti (`hsts`, `csp`, `xcto`, `xfo`, `referrer`), charset dal meta o dall'header. |
| `titleCount`, `descriptionCount`, `canonicalCount`, `canonicalRelative`, `headingSkip`, `metaRefresh`, `doctype` | Dati per le regole su duplicazioni nel documento, heading e struttura HTML. |
| `structuredData` | Tipi JSON-LD (`@type`, anche dentro `@graph`) e numero di blocchi non validi. |
| `anchors`, `a11y`, `domNodes`, `insecureForms`, `placeholderText` | Link senza testo o con testo generico, campi/pulsanti/iframe senza nome accessibile, elementi del DOM, form insicuri, testo segnaposto. |
| `redirectLoop` | Il redirect è in loop o supera 10 passaggi. |
| `images.total`, `images.missingAlt`, `images.missingSize` | Immagini, immagini senza attributo `alt` e senza `width`/`height`. |
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

Calcolate su ogni scan, indipendentemente dal confronto. Il catalogo completo (codice, severità predefinita, categoria, descrizione) è `ISSUE_TYPES` in `src/core/diagnose.js`; la ricerca che lo ha motivato è in [docs/research/controlli-di-qualita.md](../research/controlli-di-qualita.md). Le soglie sono configurabili in `quality` (§4.6). *(test `test/analyze.test.js`)*

**Indicizzabilità.** Ogni pagina ha `indexable` e, se non indicizzabile, il motivo (`indexability`), nel primo caso che si applica: non raggiungibile, redirect, status ≥ 400, non HTML, meta robots `noindex`/`none`, `X-Robots-Tag` `noindex`/`none`, canonical verso un'altra pagina. Diverse regole valgono solo per le pagine indicizzabili.

**Per pagina**

| Codice | Severità | Condizione |
|---|---|---|
| `fetch-failed` | error | Errore di rete o timeout (esclude le altre regole). |
| `http-5xx` / `http-4xx` | error | Status ≥ 500 / ≥ 400. |
| `soft-404` | warn | Status 200 ma title o H1 da pagina di errore («404», «not found», «pagina non trovata»…). |
| `redirect-broken` | error | La catena di redirect termina con status ≥ 400. |
| `redirect-loop` | error | Il redirect torna su un URL già visitato o supera 10 passaggi. |
| `redirect-chain` | warn | Più di un redirect (senza loop). |
| `redirect-temporary` | info | Il primo redirect è 302, 303 o 307. |
| `meta-refresh` | warn | La pagina contiene `<meta http-equiv="refresh">`. |
| `slow-response` | warn | `responseMs` > `slowMs` (2000). |
| `title-missing` | warn | Title assente o vuoto (i `<title>` dentro SVG non contano). |
| `title-too-long` / `title-too-short` | info | Title oltre `titleMax` (65) / sotto `titleMin` (30) caratteri. |
| `title-multiple` | warn | Più tag `<title>`. |
| `description-missing` | warn | Meta description assente. |
| `description-too-long` / `description-too-short` | info | Oltre `descriptionMax` (170) / sotto `descriptionMin` (70) caratteri. |
| `description-multiple` | warn | Più meta description. |
| `h1-missing` | warn | Nessun H1. |
| `h1-multiple` | info | Più di un H1. |
| `heading-skip` | info | Nella sequenza degli heading si scende di più di un livello (es. h2 → h4). |
| `noindex` | info | Meta robots contiene `noindex`. |
| `x-robots-noindex` | info | Header `X-Robots-Tag` con `noindex` o `none`. |
| `nofollow-page` | info | Meta robots o `X-Robots-Tag` con `nofollow` o `none`. |
| `canonical-missing` | info | Nessun link canonical. |
| `canonical-other` | info | Canonical verso un'altra pagina. |
| `canonical-multiple` | error | Più link canonical con URL diversi. |
| `canonical-relative` | info | Canonical con URL relativo. |
| `thin-content` | info | Pagina indicizzabile con meno di `thinWords` (200) parole. |
| `placeholder-text` | warn | Il testo contiene «lorem ipsum» o «dolor sit amet». |
| `structured-data-invalid` | error | Blocchi JSON-LD che non sono JSON valido. |
| `og-missing` | info | Pagina indicizzabile senza `og:title` o `og:image`. |
| `hreflang-invalid` | warn | Codici hreflang che non sono `lingua[-Script][-REGIONE]` o `x-default`. |
| `hreflang-self-missing` | info | Gli hreflang non includono la pagina stessa. |
| `hreflang-x-default-missing` | info | Ci sono hreflang ma nessun `x-default`. |
| `img-alt-missing` | warn | Almeno un'immagine senza `alt`. |
| `img-no-dimensions` | info | Immagini senza `width` e `height` (rischio di layout shift). |
| `input-no-label` | warn | Campi di form (esclusi hidden e pulsanti) senza `label`, `aria-label`, `aria-labelledby` o `title`. |
| `button-no-name` | warn | Pulsanti senza testo, `aria-label`, `title` o immagine con alt. |
| `iframe-no-title` | info | Iframe senza `title`. |
| `anchor-empty` | info | Link senza testo, alt dell'immagine, `aria-label` o `title`. |
| `anchor-generic` | info | Link con testo generico («clicca qui», «leggi di più», «read more»…). |
| `nofollow-internal` | info | Link interni con `rel="nofollow"`. |
| `mixed-content` | warn | Risorse `http://` su pagina `https://`. |
| `form-insecure` | warn | Form con `action` `http://` su pagina `https://`. |
| `compression-missing` | info | HTML oltre 1400 byte servito senza `Content-Encoding`. |
| `page-heavy` | info | HTML oltre 3 MB. |
| `dom-large` | info | Più di `maxDomNodes` (1500) elementi. |
| `lang-missing` | info | `<html>` senza `lang`. |
| `viewport-missing` | info | Meta viewport assente. |
| `doctype-missing` | info | Documento senza `<!doctype html>`. |
| `charset-missing` | info | Charset non dichiarato né nel meta né nell'header `Content-Type`. |
| `url-uppercase` / `url-underscore` | info | Path con maiuscole / underscore. |
| `url-too-long` | info | URL oltre `maxUrlLength` (115) caratteri. |
| `url-malformed` | info | Path con doppio slash o spazi. |

Le regole sui contenuti si applicano solo a pagine HTML con status < 300; le regole sugli URL a tutte le pagine raggiungibili.

**Tra pagine**

| Codice | Severità | Condizione |
|---|---|---|
| `broken-links` | error | La pagina linka pagine interne visitate con errore, status ≥ 400 o redirect verso status ≥ 400. Solo le pagine effettivamente visitate sono verificabili. |
| `links-to-redirect` | info | La pagina linka pagine interne visitate che redirigono. |
| `no-internal-outlinks` | warn | Pagina HTML 2xx che non linka nessun'altra pagina del sito. |
| `deep-page` | info | Pagina indicizzabile a più di `maxClickDepth` (3) clic dagli URL di partenza (**profondità di click**: percorso più breve nei link interni, salvata in `clickDepth`). |
| `canonical-broken` | error | Canonical verso una pagina visitata in errore o ≥ 400. |
| `canonical-to-redirect` | warn | Canonical verso una pagina che redirige. |
| `canonical-to-noindex` | warn | Canonical verso una pagina noindex. |
| `hreflang-broken` | warn | Alternate interni visitati con errore o status ≥ 300. |
| `hreflang-return-missing` | warn | Alternate interni visitati che non hanno un hreflang verso la pagina. |
| `sitemap-non-indexable` | warn | URL elencato nella sitemap ma non indicizzabile (con il motivo). |
| `not-in-sitemap` | info | Pagina indicizzabile non elencata nella sitemap (solo se la sitemap elenca URL). |
| `orphan-page` | warn | Pagina 2xx elencata nella sitemap che nessuna pagina del sito linka (esclusi gli URL di partenza). |
| `title-duplicate` | warn | Stesso title (senza distinzione di maiuscole) su più pagine 200 indicizzabili. |
| `description-duplicate` | info | Come sopra per la description. |
| `content-duplicate` | warn | Stesso hash del testo visibile su più pagine 200 indicizzabili. |
| `robots-missing` | info | `robots.txt` non trovato (solo se è stato richiesto). |
| `sitemap-missing` | info | Nessuna sitemap trovata (solo con `sitemap` attivo). |
| `security-headers-missing` | info | Una issue per header (`Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options` o `frame-ancestors` nella CSP, `Referrer-Policy`) assente su pagine HTML `https`, con l'elenco delle pagine. |

**Health score.** Ogni scan ha un punteggio 0–100: la quota di URL visitati senza issue `error` (le issue tra pagine contano per tutte le pagine coinvolte). È salvato in `stats.healthScore` e, per le scan precedenti, calcolato al volo dal report e dalla CLI.

## 4.5 Esito della scan

| ID | Requisito |
|---|---|
| RF-SCAN-20 | Se non viene visitata alcuna pagina, o se tutte le pagine sono in errore di rete, la scan fallisce e **non** viene salvata. |
| RF-SCAN-21 | Altrimenti la scan viene salvata come istantanea (§5) con statistiche: pagine, pagine HTML, conteggio per classe di status (`2xx`, `3xx`, `4xx`, `5xx`, `fail`), issue per severità, tempo medio di risposta, numero di screenshot e health score (§4.4). La scan registra anche la presenza di `robots.txt` e della sitemap (`crawl.robotsFound`, `crawl.sitemapFound`, `null` se non verificata) e le regole attive (`options.issueCodes`). |

## 4.6 Configurazione delle regole

| ID | Requisito |
|---|---|
| RF-QUAL-01 | `quality.disable` elenca codici di issue da non calcolare: non compaiono nella scan né nei conteggi. |
| RF-QUAL-02 | `quality.severity` assegna a un codice una severità diversa da quella predefinita (`error`, `warn`, `info`; altri valori sono un errore di configurazione). |
| RF-QUAL-03 | Le soglie `slowMs`, `titleMin`, `titleMax`, `descriptionMin`, `descriptionMax`, `thinWords`, `maxClickDepth`, `maxDomNodes`, `maxUrlLength` sostituiscono i default (numeri ≥ 0). |
| RF-QUAL-04 | La scan registra in `options.issueCodes` i codici effettivamente verificati; il confronto lo usa per non segnalare come regressioni le issue di regole non attive in Base (§6.3). |
