---
status: proposed
date: 2026-10-22
decision-makers: <!-- TODO: chi conferma la decisione -->
---

# Non salvare le scan in cui nessuna pagina è raggiungibile

## Contesto e problema

Se il sito non risponde (DNS, VPN spenta, timeout, ambiente giù), una scan produce solo errori di rete. Salvarla come istantanea è coerente con l'idea di as-is, ma riempie lo storico di scan inutili e, se presa come Head con `latest`, fa fallire il confronto con centinaia di «pagina rimossa». Con `scan --all` un sito irraggiungibile deve risultare fallito senza bloccare gli altri.

## Fattori decisionali

* Lo storico deve contenere scan utili come riferimento.
* `latest` deve indicare l'ultima scan significativa.
* Un problema di rete deve essere visibile come fallimento, non come regressione del sito.

## Opzioni considerate

* Scan fallita e non salvata se nessuna pagina è stata visitata o tutte sono in errore di rete; salvata altrimenti.
* Salvare sempre, marcando la scan come «sito irraggiungibile».
* Salvare sempre senza distinzione.

## Esito della decisione

Opzione scelta (implementata nella 0.1.0, da confermare): "non salvare se nessuna pagina è raggiungibile", perché un problema di connettività non è uno stato del sito da confrontare. Il comando termina con errore (exit code 2 per `--site`; con `--all` il sito è contato tra i falliti e l'exit code è 1).

Se almeno una pagina risponde, la scan viene salvata anche se piena di errori HTTP (4xx/5xx): quelli sono uno stato reale del sito.

### Conseguenze

* Positivo, perché lo storico resta pulito e `latest` affidabile.
* Positivo, perché in CI un problema di rete appare come fallimento della scan, distinto da un confronto fallito.
* Negativo, perché non resta traccia storica dei periodi in cui il sito era irraggiungibile.
* Negativo, perché se rispondono solo poche pagine (es. la home, poi timeout) la scan viene salvata comunque e il confronto mostrerà molte pagine rimosse.

### Verifica

Il test e2e scansiona con `--all` un sito irraggiungibile insieme a uno raggiungibile e verifica esito, riepilogo ed exit code.

## Ulteriori informazioni

Se serve monitorare la disponibilità, valutare una soglia configurabile (es. scan scartata se oltre l'X% delle pagine è in errore di rete) o un registro separato dei tentativi falliti.
