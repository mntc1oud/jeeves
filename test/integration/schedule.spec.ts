import { describe, it, vi } from "vitest";
import bot from "../../workers/bot";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { jobsTable, Status } from "../../workers/bot/db_schema";

describe("scheduled work", () => {
  it("run 30 days cleanup without any data in db", async () => {
    vi.setSystemTime(new Date("2025-04-04T12:00:00Z"));

    await bot.scheduled();
  });

  it("delete only 30 days old job ads every sunday", async ({ expect }) => {
    vi.setSystemTime(new Date("2025-04-04T12:00:00Z"));

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

    await bot.scheduled();

    const snapshot = await drizzle(env.memory).select().from(jobsTable);

    expect(snapshot.length).toBe(2);
    expect(snapshot).toStrictEqual([
      {
        id: 1,
        position: "Frontend Developer",
        status: Status.InProgress,
        emailLetter: "I am very interested in this position...",
        companyName: "Acme Corp",
        companyDesc: "A leading provider of innovative solutions.",
        createdAt: "2025-03-20 10:00:00", // 20 + 30 = 50; 31 - end of march; 50 - 31 = 19 april is 30 days birthday
      },
      {
        id: 2,
        position: "Backend Engineer",
        status: Status.Rejected,
        emailLetter: null,
        companyName: "Globex Inc",
        companyDesc:
          "Global tech company focused on scalable cloud infrastructure.",
        createdAt: "2025-03-10 09:30:00", // 10 + 30 = 40; 31 - march end; 40 - 31 = 9 april
      },
    ]);
  });
});
