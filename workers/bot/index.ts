import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jobsTable, Status } from "./db_schema";
import { desc, eq, lt, sql } from "drizzle-orm";
import PostalMime from "postal-mime";
import { isInitDataOk, TelegramBot } from "./telegram";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/verify") && request.method == "GET") {
      console.log({ verify: url.searchParams.toString() });

      let isOk = await isInitDataOk(url.searchParams, env.TG_BOT_TOKEN);

      if (isOk) {
        isOk = JSON.parse(url.searchParams.get("user")!).id == env.TG_USER_ID;
      }

      // TODO: return a cookie with hash based on token too
      return Response.json({
        ok: isOk,
      });
    }

    if (url.pathname.startsWith("/ask")) {
      return new TelegramBot(env.TG_BOT_TOKEN).process(request);
    }

    if (url.pathname == "/api/data" && request.method == "GET") {
      const data = await drizzle(env.memory)
        .select()
        .from(jobsTable)
        .orderBy(desc(jobsTable.createdAt));

      return Response.json({
        jobs: data.map((job) => {
          return {
            ...job,
            status:
              job.status == Status.Invited
                ? "invited"
                : job.status == Status.Rejected
                  ? "rejected"
                  : "awaiting",
          };
        }),
      });
    }

    return new Response(null, { status: 404 });
  },

  async email(msg) {
    const mail = await PostalMime.parse(msg.raw);

    const documentEmbed = await env.AI.run("@cf/google/embeddinggemma-300m", {
      text: `title: ${mail.subject ?? "none"} | text: ${mail.text}`,
    });

    // fetch data from Vectorize
    const jobsSearchResults = await env.awaitedJobs.query(
      documentEmbed.data[0],
    );

    console.log({
      subject: mail.subject,
      ...jobsSearchResults,
    });

    if (jobsSearchResults.count && jobsSearchResults.matches[0].score > 0.5) {
      const id = jobsSearchResults.matches[0].id;

      const db = drizzle(env.memory);
      const classificationEmbed = await env.AI.run(
        "@cf/google/embeddinggemma-300m",
        {
          text: ["Rejection", "Invitation", mail.text].map(
            (content) => `task: classification | query: ${content}`,
          ),
        },
      );

      const [reject, invitation, letterForClassification] =
        classificationEmbed.data;

      await db
        .update(jobsTable)
        .set({
          emailLetter: mail.text,
          status:
            cosineSimilarity(invitation, letterForClassification) >
            cosineSimilarity(reject, letterForClassification)
              ? Status.Invited
              : Status.Rejected,
        })
        .where(eq(jobsTable.id, parseInt(id)));

      const vecMutations = await env.awaitedJobs.deleteByIds([id]);

      console.log({
        deleteResp: vecMutations,
      });

      if (mail.text && env.TG_ENABLE_API) {
        await new TelegramBot(env.TG_BOT_TOKEN).send(
          "sendYouGotMail",
          mail.text,
        );
      }
    } else {
      console.log({
        message: "Didn't find any query matches with this content",
        content: mail.text,
      });
    }

    await msg.forward(env.FORWARD_EMAIL);
  },

  async scheduled() {
    // now - 30 days in milliseconds
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    await drizzle(env.memory)
      .delete(jobsTable)
      .where(lt(jobsTable.createdAt, sql`date(${date.toISOString()})`));

    if (env.TG_ENABLE_API) {
      await new TelegramBot(env.TG_BOT_TOKEN).send("sendGentleMotivation");
    }
  },

  async queue(batch) {
    try {
      await new TelegramBot(env.TG_BOT_TOKEN).send("extractWithLLM");
    } catch (err) {
      console.log("real!");
      console.log(err);
    }

    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;

export function cosineSimilarity(vectorA: number[], vectorB: number[]) {
  const product = vectorA
    .map((dimVal, index) => dimVal * vectorB[index])
    .reduce((sum, curVal) => sum + curVal);

  const magnitudeA = Math.sqrt(
    vectorA
      .map((dimVal) => Math.pow(dimVal, 2))
      .reduce((sum, curVal) => sum + curVal),
  );
  const magnitudeB = Math.sqrt(
    vectorB
      .map((dimVal) => Math.pow(dimVal, 2))
      .reduce((sum, curVal) => sum + curVal),
  );

  return product / (magnitudeA * magnitudeB);
}
