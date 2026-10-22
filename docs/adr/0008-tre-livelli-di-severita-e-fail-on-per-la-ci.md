---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Tre livelli di severità fissi per tipo di differenza, con soglie configurabili e `--fail-on` per la CI

## Contesto e problema

Il confronto produce molte differenze di natura diversa: alcune sono regressioni gravi (pagina sparita, 500, `noindex` comparso), altre sono cambiamenti attesi (testo aggiornato). Per usare il confronto come regression test in CI serve un criterio chiaro che decida se la pipeline fallisce.

## Fattori decisionali

* Un esito binario in CI, comprensibile e stabile.
* Pochi falsi positivi sui cambiamenti normali di contenuto.
* Possibilità di adattare il comportamento per sito senza modificare il codice.

## Opzioni considerate

* Tre severità (`error`, `warn`, `info`) assegnate dal codice per tipo e contesto, con soglie numeriche e tipi ignorabili per sito; `--fail-on error|warn`.
* Punteggio numerico complessivo con soglia.
* Regole di severità interamente configurabili per sito.

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "tre severità con soglie e `--fail-on`". Principi applicati:

* **error** solo per ciò che rompe il sito o l'indicizzazione: pagina 2xx sparita, 2xx → 4xx/5xx/errore, `noindex` comparso, destinazione della redirect map assente, nuove issue di livello error (es. link rotti).
* **warn** per cambiamenti SEO o strutturali da verificare: title, description, H1, canonical, lang, redirect, grandi variazioni di testo o link, peggioramento del tempo di risposta, differenza visiva rilevante.
* **info** per cambiamenti normalmente attesi o migliorativi: piccole variazioni di testo, pagine aggiunte, issue risolte.

Exit code: 0 ok, 1 soglia superata, 2 errore d'uso o configurazione, così la CI distingue «regressione» da «comando sbagliato».

### Conseguenze

* Positivo, perché l'esito in CI è prevedibile e spiegabile (ogni differenza ha tipo, severità e messaggio).
* Positivo, perché `compare.ignore` e `compare.thresholds` adattano il comportamento per sito.
* Negativo, perché la severità di un tipo non si può cambiare per sito (es. promuovere `title-changed` a error): oggi si può solo ignorarlo.
* Negativo, perché le soglie predefinite (30% parole, 0,5% pixel, ×2 tempi) sono scelte iniziali non calibrate su siti reali.
* Negativo, perché le issue sono confrontate per codice e pagina: se una pagina aveva già `broken-links` e in Head ne acquisisce altri, non nasce alcuna differenza nuova (falso negativo).

### Verifica

Test unitari sulle severità (pagina rimossa 2xx/404, soglie, ignore); test e2e su `--fail-on error` con exit code 1.

## Pro e contro delle opzioni

### Tre severità fisse con soglie

* Positivo, perché semplice da leggere e da usare in CI.
* Negativo, perché poco personalizzabile.

### Punteggio complessivo

* Negativo, perché un numero aggregato non spiega cosa si è rotto e molte piccole modifiche possono sommarsi a un falso fallimento.

### Regole interamente configurabili

* Positivo, perché massima flessibilità.
* Negativo, perché più complesso da configurare e da documentare; risultati non confrontabili tra siti.

## Ulteriori informazioni

Ricalibrare le soglie dopo le prime scan su siti reali. Evoluzione possibile: `compare.severity: { <tipo>: error|warn|info }` per ridefinire la severità per sito.
