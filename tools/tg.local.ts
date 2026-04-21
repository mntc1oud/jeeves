import { Bot, Context } from "grammy";
import dotenv from "dotenv";

dotenv.config({ path: [".env", ".env.local"] });

const bot = new Bot(process.env.TG_BOT_TOKEN!);

console.log("removing webhook...");
await bot.api.deleteWebhook();

// console.log("setting mini app url to localhost...");
// await bot.api.setChatMenuButton({
//   menu_button: {
//     type: "web_app",
//     text: "Jobs Tracker (local)",
//     web_app: { url: `http://localhost:${process.env.DEV_PORT!}/` },
//   },
// });

async function relay(ctx: Context) {
  console.log(ctx.update);

  await fetch(`http://localhost:${process.env.DEV_PORT!}/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(ctx.update),
  });
}

bot.on("callback_query", relay);
bot.on("message", relay);

process.on("SIGINT", () => {
  console.log("received a stop signal, stopping the loop...");
  bot
    .stop()
    // .then(() =>
    //   bot.api.setChatMenuButton({
    //     menu_button: {
    //       type: "web_app",
    //       text: "Jobs Tracker",
    //       web_app: { url: `${process.env.WEBHOOK_DOMAIN!}/` },
    //     },
    //   }),
    // )
    .then(() => bot.api.setWebhook(`${process.env.WEBHOOK_DOMAIN!}/ask`))
    .then(() => console.log("webhook is set! process is set and destroyed"))
    .then(() => process.exit());
});

console.log("starting loop...");
await bot.start();
