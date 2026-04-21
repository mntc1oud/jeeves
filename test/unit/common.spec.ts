import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { genBotPlushkinSecretKey, verifyRequest } from "../../workers/common";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("requests verification", () => {
  it("send unauth request", async () => {
    expect(
      await verifyRequest(new IncomingRequest("http://yadad.com")),
    ).toBeFalsy();
  });

  it("send authorized request", async () => {
    const token = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        await genBotPlushkinSecretKey(env.TG_BOT_TOKEN),
        new TextEncoder().encode(env.PLUSHKIN_TRIGGER),
      ),
    );

    const req = new IncomingRequest("https://plushkin.mntcloud.work/fetch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.toString("base64")}`,
      },
      body: JSON.stringify({
        url: "https://hiring.cafe/viewjob/v7rhfqti9vjw5qvd",
      }),
    });

    expect(await verifyRequest(req)).toBeTruthy();
  });
});
