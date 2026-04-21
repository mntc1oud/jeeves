import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { Brain, type BrainContext } from "../../workers/bot/brain";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jobsTable, Status } from "../../workers/bot/db_schema";
import testPageWithNoise from "./page.test.html?raw";
import outputCleanFromHtmlPage from "./page.output.txt?raw";
import ashByApiTest from "./ashbyapi.test.json?raw";
import r from "../../workers/bot/resources/responses.en.json";

function createContext(): [BrainContext, Mock, Mock, Mock] {
  const [send, edit, delMsg] = [
    vi.fn().mockImplementation(async () => 1), // return id
    vi.fn(),
    vi.fn(),
  ];
  const ctx: BrainContext = {
    send,
    edit,
    delMsg,
  };

  return [ctx, send, edit, delMsg];
}

describe("brain testing", () => {
  beforeEach(() => {
    vi.spyOn(env.awaitedJobs, "insert").mockImplementation(async () => {
      return { ids: [], count: 0 };
    });

    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      return { data: [[], []] };
    });
  });

  afterEach(async () => {
    await env.state.delete("unprocessed");
    await env.state.delete("lastMessageDate");
    await env.state.delete("lastMessageId");

    await drizzle(env.memory).delete(jobsTable);
  });

  it("pull state from KV on start and write it back in the end", async () => {
    await env.state.put("unprocessed", JSON.stringify(["hello"]));

    const brain = await Brain.on();

    expect(brain.enabled).toBe(false);
    expect(brain.unprocessed).toStrictEqual(["hello"]);
    expect(brain.lastMessageId).toBeUndefined();

    brain.unprocessed.push("hey");

    await brain.off();

    const data = await env.state.get("unprocessed");
    const enabled = await env.state.get("enabled");
    expect(enabled).toBeNull();
    expect(data).toBe('["hello","hey"]');
  });

  it("send start", async () => {
    const [send, edit, delMsg] = [
      vi.fn().mockImplementation(async () => 1), // return id
      vi.fn().mockImplementation(async () => {
        throw new Error("not ok");
      }),
      vi.fn(),
    ];
    const ctx: BrainContext = {
      send,
      edit,
      delMsg,
    };

    await Brain.act(ctx, "say_hello");

    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall![0]).toMatch("> _Письма с отказом_ \\- *0*");

    expect(await env.state.get("lastMessageId")).toBe("1");
  });

  it("switch bot on/off", async () => {
    const [ctx, send, edit, delMsg] = createContext();
    await Brain.act(ctx, "switch_bot_on_off");

    expect(ctx.edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.lastCall![1]).toStrictEqual([
      { name: "Выключить", action: "switch_bot_on_off" },
    ]);
  });

  describe("collect incoming messages links and plain texts", () => {
    it("basic adding links and plain text, processing via LLM and storing in DB", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(testPageWithNoise),
      );

      const [ctx, send, edit, delMsg] = createContext();
      const fakeMsgId = 3;
      const time = 420;

      await env.state.put("lastMessageId", "1");

      await Brain.send(
        ctx,
        "https://alpaca.markets/careers/devsecops-engineer",
        time,
        fakeMsgId,
      );

      expect(ctx.edit).toHaveBeenCalledTimes(2);
      expect(edit.mock.calls[0][0]).toMatch(
        "*[alpaca\\.markets](https://alpaca.markets/careers/devsecops-engineer)* _в процессе_",
      );
      expect(edit.mock.calls[1][0]).toMatch(
        "*[Job Application for DevSecOps Engineer at Alpaca](https://alpaca.markets/careers/devsecops-engineer)*",
      ); // text that replaces the old one

      const text = JSON.parse((await env.state.get("unprocessed"))!)[0].text;

      expect(text).toBe(outputCleanFromHtmlPage);

      // to test how code processes plain text with urls
      await Brain.send(
        ctx,
        `About us

Ruby Labs is a leading tech company that creates and operates innovative consumer products.

About the role

At one of Ruby Labs' portfolio companies, we are looking for a Senior Full-Stack Software Developer.`,
        time,
        fakeMsgId,
      );

      expect(ctx.edit).toHaveBeenCalledTimes(3);
      expect(edit.mock.lastCall![0]).toMatch(
        "**> About us Ruby Labs is a leading tech company that creates and operates innovative consumer products\\. About the role",
      );

      expect(ctx.delMsg).toHaveBeenCalledTimes(2);
      expect(delMsg.mock.lastCall![0]).toBe(fakeMsgId);

      const val = JSON.parse((await env.state.get("unprocessed"))!);
      expect(val.length).toBe(2);
      expect(await env.state.get("lastMessageId")).not.toBeNull();

      // 2. start process
      vi.spyOn(env.aletheia, "send").mockResolvedValueOnce();

      await Brain.act(ctx, "start_process");

      expect(ctx.edit).toHaveBeenCalledTimes(4);
      expect(edit.mock.calls[3][0]).toMatch(
        "Так просмотрю и внесю в свои заметки\\.\\.\\.",
      );
      expect(edit.mock.calls[3][2]).toBe(1);
      expect(await env.state.get("lastMessageId")).not.toBeNullable();

      // 3. details extraction with LLM
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    jobs: [
                      {
                        positionName: "DevSecOps Engineer",
                        companyName: "alpaca",
                        companyDesc:
                          "A project management tool built for high-performance software teams, known for its speed and elegant design.",
                      },
                      {
                        positionName: "Senior Full-Stack Software Developer.",
                        companyName: "Ruby Labs",
                        companyDesc:
                          "An open-source Firebase alternative providing a Postgres database, authentication, storage, and edge functions for developers.",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        ),
      );

      await Brain.command(ctx, {
        name: "extractWithLLM",
      });

      expect(ctx.edit).toHaveBeenCalledTimes(5);
      expect(edit.mock.lastCall![0]).toMatch("Мое почтение, сэр");

      expect(await env.state.get("unprocessed")).toBe("[]");
      expect(await env.state.get("lastMessageId")).not.toBeNull();

      const rows = await drizzle(env.memory).select().from(jobsTable);

      expect(rows.length).toBe(2);
      expect(rows[0].emailLetter).toBeNull();
      expect(rows[0].position).toBe("DevSecOps Engineer");
      expect(rows[0].status).toBe(Status.InProgress);
    });

    it("collect ashby job links", async () => {
      vi.spyOn(global, "fetch").mockImplementationOnce(async (input, req) => {
        console.log(input);
        if (typeof input == "string" && /\/ruby-labs/.test(input)) {
          return new Response(ashByApiTest, { status: 200 });
        }

        throw new Error("no matches");
      });

      const [ctx, send, edit, delMsg] = createContext();
      const fakeMsgId = 3;
      const time = 420;

      await env.state.put("lastMessageId", "1");

      await Brain.send(
        ctx,
        "https://jobs.ashbyhq.com/ruby-labs/e5a16ca6-f085-4b0e-adcd-ec7a201f1c0c",
        time,
        fakeMsgId,
      );

      expect(ctx.edit).toHaveBeenCalledTimes(2);
      expect(edit.mock.calls[0][0]).toMatch(
        "*[jobs\\.ashbyhq\\.com](https://jobs.ashbyhq.com/ruby-labs/e5a16ca6-f085-4b0e-adcd-ec7a201f1c0c)* _в процессе_",
      );
      expect(edit.mock.calls[1][0]).toMatch(
        "*[Product Manager](https://jobs.ashbyhq.com/ruby-labs/e5a16ca6-f085-4b0e-adcd-ec7a201f1c0c)*",
      ); // text that replaces the old one

      const unprocessed = await env.state.get("unprocessed");

      expect(unprocessed).toMatch(`"isOk":true`);
    });
    it("handle plain text job description as two separate messages, sent at the same time by client", async () => {
      const [ctx, send, edit, delMsg] = createContext();
      const fakeMsgId = 3;
      const time = 420;

      await env.state.put("lastMessageId", "1");

      // to test how code processes plain text with urls
      await Brain.send(ctx, `helloo`, time, fakeMsgId);

      await Brain.send(ctx, `gibberish`, time, fakeMsgId);

      expect(ctx.edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.lastCall![0]).toMatch("**> helloo");

      expect(ctx.delMsg).toHaveBeenCalledTimes(2);
      expect(delMsg.mock.lastCall![0]).toBe(fakeMsgId);

      const val = JSON.parse((await env.state.get("unprocessed"))!);
      expect(val.length).toBe(1);
    });

    it("handle error response from fetch, while compiling list", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response("", { status: 401 }),
      );

      const [ctx, send, edit, delMsg] = createContext();
      const fakeMsgId = 3;

      await env.state.put("lastMessageId", "1");

      await Brain.send(
        ctx,
        "https://supabase.com/careers/backend-engineer",
        fakeMsgId,
      );

      expect(ctx.edit).toHaveBeenCalledTimes(2);
      expect(edit.mock.calls[0][0]).toMatch(
        "*[supabase\\.com](https://supabase.com/careers/backend-engineer)* _в процессе_",
      );
      expect(edit.mock.calls[1][0]).toMatch(
        "*[supabase\\.com](https://supabase.com/careers/backend-engineer)* _Не могу получить_",
      ); // text that replaces the old one
    });

    it("start data-extraction with LLM, handle 'can't start queue' error", async () => {
      vi.spyOn(env.aletheia, "send").mockRejectedValueOnce(
        new Error("just to trigger"),
      );

      const [ctx, send, edit, delMsg] = createContext();
      await env.state.put("lastMessageId", "2");
      const unprocessed = JSON.stringify([
        {
          url: "https://supabase.com/careers/backend-engineer",
          isOk: true,
          text: "hello!",
        },
      ]);
      await env.state.put("unprocessed", unprocessed);

      await Brain.act(ctx, "start_process");

      expect(ctx.edit).toHaveBeenCalledTimes(2);
      expect(edit.mock.calls[0][0]).toMatch(
        "Так просмотрю и внесю в свои заметки\\.\\.\\.",
      );
      expect(edit.mock.calls[0][2]).toBe(2);

      expect(edit.mock.lastCall![0]).toMatch("Что\\-то пошло не так");
      expect(edit.mock.lastCall![2]).toBe(2);

      expect(await env.state.get("unprocessed")).toBe(unprocessed);
      expect(await env.state.get("lastMessageId")).not.toBeNullable();
    });
  });

  it("handle error response from fetch, while compiling list", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 401 }),
    );

    const [ctx, send, edit, delMsg] = createContext();
    const fakeMsgId = 3;

    await env.state.put("lastMessageId", "1");

    await Brain.send(
      ctx,
      "https://supabase.com/careers/backend-engineer",
      fakeMsgId,
    );

    expect(ctx.edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0][0]).toMatch(
      "*[supabase\\.com](https://supabase.com/careers/backend-engineer)* _в процессе_",
    );
    expect(edit.mock.calls[1][0]).toMatch(
      "*[supabase\\.com](https://supabase.com/careers/backend-engineer)* _Не могу получить_",
    ); // text that replaces the old one
  });

  describe("handle LLM-assisted data extraction errors", () => {
    it("no valid items to process", async () => {
      const [ctx, send, edit, delMsg] = createContext();
      await env.state.put("lastMessageId", "2");
      await env.state.put(
        "unprocessed",
        JSON.stringify([
          {
            url: "https://supabase.com/careers/backend-engineer",
            isOk: false,
          },
        ]),
      );

      await Brain.command(ctx, {
        name: "extractWithLLM",
      });

      expect(ctx.edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.lastCall![0]).toMatch("Что\\-то пошло не так");
      expect(edit.mock.lastCall![2]).toBe(2);

      expect(await env.state.get("unprocessed")).toBe("[]");
      expect(await env.state.get("lastMessageId")).not.toBeNullable();
    });

    it("OpenRouter API error", async () => {
      vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 401,
              message: "Invalid credentials",
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      const [ctx, send, edit, delMsg] = createContext();
      await env.state.put("lastMessageId", "2");
      const unprocessed = JSON.stringify([
        {
          url: "https://supabase.com/careers/backend-engineer",
          isOk: true,
          text: "hello!",
        },
      ]);
      await env.state.put("unprocessed", unprocessed);

      await Brain.command(ctx, {
        name: "extractWithLLM",
      });

      expect(ctx.edit).toHaveBeenCalledTimes(1);
      expect(edit.mock.lastCall![0]).toMatch("Что\\-то пошло не так");
      expect(edit.mock.lastCall![2]).toBe(2);

      expect(await env.state.get("unprocessed")).toBe(unprocessed);
      expect(await env.state.get("lastMessageId")).not.toBeNullable();
    });
  });

  it("handle email arrival, when in process of collecting links and texts", async () => {
    const [ctx, send, edit, delMsg] = createContext();
    await env.state.put("lastMessageId", "1");

    await Brain.send(
      ctx,
      `text yadaayaa`,
      420, //time
      3, //msgid
    );

    await Brain.command(ctx, { name: "sendYouGotMail", input: "wow" });

    expect(send).toHaveBeenCalledTimes(0);
    expect(edit).toHaveBeenCalledTimes(2);

    expect(edit.mock.lastCall![0]).toMatch("Вам пришло новое сообщение\n");
  });

  it("test stats", async () => {
    await drizzle(env.memory)
      .insert(jobsTable)
      .values([
        {
          position: "Frontend Developer",
          status: Status.InProgress,
          emailLetter: "I am very interested in this position...",
          companyName: "Acme Corp",
          companyDesc: "A leading provider of innovative solutions.",
          createdAt: "2025-03-20 10:00:00", // 20 + 30 = 50; 31 - end of march; 50 - 31 = 19 april is 30 days birthday
        },
        {
          position: "Backend Engineer",
          status: Status.Rejected,
          emailLetter: null,
          companyName: "Globex Inc",
          companyDesc:
            "Global tech company focused on scalable cloud infrastructure.",
          createdAt: "2025-03-10 09:30:00", // 10 + 30 = 40; 31 - march end; 40 - 31 = 9 april
        },
        {
          position: "Full Stack Developer",
          status: Status.Invited,
          emailLetter: "I believe my skills are a great match...",
          companyName: "Initech",
          companyDesc: "Enterprise software solutions for mid-size companies.",
          createdAt: "2025-02-25 14:00:00", // 25 + 30 = 55; 28 - february end; 55 - 28 = 27 march (?)
        },
        {
          position: "DevOps Engineer",
          status: Status.InProgress,
          emailLetter: null,
          companyName: "Stark Industries",
          companyDesc: "Advanced engineering and technology company.",
          createdAt: "2025-02-28 11:15:00", // 28 + 30 = 58; 30 march
        },
        {
          position: "UX Designer",
          status: Status.Rejected,
          emailLetter:
            "To whom it may concern, I would love to join your team...",
          companyName: "Umbrella Ltd",
          companyDesc: "Cutting-edge research and software firm.",
          createdAt: "2025-03-01 16:45:00", // 1 + 30 = 31; 31 march end
        },
      ]);

    const [ctx, send, edit, __] = createContext();

    await Brain.act(ctx, "say_hello");

    expect(edit.mock.lastCall![0]).toMatch(
      `> _${r.correspondence.rejected}_ \\- *2*`,
    );
  });

  it("test stats with one invited job", async () => {
    await drizzle(env.memory)
      .insert(jobsTable)
      .values([
        {
          position: "Full Stack Developer",
          status: Status.Invited,
          emailLetter: "I believe my skills are a great match...",
          companyName: "Initech",
          companyDesc: "Enterprise software solutions for mid-size companies.",
          createdAt: "2025-02-25 14:00:00", // 25 + 30 = 55; 28 - february end; 55 - 28 = 27 march (?)
        },
      ]);

    const [ctx, send, edit, __] = createContext();

    await Brain.act(ctx, "say_hello");

    expect(edit.mock.lastCall![0]).toMatch(
      `> _${r.correspondence.invited}_ \\- *1*`,
    );
  });
});
