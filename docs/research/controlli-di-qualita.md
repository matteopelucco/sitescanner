# Controlli di qualità degli scanner SEO professionali

Ricerca del 2026-10-24 per il task «Potenziare i dati di qualità». Obiettivo: capire cosa rilevano gli strumenti di riferimento, confrontarlo con le issue di sitescanner (§4.4 delle specifiche) e decidere cosa implementare.

## Fonti

- Screaming Frog SEO Spider, elenco completo delle issue: <https://www.screamingfrog.co.uk/seo-spider/issues/> (oltre 300 issue, warning e opportunità, con priorità High/Medium/Low).
- Semrush Site Audit, «What Issues Can Site Audit Identify?»: <https://www.semrush.com/kb/542-site-audit-issues-list> (41 errori, 34 warning, 25 notice).
- Ahrefs Site Audit: <https://ahrefs.com/site-audit> e <https://help.ahrefs.com/using-ahrefs/site-audit-new/how-to-configure-pre-set-issues-within-ahrefs-site-audit> (oltre 170 issue in error/warning/notice; issue attivabili/disattivabili e con importanza modificabile; Health Score basato sugli error).
- Sitebulb Hints: <https://sitebulb.com/hints/> e <https://support.sitebulb.com/en/articles/9854034-hints> (oltre 300 hint in 15 categorie, priorità Critical…Insight, hint ignorabili per progetto, audit score).
- Lighthouse, audit SEO: <https://developer.chrome.com/docs/lighthouse/seo/> (meta description, testo dei link, hreflang, canonical, status HTTP, robots.txt, plugin, tap target, dati strutturati).
- ContentKing (Conductor), monitoraggio continuo con storico delle modifiche e alert (description sparita, link rotto, pagina diventata non indicizzabile): <https://www.trustradius.com/products/contentking>, <https://www.marketingmonk.so/products/contentking>.

## Tabella comparativa

Legenda: ● presente · ◐ parziale o solo con rendering/integrazioni · — assente. «ss» = sitescanner prima di questo task.

| Area | Controllo | Screaming Frog | Semrush | Ahrefs | Sitebulb | Lighthouse | ss |
|---|---|---|---|---|---|---|---|
| Risposte | 4xx / 5xx / nessuna risposta | ● | ● | ● | ● | ● | ● |
| Risposte | Catene e loop di redirect | ● | ● | ● | ● | — | ◐ catene |
| Risposte | Redirect temporanei (302/307) | ● | ● | ● | ● | — | — |
| Risposte | Meta refresh | ● | ● | ● | ● | — | — |
| Risposte | Soft 404 | ● | — | — | ● | — | — |
| Indicizzabilità | Meta robots noindex / nofollow | ● | ● | ● | ● | — | ◐ noindex |
| Indicizzabilità | X-Robots-Tag (header) | ● | ● | ● | ● | — | — |
| Indicizzabilità | Stato «indicizzabile» per pagina con motivo | ● | ● | ● | ● | — | — |
| Canonical | Mancante / verso altra pagina | ● | ● | ● | ● | ● | ● |
| Canonical | Multipli in conflitto | ● | ● | ● | ● | — | — |
| Canonical | Verso pagina rotta, redirect o non indicizzabile | ● | ● | ● | ● | ● | — |
| Canonical | Relativo | ● | — | — | ● | — | — |
| Title / description | Mancante, duplicato, troppo lungo | ● | ● | ● | ● | ● | ● |
| Title / description | Troppo corto | ● | ● | ● | ● | — | — |
| Title / description | Multipli nella pagina | ● | — | ● | ● | — | — |
| Heading | H1 mancante / multipli | ● | ● | ● | ● | — | ● |
| Heading | Heading non sequenziali (salti di livello) | ● | — | — | ● | ◐ a11y | — |
| Contenuti | Duplicati esatti | ● | ● | ● | ● | — | — |
| Contenuti | Quasi duplicati | ● | — | ● | ● | — | — |
| Contenuti | Poco testo (thin content) | ● | ● | ● | ● | — | — |
| Contenuti | Testo segnaposto (lorem ipsum) | ● | — | — | — | — | — |
| Link | Link interni rotti | ● | ● | ● | ● | — | ● |
| Link | Link esterni rotti | ● | ● | ● | ● | — | — |
| Link | Link interni verso redirect | ● | ● | ● | ● | — | — |
| Link | Pagine senza link interni in uscita | ● | — | ● | ● | — | — |
| Link | Profondità di click elevata (> 3) | ● | ● | ● | ● | — | — |
| Link | Link interni nofollow | ● | ● | ● | ● | — | — |
| Link | Anchor vuoto / non descrittivo | ● | ● | ● | ● | ● | — |
| Sitemap / robots | robots.txt o sitemap assenti | — | ● | ● | ● | ● | — |
| Sitemap / robots | URL non indicizzabili in sitemap | ● | ● | ● | ● | — | — |
| Sitemap / robots | Pagine indicizzabili non in sitemap | ● | — | ● | ● | — | — |
| Sitemap / robots | Pagine orfane (in sitemap, non linkate) | ● | ● | ● | ● | — | — |
| Hreflang | Codici non validi | ● | ● | ● | ● | ● | — |
| Hreflang | Link di ritorno mancanti | ● | ● | ● | ● | — | — |
| Hreflang | Destinazioni non 200 | ● | ● | ● | ● | — | — |
| Hreflang | Self-reference / x-default mancanti | ● | — | ● | ● | — | — |
| Dati strutturati | JSON-LD non valido / errori di parsing | ● | ● | ● | ● | ◐ manuale | — |
| Dati strutturati | Validazione rich result (schema.org) | ● | ● | ● | ● | — | — |
| Social | Open Graph mancante | ◐ | — | ● | ● | — | — |
| Sicurezza | Pagine HTTP / mixed content | ● | ● | ● | ● | ● | ◐ mixed |
| Sicurezza | Form con action HTTP | ● | — | — | ● | — | — |
| Sicurezza | Header di sicurezza (HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy) | ● | ◐ HSTS | — | ● | ◐ | — |
| Prestazioni | Risposta lenta | ● | ● | ● | ● | ● | ● |
| Prestazioni | HTML non compresso | — | ● | — | ● | ● | — |
| Prestazioni | Pagina troppo pesante | — | ● | ● | ● | ● | ● |
| Prestazioni | DOM troppo grande | ● | — | — | ● | ● | — |
| Prestazioni | Core Web Vitals / opportunità Lighthouse | ◐ API | ◐ | ● | ● | ● | — |
| Prestazioni | Immagini senza dimensioni (CLS) | ● | — | — | ● | ● | — |
| Mobile | Meta viewport mancante | ● | ● | — | ● | ● | ● |
| HTML | Doctype / charset mancanti | — | ● | — | ● | ● | — |
| HTML | Lang mancante | ● | ● | ● | ● | ● | ● |
| URL | Maiuscole, underscore, troppo lunghi, doppio slash, spazi | ● | ● | ● | ● | — | — |
| Accessibilità | Immagini senza alt | ● | ● | ● | ● | ● | ● |
| Accessibilità | Campi senza label, pulsanti senza nome, iframe senza title | ● | — | — | ● | ● | — |
| Rendering JS | Differenze HTML originale / renderizzato | ● | ◐ | ● | ● | — | — |
| Punteggio | Health score / audit score | — | ● | ● | ● | ● | — |
| Configurazione | Disattivare issue o cambiarne l'importanza | ● | ◐ | ● | ● | — | — |
| Monitoraggio | Storico delle modifiche e alert | — | ◐ | ◐ | — | — | ● confronto Base/Head |

## Gap analysis

sitescanner copre bene i fondamentali (status, title, description, H1, alt, canonical, link interni rotti, duplicati di title e description) e ha un punto di forza che gli strumenti di audit puri non hanno: il **confronto Base/Head** di due scan qualsiasi, con severità e soglie per la CI. Mancano invece:

1. **Indicizzabilità** come concetto esplicito (con l'header `X-Robots-Tag`): è la domanda principale di un audit e la base di molte altre regole (sitemap, canonical, duplicati).
2. **Coerenza tra pagine**: canonical verso pagine rotte o redirect, link interni verso redirect, hreflang senza ritorno, URL non indicizzabili in sitemap, orfane, profondità di click. Sono i controlli che giustificano un crawler rispetto a un linter di pagina, e sitescanner ha già tutti i dati (link, sitemap, status).
3. **Contenuti**: duplicati esatti (l'hash del testo c'è già), thin content, testo segnaposto e soft 404 — questi ultimi molto utili proprio per ambienti di stage.
4. **Dati strutturati** (JSON-LD): oggi ignorati; sono una regressione frequente nei rilasci.
5. **Sicurezza e igiene HTTP/HTML**: header di sicurezza, compressione, doctype, charset, form insicuri, URL malformati.
6. **Un punteggio** sintetico (health score) per scan, utile nello storico e nei report verso il cliente.
7. **Configurabilità delle regole** (disattivare o cambiare severità, soglie): senza, issue irrilevanti per un sito diventano rumore.

## Proposta prioritizzata

Valore (V) e costo (C) su scala 1–3. Priorità P1 = da implementare in questo task; P2 = rimandato (task futuri).

| # | Proposta | V | C | Priorità |
|---|---|---|---|---|
| 1 | Indicizzabilità per pagina (`indexable`, motivo) con `X-Robots-Tag`; issue `x-robots-noindex`, `nofollow`; differenza `indexability-changed` nel confronto | 3 | 1 | P1 |
| 2 | Canonical: `canonical-multiple`, `canonical-broken`, `canonical-to-redirect`, `canonical-to-noindex`, `canonical-relative` | 3 | 1 | P1 |
| 3 | Link: `links-to-redirect`, `no-internal-outlinks`, `deep-page` (profondità di click calcolata con BFS dai punti di partenza), `nofollow-internal`, `anchor-empty`, `anchor-generic` | 3 | 1 | P1 |
| 4 | Sitemap e robots: `sitemap-non-indexable`, `not-in-sitemap`, `orphan-page`, `robots-missing`, `sitemap-missing` | 3 | 1 | P1 |
| 5 | Contenuti: `content-duplicate` (testo identico), `thin-content`, `placeholder-text`, `soft-404` | 3 | 1 | P1 |
| 6 | Dati strutturati: tipi JSON-LD per pagina, `structured-data-invalid`; differenza `structured-data-changed`; `og-missing` | 3 | 1 | P1 |
| 7 | Hreflang: `hreflang-invalid`, `hreflang-return-missing`, `hreflang-broken`, `hreflang-self-missing`, `hreflang-x-default-missing` | 2 | 1 | P1 |
| 8 | Redirect: `redirect-loop`, `redirect-temporary`, `meta-refresh` | 2 | 1 | P1 |
| 9 | Title/description: `title-too-short`, `description-too-short`, `title-multiple`, `description-multiple`; heading `heading-skip` | 2 | 1 | P1 |
| 10 | Health score 0–100 per scan (quota di pagine senza error, come Ahrefs), nello storico, nella diagnostica e nel confronto | 3 | 1 | P1 |
| 11 | Configurazione `quality`: disattivare regole, cambiarne la severità, soglie (`slowMs`, `thinWords`, `maxClickDepth`) | 3 | 1 | P1 |
| 12 | Sicurezza e HTTP: header di sicurezza mancanti (issue di sito), `form-insecure`, `compression-missing` | 2 | 1 | P1 |
| 13 | HTML e URL: `doctype-missing`, `charset-missing`, `img-no-dimensions`, `dom-large`, `url-uppercase`, `url-underscore`, `url-too-long`, `url-malformed` | 1 | 1 | P1 |
| 14 | Accessibilità leggera: `input-no-label`, `button-no-name`, `iframe-no-title` | 2 | 1 | P1 |
| 15 | Link e risorse esterne rotte (immagini, script, CSS, link esterni) con richieste HEAD, opzionale | 3 | 2 | P2 |
| 16 | Quasi duplicati (simhash del testo) | 2 | 2 | P2 |
| 17 | Core Web Vitals e audit Lighthouse con Playwright quando gli screenshot sono attivi | 3 | 3 | P2 |
| 18 | Confronto HTML originale / renderizzato (contenuti che dipendono da JavaScript) | 2 | 3 | P2 |
| 19 | Validazione schema.org dei rich result | 2 | 3 | P2 |
| 20 | Leggibilità e ortografia del testo (italiano) | 1 | 3 | P2 |

Le voci P1 usano solo dati già scaricati (HTML, header, sitemap, grafo dei link): nessuna richiesta di rete in più, nessuna dipendenza nuova, costo trascurabile sul tempo di scan.
