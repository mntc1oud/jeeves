import { Bot, Context, InlineKeyboard, webhookCallback } from "grammy";
import { Brain, type BrainContext, type SystemCommands } from "./brain";
import { env } from "cloudflare:workers";
import { hmacKey } from "../common";

export class TelegramBot {
  client: Bot;

  constructor(token: string) {
    this.client = new Bot(token);

    this.client.use(async (ctx, next) => {
      if (ctx.chatId?.toString() == env.TG_USER_ID) {
        await next();
      } else {
        await ctx.reply(env.REJECT_MESSAGE);
      }
    });

    this.client.command(
      "start",
      async (ctx) => await Brain.act(this.getBotContext(ctx), "say_hello"),
    );

    this.client.on(
      "callback_query:data",
      async (ctx) =>
        await Brain.act(this.getBotContext(ctx), ctx.callbackQuery.data),
    );

    this.client.on(
      "message",
      async (ctx) =>
        await Brain.send(
          this.getBotContext(ctx),
          ctx.message!.text!,
          ctx.message.date,
          ctx.message.message_id,
        ),
    );
  }

  async send(command: SystemCommands, input?: string) {
    await Brain.command(
      {
        send: async (msg, keyboard) => {
          const returned = await this.client.api.sendMessage(
            env.TG_USER_ID,
            msg,
            {
              link_preview_options: { is_disabled: true },
              parse_mode: "MarkdownV2",
              reply_markup: keyboard
                ? new InlineKeyboard([
                    keyboard.map((button) =>
                      InlineKeyboard.text(button.name, button.action),
                    ),
                  ])
                : undefined,
            },
          );

          return returned.message_id;
        },
        edit: async (msg, keyboard, id) => {
          if (!id) {
            throw new Error("no, can't do edits without id");
          }

          await this.client.api.editMessageText(env.TG_USER_ID, id, msg, {
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2",
            reply_markup: keyboard
              ? new InlineKeyboard([
                  keyboard.map((button) =>
                    InlineKeyboard.text(button.name, button.action),
                  ),
                ])
              : undefined,
          });
        },
        delMsg: async (id) => {
          await this.client.api.deleteMessage(env.TG_USER_ID, id);
        },
      },
      { name: command, input },
    );
  }

  getBotContext(ctx: Context): BrainContext {
    return {
      send: async (msg, keyboard) => {
        const returned = await ctx.reply(msg, {
          link_preview_options: { is_disabled: true },
          parse_mode: "MarkdownV2",
          reply_markup: keyboard
            ? new InlineKeyboard([
                keyboard.map((button) =>
                  InlineKeyboard.text(button.name, button.action),
                ),
              ])
            : undefined,
        });

        return returned.message_id;
      },
      edit: async (msg, keyboard, id) => {
        await ctx.api.editMessageText(
          ctx.chatId!,
          id ?? ctx.callbackQuery!.message!.message_id,
          msg,
          {
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2",
            reply_markup: keyboard
              ? new InlineKeyboard([
                  keyboard.map((button) =>
                    InlineKeyboard.text(button.name, button.action),
                  ),
                ])
              : undefined,
          },
        );
      },
      delMsg: async (id) => {
        await ctx.api.deleteMessage(env.TG_USER_ID, id);
      },
    };
  }

  process(request: Request) {
    return webhookCallback(this.client, "cloudflare-mod")(request);
  }
}

export async function isInitDataOk(
  params: URLSearchParams,
  token: string,
): Promise<boolean> {
  if (params.size != 5 && params.size != 6) {
    return false;
  }

  const encoder = new TextEncoder();

  const secretKey = await hmacKey(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(encoder.encode("WebAppData")),
      encoder.encode(token),
    ),
  );

  const hash = params.get("hash");

  if (hash == null) {
    return false;
  }

  const dataCheckString = [
    `auth_date=${params.get("auth_date")}`,
    params.get("chat_instance")
      ? `chat_instance=${params.get("chat_instance")}`
      : undefined,
    params.get("chat_type")
      ? `chat_type=${params.get("chat_type")}`
      : undefined,
    params.get("query_id") ? `query_id=${params.get("query_id")}` : undefined,
    `signature=${params.get("signature")}`,
    `user=${params.get("user")}`,
  ]
    .filter((part) => part)
    .join("\n");

  return await crypto.subtle.verify(
    "HMAC",
    secretKey,
    Buffer.from(hash, "hex"),
    encoder.encode(dataCheckString),
  );
}
