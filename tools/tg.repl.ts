import { Bot } from "grammy";
import { env } from "node:process";
import * as repl from "node:repl";

const loop = repl.start();

const bot = new Bot(env["BOT_TOKEN"]!);

bot.api.deleteWebhook();

loop.context.bot = bot;

loop.on("exit", () => {
  bot.api
    .setWebhook("https://jeeves-brain.affectech.workers.dev/ask")
    .then(() => console.log("webhook is set! now exiting"))
    .then(() => process.exit());
});

// loop.context.id = env["MSG_ID_TOKEN"]
