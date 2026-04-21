import { describe, expect, it } from "vitest";
import { isInitDataOk } from "../../workers/bot/telegram";

describe("Telegram Verification", () => {
  it("verify inside of chat!", async () => {
    expect(
      await isInitDataOk(
        new URLSearchParams({
          auth_date: "1742645200",
          hash: "700cbe0a62d18908e7f801dd4c5e613d745f08250572d83f745c796c03be3483",
          query_id: "AAHdF6IQAAAAAN3YogjsQAcd",
          signature:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_fake_ed25519_placeholder",
          user: JSON.stringify({
            id: 123456789,
            first_name: "John",
            last_name: "Doe",
            username: "johndoe",
            language_code: "en",
            is_premium: true,
          }),
        }),
        "test1",
      ),
    ).toBeTruthy();
  });

  it("verify outside the chat", async () => {
    expect(
      await isInitDataOk(
        new URLSearchParams({
          auth_date: "1742645200",
          chat_instance: "-8833452756518176765",
          chat_type: "supergroup",
          hash: "24c95e7d0bca7c0a02321754dbd9296e4a4b0dfcd352e937901f7f326035a77a",
          signature:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_fake_ed25519_placeholder",
          user: JSON.stringify({
            id: 987654321,
            first_name: "Jane",
            last_name: "Smith",
            username: "janesmith",
            language_code: "lv",
            is_premium: false,
          }),
        }),
        "test1",
      ),
    ).toBeTruthy();
  });

  it("ss", () => {});
});
