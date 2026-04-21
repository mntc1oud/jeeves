/* eslint-disable @typescript-eslint/no-unused-vars */
import { beforeAll, describe, expect, it, vi } from "vitest";

import worker, { cosineSimilarity } from "../../workers/bot/index.ts";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jobsTable, Status } from "../../workers/bot/db_schema.ts";
import { eq } from "drizzle-orm";

beforeAll(() => {
  // setup and mock "AI" handlers
  vi.spyOn(env.AI, "run").mockImplementation(async (name, input) => {
    switch (name) {
      case "@cf/google/embeddinggemma-300m": {
        const inputData = input as AiTextEmbeddingsInput;

        const em = await fetch("http://localhost:8080/embedding", {
          method: "POST",
          body: JSON.stringify({
            input: inputData.text,
            embd_normalize: 2,
          }),
        });

        const body =
          await em.json<{ index: number; embedding: number[][] }[]>();

        return {
          shape: [body.length, 756],
          data: body.map((item) => item.embedding[0]),
        };
      }
      default:
        return {};
    }
  });
});

describe("Incoming mail (no jobs are awaited)", () => {
  beforeAll(() => {
    vi.spyOn(env.awaitedJobs, "query").mockImplementation(
      async (vector, opts) => {
        return {
          count: 0,
          matches: [],
        };
      },
    );
  });

  it("handle incoming mail", async () => {
    const mail = new FakeMessage(
      "sender@example.com",
      "recipient@example.com",
      "A YC company wants to connect with you",
      `Hi Alex,

            Good news — a founder at a YC-backed company has reviewed your Work at a Startup profile and wants to chat.

            ── MESSAGE FROM THE FOUNDER ──
            "Hey Alex — I came across your profile and think your background in React and Node.js would be a great fit for what we're building. Would love to hop on a 20-min call to tell you more about Archon. No pressure at all!"
            — Daniel Park, CTO @ Archon AI

            Reply directly to this email to express interest, or log in to manage your profile:
            → https://workatastartup.com/dashboard

            Best,
            The Work at a Startup Team · YCombinator`,
    );

    await worker.email(mail);

    expect(await drizzle(env.memory).select().from(jobsTable)).toStrictEqual(
      [],
    );
  });
});

describe("Incoming mail handling", () => {
  let queriesStore: VectorizeVector[];

  beforeAll(async () => {
    const awaitedJobs = [
      { company: "TechCorp", position: "Frontend Engineer" },
      { company: "NovaSoft", position: "Software Engineer" },
      { company: "Loopbase", position: "Backend Engineer" },
      { company: "Archon AI", position: "Senior Full Stack Engineer" },
      { company: "Stripe", position: "Staff Engineer" },
      { company: "Linear", position: "Full Stack Developer" },
      { company: "Vercel", position: "Developer Relations Engineer" },
      { company: "Figma", position: "Software Engineer, Design Tools" },
    ];

    const embed = await env.AI.run("@cf/google/embeddinggemma-300m", {
      text: awaitedJobs.map(
        (job) =>
          `task: search result | query: Is it letter from ${job.company}, about ${job.position}?`,
      ),
    });

    await drizzle(env.memory)
      .insert(jobsTable)
      .values(
        awaitedJobs.map((job) => {
          return {
            companyName: job.company,
            position: job.position,
            companyDesc: "",
          };
        }),
      );

    queriesStore = embed.data.map((em, index) => {
      return {
        id: `${index + 1}`,
        values: em,
      };
    });
    vi.spyOn(env.awaitedJobs, "query").mockImplementation(
      async (vector, opts) => {
        const queryMatches: VectorizeMatch[] = queriesStore
          .map((query) => {
            return {
              id: query.id,
              score: cosineSimilarity(
                vector as number[],
                query.values as number[],
              ),
            };
          })
          .sort((a, b) => b.score - a.score);

        return {
          count: queryMatches.length,
          matches: queryMatches,
        };
      },
    );

    vi.spyOn(env.awaitedJobs, "deleteByIds").mockResolvedValue({
      ids: [],
      count: 0,
    });

    return async () => {
      await drizzle(env.memory).delete(jobsTable);
    };
  });

  it("filter invitation letter", { timeout: 50000 }, async () => {
    const msg = `Hi Alex,

    Thank you for applying for the Frontend Engineer position at TechCorp.
    We were impressed by your background and would love to invite you to a technical interview.

    We'd like to schedule a 45-minute call with our engineering team to discuss your experience and walk through a short coding exercise.

    Please use the link below to pick a time that works for you:
    https://calendly.com/techcorp-recruiting/frontend-interview

    Looking forward to connecting!

    Best,
    Sarah Chen
    Talent Acquisition · TechCorp`;
    const mail = new FakeMessage(
      "sender@example.com",
      "recipient@example.com",
      "Interview Invitation – Frontend Engineer @ TechCorp",
      msg,
    );

    await worker.email(mail);

    expect(
      await drizzle(env.memory)
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, 1)),
    ).toMatchObject([
      {
        id: 1,
        status: Status.Invited,
        emailLetter: msg + "\n",
      },
    ]);
  });

  it("filter invitation letter (YCombinator)", { timeout: 50000 }, async () => {
    const mail = new FakeMessage(
      "sender@example.com",
      "recipient@example.com",
      "A YC company wants to connect with you",
      `Hi Alex,

        Good news — a founder at a YC-backed company has reviewed your Work at a Startup profile and wants to chat.

        ── MESSAGE FROM THE FOUNDER ──
        "Hey Alex — I came across your profile and think your background in React and Node.js would be a great fit for what we're building. Would love to hop on a 20-min call to tell you more about Archon. No pressure at all!"
        — Daniel Park, CTO @ Archon AI

        Reply directly to this email to express interest, or log in to manage your profile:
        → https://workatastartup.com/dashboard

        Best,
        The Work at a Startup Team · YCombinator`,
    );

    await worker.email(mail);

    expect(
      await drizzle(env.memory)
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, 4)),
    ).toMatchObject([
      {
        // NOTE: I'm not sure is it correct to use those confusing ids?
        id: 4,
        status: Status.Invited,
      },
    ]);
  });

  it("filter rejection letter", { timeout: 50000 }, async () => {
    const mail = new FakeMessage(
      "sender@example.com",
      "recipient@example.com",
      "Your application to NovaSoft – Software Engineer",
      `Hi Alex,

      Thank you for taking the time to apply for the Software Engineer role at NovaSoft and for your patience during our review process.

      After careful consideration, we've decided to move forward with other candidates whose experience more closely matches our current needs. This was a tough decision given the strong pool of applicants.

      We appreciate your interest in NovaSoft and wish you the best in your search.

      Regards,
      The NovaSoft Hiring Team`,
    );

    await worker.email(mail);

    expect(
      await drizzle(env.memory)
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, 2)),
    ).toMatchObject([
      {
        id: 2,
        status: Status.Rejected,
      },
    ]);
  });

  it(
    "filter rejection letter with suggestion to look for suitable positions",
    { timeout: 50000 },
    async () => {
      const mail = new FakeMessage(
        "sender@example.com",
        "recipient@example.com",
        "Update on your application – Backend Engineer",
        `Hi Alex,

        Thanks so much for applying to the Backend Engineer role at Loopbase. We really enjoyed learning more about your experience throughout the process.

        Unfortunately, we've decided to go with a candidate whose background more closely aligns with the specific requirements for this role. This wasn't an easy call.

        That said, we think you'd be a great fit for other positions on our team. We currently have openings in Platform Engineering and Developer Tooling that might be right up your alley:

        → https://loopbase.com/careers

        We'd encourage you to apply — your profile will already be in our system. We hope to find the right match soon.

        Warm regards,
        Priya Nair
        Head of Recruiting · Loopbase`,
      );

      await worker.email(mail);

      expect(
        await drizzle(env.memory)
          .select()
          .from(jobsTable)
          .where(eq(jobsTable.id, 3)),
      ).toMatchObject([
        {
          id: 3,
          status: Status.Rejected,
        },
      ]);
    },
  );

  it(
    "spam without category and doesn't relate to any jobs",
    { timeout: 50000 },
    async () => {
      const dbSnapshotBefore = await drizzle(env.memory)
        .select()
        .from(jobsTable);

      const mail = new FakeMessage(
        "sender@example.com",
        "recipient@example.com",
        "Reminder: You owe Marcus $34.50",
        `Hey Alex,

        Just a friendly nudge — you have an outstanding balance on Splitwise.

        You owe Marcus Webb $34.50
          → Thai food – March 2nd – $34.50

        Settle up via Venmo, PayPal, or mark it paid manually in the app.

        → https://splitwise.com/settle/marcus-webb

        Cheers,
        The Splitwise Team

        You're receiving this because you have an account at splitwise.com.
        Unsubscribe from balance reminders`,
      );

      await worker.email(mail);

      expect(await drizzle(env.memory).select().from(jobsTable)).toStrictEqual(
        dbSnapshotBefore,
      );
    },
  );

  it(
    "newsletter with job suggestions, that may have something inside similiar to awaited jobs",
    { timeout: 50000 },
    async () => {
      const dbSnapshotBefore = await drizzle(env.memory)
        .select()
        .from(jobsTable);

      const mail = new FakeMessage(
        "sender@example.com",
        "recipient@example.com",
        "Weekly Dev Digest #214 – React 19 deep dive, burnout culture, and the tools we're loving",
        `Hey Alex,

        Happy Tuesday! Here's what caught our eye this week.

        ── THIS WEEK'S HIGHLIGHTS ──

        ⚛️  React 19 is here — what actually changed?
        We broke down the new Actions API and concurrent features in plain English.
        → Read the deep dive

        🧠  "Quiet quitting" is out. Burnout architecture is in.
        A thought-provoking piece on how companies unknowingly design for developer exhaustion.
        → Read the article

        🔧  Tools we're loving this week
        - Warp Terminal – AI-native terminal that's genuinely fast
        - Zed Editor – collaborative code editor built in Rust
        - Val Town – deploy JS functions with a URL, instantly

        ── JOB BOARD ──
        Handpicked roles from companies with good eng cultures:
        - Staff Engineer @ Stripe (Remote)
        - Full Stack Dev @ Linear (SF/Remote)
        - DevRel @ Vercel (Remote)

        See all listings → weeklydevdigest.com/jobs

        Until next week,
        — The WDD Team

        Unsubscribe · Manage preferences`,
      );

      await worker.email(mail);

      expect(await drizzle(env.memory).select().from(jobsTable)).toStrictEqual(
        dbSnapshotBefore,
      );
    },
  );
});

class FakeMessage implements ForwardableEmailMessage {
  raw: ReadableStream<Uint8Array<ArrayBufferLike>>;
  headers: Headers;
  rawSize: number;

  constructor(
    from: string,
    to: string,
    subject: string,
    raw: string,
    useRawAsFullMessage: boolean = false,
  ) {
    this.headers = new Headers();

    this.from = from;
    this.to = to;

    const encoder = new TextEncoder();
    const realRaw = encoder.encode(
      useRawAsFullMessage
        ? raw
        : `Received: from smtp.example.com (127.0.0.1)
        by cloudflare-email.com (unknown) id 4fwwffRXOpyR
        for <${to}>; Tue, 27 Aug 2024 15:50:20 +0000
From: "John" <${from}>
Reply-To: ${from}
To: ${to}
Subject: ${subject}
Content-Type: text/plain
X-Mailer: Curl
Date: Tue, 27 Aug 2024 08:49:44 -0700
Message-ID: <6114391943504294873000@ZSH-GHOSTTY>

${raw}`,
    );

    this.raw = new ReadableStream({
      start(controller) {
        controller.enqueue(realRaw);
      },
      pull(controller) {
        controller.close();
      },
    });
    this.rawSize = realRaw.byteLength;
  }

  setReject(reason: string): void {
    throw new Error("Method not implemented.");
  }
  async forward(rcptTo: string, headers?: Headers): Promise<EmailSendResult> {
    return {
      messageId: "0",
    };
  }
  reply(message: EmailMessage): Promise<EmailSendResult> {
    throw new Error("Method not implemented.");
  }

  from: string;
  to: string;
}
