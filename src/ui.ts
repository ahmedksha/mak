const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export const NAME = "MAK VIBE CODING";
export const VERSION = "1.0.0";

export function banner(model: string, cwd: string, mode: string): string {
  const art = [
    "  __  __    _    _  __  __     _____ ____  _____ ",
    " |  \\/  |  / \\  | |/ /  \\ \\   / /_ _| __ )| ____|",
    " | |\\/| | / _ \\ | ' /    \\ \\ / / | ||  _ \\|  _|  ",
    " | |  | |/ ___ \\| . \\     \\ V /  | || |_) | |___ ",
    " |_|  |_/_/   \\_\\_|\\_\\     \\_/  |___|____/|_____|",
  ].join("\n");
  return [
    c.magenta(art),
    c.bold(`  ${NAME} `) + c.dim(`v${VERSION}`),
    c.dim(`  modello: ${model}  ·  permessi: ${mode}`),
    c.dim(`  cartella: ${cwd}`),
    c.dim("  /help per i comandi  ·  Ctrl+C interrompe  ·  /exit per uscire"),
    "",
  ].join("\n");
}

export const HELP = `
${c.bold("Comandi")}
  /help            mostra questo aiuto
  /clear           azzera la conversazione
  /model [id]      mostra o cambia il modello
  /effort [liv]    mostra o cambia l'impegno (low, medium, high, xhigh, max)
  /yolo            attiva/disattiva l'approvazione automatica degli strumenti
  /cost            token usati e costo stimato della sessione
  /init            analizza il progetto e crea MAK.md
  /exit            esci

${c.bold("Suggerimenti")}
  Le istruzioni di progetto vanno in MAK.md: vengono lette a ogni avvio.
  Uso non interattivo:  mak -p "spiega questo repository"
`;
