/**
 * The `tessaract` command. Each subcommand is one module in src/tools that reads its own arguments from
 * process.argv, so this entry only rewrites argv to `<node> tessaract-<cmd> ...rest` and loads it.
 */
import { PKG_VERSION } from './tools/paths';

const COMMANDS: Record<string, [() => Promise<unknown>, string]> = {
  create: [() => import('./tools/create'), 'scaffold a new game project            create <dir> [--title "My TCG"]'],
  new: [() => import('./tools/new-game'), 'add a game config from the template     new <id> [--title] [--out games]'],
  snapshot: [() => import('./tools/snapshot'), 'read an NFT collection from chain        snapshot <address> --chain liteforge | --rpc <url>'],
  import: [() => import('./tools/import-collection'), 'turn a collection into a card set        import <cards.json> --id <id>'],
  sim: [() => import('./tools/sim'), 'bot vs bot balance + replay check        sim <game.json> [--matches 300]'],
  title: [() => import('./tools/build-title'), 'LitNode ruleset + compatibility check    title <game.json> [--litnode <dir>]'],
  web: [() => import('./tools/build-web'), 'build the static site                    web <game.json> [--collection <cards.json>]'],
  dev: [() => import('./tools/serve'), 'serve the site locally                   dev [--port 4173]'],
  replay: [() => import('./tools/replay'), 'check a shared match and print its result replay <link | code | record.json>'],
  relay: [() => import('./tools/relay'), 'two-player match relay                   TCG_DEV=1 TCG_GAME=<game.json> tessaract relay'],
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === '--version' || !(cmd in COMMANDS)) {
  if (cmd === '--version') { console.log(PKG_VERSION); process.exit(0); }
  if (cmd && !['help', '--help', '-h'].includes(cmd)) console.error(`unknown command: ${cmd}\n`);
  console.log(`tessaract ${PKG_VERSION} — Web3 TCG game maker\n\nusage: tessaract <command> [options]\n`);
  for (const [name, [, help]] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(9)} ${help}`);
  process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? 1 : 0);
}
process.argv = [process.argv[0], `tessaract ${cmd}`, ...rest];
await COMMANDS[cmd][0]();
