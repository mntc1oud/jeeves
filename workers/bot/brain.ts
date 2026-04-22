import { env } from "cloudflare:workers";

import persona from "./resources/persona.txt";
import r from "./resources/responses.en.json";
import greeting from "./resources/greeting.en.txt";

import { drizzle } from "drizzle-orm/d1";
import { jobsTable, Status } from "./db_schema";
import { asc, count } from "drizzle-orm";
import z from "zod";

export interface BrainContext {
  send(msg: string, keyboard?: MessageButton[]): Promise<number>;
  edit(newMsg: string, keyboard?: MessageButton[], id?: number): Promise<void>;
  delMsg(id: number): Promise<void>;
}

const ModelResponse = z.object({
  jobs: z
    .array(
      z.object({
        positionName: z
          .string()
          .describe("The official job title or position name"),
        companyName: z.string().describe("The name of the hiring company"),
        companyDesc: z
          .string()
          .describe(
            "A brief description of the company, its mission, or industry in one small sentence (don't mention company name)",
          ),
      }),
    )
    .describe("list of job descriptions, length should match input"),
});

export interface MessageButton {
  name: string;
  action: "say_hello" | "start_process" | "switch_bot_on_off";
}

interface UnprocessedURL {
  url: string;
  isOk?: boolean;
  text?: string;
  title?: string;
}

export type SystemCommands =
  | "sendYouGotMail"
  | "sendGentleMotivation"
  | "extractWithLLM";

type States<T> = {
  // to filter functions we use never
  // never is always not part of resulting union
  // think of it like a zero in equation
  [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];

export class Brain {
  constructor(
    public enabled: boolean,
    public unprocessed: (string | UnprocessedURL)[],
    public lastMessageId?: number,
    public lastMessageDate?: number,
  ) {}

  // NOTE: maybe I should've called it neuronactivated, than this
  static async on(
    keys: States<Brain>[] = [
      "enabled",
      "unprocessed",
      "lastMessageId",
      "lastMessageDate",
    ],
  ) {
    const state = await env.state.get(keys as string[], "json");

    return new Brain(
      (state.get("enabled") as boolean) ?? false,
      (state.get("unprocessed") as (string | UnprocessedURL)[]) ?? [],
      (state.get("lastMessageId") as number) ?? undefined,
      (state.get("lastMessageDate") as number) ?? undefined,
    );
  }

  async off() {
    // it will get only properties, not methods
    for (const [key, value] of Object.entries(this)) {
      if (value) {
        await env.state.put(key, JSON.stringify(value));
      } else {
        await env.state.delete(key);
      }
    }
  }

  // System commands are used by system to communicate with Telegram API
  static async command(
    ctx: BrainContext,
    command: {
      name: SystemCommands;
      input?: string;
    },
  ) {
    const brain = await Brain.on();

    switch (command.name) {
      case "sendYouGotMail": {
        if (!brain.unprocessed.length) {
          const text = command.input!;

          brain.lastMessageId = await ctx.send(
            `${brain.esc(r.youGotNewMail)}\n${
              brain
                .esc(text)
                .split("\n")
                .map(
                  (line, index) => `${!index ? "**" : ""}>${line.trimStart()}`,
                )
                .join("\n") + "||"
            }`,
            [{ name: "ОК", action: "say_hello" }],
          );
        } else {
          await ctx.edit(
            ...brain.listUnprocessedData("got_mail"),
            brain.lastMessageId,
          );
        }

        break;
      }
      case "sendGentleMotivation": {
        if (brain.enabled) {
          const stats = await brain.collectStats();

          const resp = await brain.ask(
            env.CREATIVE_MODEL,
            persona,
            `You need to notify user to search for a job.
             This notification is not dull, brings attention and motivates him.
             User doesn't want any tutorials or recomendations what to do.
             You don't have any capabilities to receive something from user in this context.
             Keep in mind those stats: \n${stats.join("\n")}`,
          );

          brain.lastMessageId = await ctx.send(brain.esc(resp), [
            { name: "Ок", action: "say_hello" },
          ]);
        }

        break;
      }
      case "extractWithLLM": {
        try {
          brain.unprocessed = brain.unprocessed.filter(
            (item) => typeof item == "string" || item.isOk,
          );

          if (!brain.unprocessed.length) {
            throw new Error("populate first!");
          }

          const modelResp = ModelResponse.parse(
            await brain.ask(
              env.PROCESSING_MODEL,
              "You're a assistant, helpful and brief",
              `Output schema: ${JSON.stringify(ModelResponse.toJSONSchema())}\n` +
                "You need extract information" +
                "\n" +
                "```json\n" +
                JSON.stringify(
                  brain.unprocessed.map((item, index) => {
                    console.log(item);

                    return {
                      index,
                      type: "plaintext",
                      content: typeof item == "string" ? item : item.text,
                    };
                  }),
                ) +
                "\n```",
              {
                name: "jobs",
                strict: true,
                schema: ModelResponse.toJSONSchema(),
              },
            ),
          );

          console.log({
            text: "Model responded with",
            jobs: modelResp.jobs,
          });

          const rows = await drizzle(env.memory)
            .insert(jobsTable)
            .values(
              modelResp.jobs.map((entry) => {
                return {
                  position: entry.positionName,
                  companyName: entry.companyName,
                  companyDesc: entry.companyDesc,
                };
              }),
            )
            .returning();

          const jobQueries = await env.AI.run(
            "@cf/google/embeddinggemma-300m",
            {
              text: rows.map(
                (row) =>
                  `task: search result | query: Is it letter from ${row.companyName}, about ${row.position}?`,
              ),
            },
          );

          await env.awaitedJobs.insert(
            rows.map((row, index) => {
              return {
                id: row.id.toString(),
                values: jobQueries.data[index],
              };
            }),
          );
        } catch (error) {
          console.log({
            exception: error,
          });

          await ctx.edit(
            ...brain.listUnprocessedData("error"),
            brain.lastMessageId,
          );

          break;
        }

        const [message, keyboard] = await brain.createGreeting();
        await ctx.edit(message, keyboard, brain.lastMessageId);

        brain.unprocessed = [];

        break;
      }
    }

    await brain.off();
  }

  // User interaction commands or just actions, they're part of chat context
  // for example, a direct explicit command intiated by the user in chat message
  // or a button with implicit command under a message (i.e Telegram)
  static async act(ctx: BrainContext, action: string) {
    const brain = await Brain.on();

    switch (action) {
      case "say_hello": {
        if (brain.unprocessed.length) {
          brain.unprocessed = [];
        }

        const [message, keyboard] = await brain.createGreeting();

        try {
          await ctx.edit(message, keyboard, brain.lastMessageId);
        } catch (err) {
          brain.lastMessageId = await ctx.send(message, keyboard);
        }

        break;
      }
      case "start_process": {
        await ctx.edit(
          brain.esc(r.processingJobsInProgress),
          [],
          brain.lastMessageId,
        );

        try {
          // send to LLM via queue, I don't want to make wait telegram any longer
          await env.aletheia.send("extractWithLLM");
        } catch (err) {
          console.log({
            error: err,
          });

          await ctx.edit(
            ...brain.listUnprocessedData("error"),
            brain.lastMessageId,
          );
        }

        break;
      }
      case "switch_bot_on_off": {
        brain.enabled = !brain.enabled;
        const [message, keyboard] = await brain.createGreeting();

        await ctx.edit(message, keyboard, brain.lastMessageId);
        break;
      }
      default: {
        console.log(`Got unknown data: ${action}`);
      }
    }

    await brain.off();
  }

  static async send(
    ctx: BrainContext,
    userMsg: string,
    userMsgDate: number,
    userMsgId?: number,
  ) {
    const brain = await Brain.on();

    switch (true) {
      case /^https:\/\/[^\s\\/$.?#].[^\s]*$/.test(userMsg): {
        const item: UnprocessedURL = { url: userMsg };
        brain.unprocessed.push(item);

        await ctx.delMsg(userMsgId!);
        await ctx.edit(...brain.listUnprocessedData(), brain.lastMessageId);

        const url = new URL(item.url);
        const headers = new Headers({
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0",
        });

        if (url.host == "jobs.ashbyhq.com") {
          console.log(url.pathname);
          const [company, jobId] = url.pathname
            .split("/")
            .filter((frag) => frag);
          headers.append("Accept", "application/json");

          const resp = await fetch(
            `https://api.ashbyhq.com/posting-api/job-board/${company}?includeCompensation=true`,
            {
              headers,
            },
          );

          item.isOk = resp.ok;

          if (item.isOk) {
            const board = await resp.json<{
              jobs: { id: string; title: string; descriptionPlain: string }[];
            }>();
            const job = board.jobs.find((job) => jobId == job.id);

            item.text = job?.descriptionPlain;
            item.title = job?.title;

            item.isOk = !!(item.text && item.title);
          }
        } else {
          const fetchResp = await fetch(item.url, { headers });

          item.isOk = fetchResp.ok;

          if (item.isOk) {
            let pageData = "";
            // let metaDescription = "";

            const handler: HTMLRewriterElementContentHandlers = {
              text(chunk) {
                if (chunk.text == "*" || chunk.text == "&nbsp;") {
                  return;
                }

                pageData =
                  pageData +
                  (chunk.lastInTextNode
                    ? `${chunk.text}\n`
                    : chunk.text.trim());
              },
            };

            const rewriter = new HTMLRewriter().on("title", {
              text(chunk) {
                item.title = item.title ? item.title + chunk.text : chunk.text;
              },
            });

            // rewriter.on('meta[property="og:description"]', {
            //   text(chunk) {
            //     metaDescription =
            //       metaDescription +
            //       (chunk.lastInTextNode ? `${chunk.text}\n` : chunk.text.trim());
            //   },
            // });

            for (const tag of [
              "h1",
              "h2",
              "h3",
              "h4",
              "h5",
              "h6",
              "li",
              "p",
              "span",
            ]) {
              rewriter.on(tag, handler);
            }

            // I know this is not a good solution for this problem,
            // but I don't have enough time to tinker with worker to include
            // wasm-based library
            // TODO: use https://github.com/cloudflare/html-rewriter-wasm ?
            const reader = rewriter.transform(fetchResp).body!.getReader();
            while (!(await reader.read()).done) {
              /* Run empty read to extract data */
            }

            if (pageData) {
              item.text = pageData;
            } else {
              item.isOk = false;
            }
          }
        }

        await ctx.edit(...brain.listUnprocessedData(), brain.lastMessageId);

        break;
      }

      default: {
        await ctx.delMsg(userMsgId!);

        // well we need to check a date of the message just to verify, if it's truncated or not
        // this aproach would be not so good, if we had many users, but this problem can be solved by
        // retrieving and saving state for each user id
        if (brain.lastMessageDate && brain.lastMessageDate == userMsgDate) {
          brain.unprocessed[brain.unprocessed.length - 1] =
            brain.unprocessed[brain.unprocessed.length - 1] + userMsg;
        } else {
          brain.lastMessageDate = userMsgDate;
          brain.unprocessed.push(userMsg);

          // we have this here because if we narrow the large job description to 128 characters and
          // we add eventually the second of part and rerun formatter, output text doesn't change
          // and Telegram throws error on edit because of that
          await ctx.edit(...brain.listUnprocessedData(), brain.lastMessageId);
        }
      }
    }

    await brain.off();
  }

  listUnprocessedData(
    messageType: "error" | "regular" | "got_mail" = "regular",
  ): [string, MessageButton[]] {
    return [
      (messageType == "regular"
        ? r.unprocessedJobs.message.start
        : messageType == "got_mail"
          ? r.unprocessedJobs.newMail.start + "\n"
          : r.unprocessedJobs.error.start + "\n") +
        this.unprocessed
          .map((item) => {
            if (typeof item == "string") {
              return `**> ${this.esc(
                item
                  .split(/\r\n|\r|\n/)
                  .filter((chunk) => chunk)
                  .join(" ")
                  .substring(0, 128),
              )}`;
            } else {
              let url = new URL(item.url);
              let status = r.unprocessedJobs.status.inProgress;

              if (item.isOk != undefined) {
                status = item.isOk ? "" : r.unprocessedJobs.status.cantGetIt;
              }

              return (
                `*[${this.esc(item.title ?? url.hostname)}](${item.url})* ` +
                (status ? `_${this.esc(status)}_` : "")
              );
            }
          })
          .join("\n") +
        "\n\n" +
        (messageType == "regular" || messageType == "got_mail"
          ? r.unprocessedJobs.message.end
          : r.unprocessedJobs.error.end),
      [
        { name: r.unprocessedJobs.buttons.letsGo, action: "start_process" },
        { name: r.unprocessedJobs.buttons.cancel, action: "say_hello" },
      ],
    ];
  }

  async collectStats(): Promise<string[]> {
    const data = await drizzle(env.memory)
      .select({ status: jobsTable.status, count: count() })
      .from(jobsTable)
      .groupBy(jobsTable.status)
      .orderBy(asc(jobsTable.status));

    return [Status.InProgress, Status.Invited, Status.Rejected].map(
      (status) => {
        let name = r.correspondence.noReply;

        switch (status) {
          case Status.InProgress:
            name = r.correspondence.noReply;
            break;
          case Status.Rejected:
            name = r.correspondence.rejected;
            break;
          case Status.Invited:
            name = r.correspondence.invited;
        }

        const found = data.find((entry) => entry.status == status);

        return `> _${name}_ \\- *${found ? found.count : 0}*`;
      },
    );
  }

  async createGreeting(): Promise<[string, MessageButton[]]> {
    const stats = await this.collectStats();

    return [
      greeting.replace("<stats/>", stats.join("\n")).replace(
        "<boards/>",
        [
          { name: "Hiring.cafe", url: "https://hiring.cafe" },
          {
            name: "Who is hiring? (HN)",
            url: "https://dheerajck.github.io/hnwhoishiring",
          },
        ]
          .map((val) => `*[${this.esc(val.name)}](${val.url})*`)
          .join("\n"),
      ),
      [
        {
          name: this.enabled ? r.greeting.buttons.off : r.greeting.buttons.on,
          action: "switch_bot_on_off",
        },
      ],
    ];
  }

  esc(text: string): string {
    if (!text) return text;

    return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  }

  async ask(
    model: string,
    system: string,
    prompt: string,
    jsonSchema?: object,
  ) {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: system,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        response_format: jsonSchema
          ? {
              type: "json_schema",
              json_schema: jsonSchema,
            }
          : undefined,
      }),
    });

    if (resp.ok) {
      const json: {
        choices: { message: { content: string } }[];
      } = await resp.json();
      if (jsonSchema) {
        return JSON.parse(json.choices[0].message.content);
      } else {
        return json.choices[0].message.content;
      }
    }

    throw Error(`status code: ${resp.status} ${await resp.text()}`);
  }
}
