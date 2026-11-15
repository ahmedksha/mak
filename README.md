# MAK VIBE CODING

Un agente di programmazione AI per il terminale. Legge il codice, modifica i file,
esegue comandi e test, sempre chiedendoti conferma prima di cambiare qualcosa.
Funziona con i modelli Claude tramite l'API di Anthropic.

## Installazione

Serve Node.js 22 o più recente e una chiave API Anthropic.

```bash
npm install
npm run build
npm link
export ANTHROPIC_API_KEY="la-tua-chiave"
```

## Uso

```bash
mak                              # sessione interattiva nella cartella corrente
mak -p "spiega questo progetto"  # una richiesta ed esce
mak --yolo                       # approva da solo modifiche e comandi
mak -m claude-sonnet-5-5 -e low  # altro modello e livello di impegno
```

Comandi nella sessione: `/help`, `/clear`, `/model`, `/effort`, `/yolo`, `/cost`, `/init`, `/exit`.
Ctrl+C interrompe la risposta in corso; a riposo chiude il programma.

## Istruzioni di progetto

Scrivi le regole del tuo progetto in `MAK.md` nella cartella principale: vengono
caricate a ogni avvio. `/init` lo crea analizzando il codice.

## Strumenti e permessi

| Strumento | Cosa fa | Chiede conferma |
|---|---|---|
| `read_file`, `glob`, `grep` | legge e cerca nel progetto | no |
| `write_file`, `edit_file` | crea e modifica file | sì |
| `bash` | esegue comandi nella cartella del progetto | sì |

Gli strumenti sui file non possono uscire dalla cartella del progetto. `bash` invece
esegue qualsiasi comando tu approvi, quindi usa `--yolo` solo dove ti fidi.
Con `-p` e senza `--yolo` modifiche e comandi vengono rifiutati.

## Test

```bash
npm test
```

Avvia un finto server API locale e verifica il ciclo completo: risposta in streaming,
esecuzione degli strumenti, blocco dei percorsi esterni, permessi.
