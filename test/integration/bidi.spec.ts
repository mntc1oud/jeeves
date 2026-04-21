import { describe, expect, it } from "vitest";
import { Browser } from "../../workers/plushkin/browser";
import * as Bidi from "../../workers/plushkin/bidi_gen";
import { plugins } from "../../workers/plushkin/mitigations";

describe("Mansion: BiDi client", () => {
  it("connect, open session, subscribe to events", async () => {
    const mansion = await Browser.connect(9222);
    await mansion.close();
  });

  it("open tab, fetch a page and close tab", { timeout: 5000 }, async () => {
    const mansion = await Browser.connect(9222);

    const text = await mansion.fetch("https://example.com");
    await mansion.close();

    expect(text).toBe(
      '<!DOCTYPE html><html lang="en"><head><title>Example Domain</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#eee;width:60vw;margin:15vh auto;font-family:system-ui,sans-serif}h1{font-size:1.5em}div{opacity:0.8}a:link,a:visited{color:#348}</style></head><body><div><h1>Example Domain</h1><p>This domain is for use in documentation examples without needing permission. Avoid use in operations.</p><p><a href="https://iana.org/domains/example">Learn more</a></p></div>\n' +
        "</body></html>",
    );
  });

  it("wait for value", { timeout: 5000 }, async ({ expect }) => {
    const mansion = await Browser.connect(9222);
    const url = "https://example.com/";

    const { context } = await mansion.send("browsingContext.create", {
      type: Bidi.BrowsingContext.CreateType.Tab,
    });

    await mansion.sendAndWaitFor(
      "browsingContext.navigate",
      { context, url },
      "browsingContext.domContentLoaded",
    );

    await mansion.waitForValue(context, () => true, 2000);

    await expect(
      mansion.waitForValue(context, () => false, 1000),
    ).rejects.toThrow("TimeoutError: The operation timed out");

    await mansion.close();
  });

  it("click on link", async () => {
    const mansion = await Browser.connect(9222);
    const url = "https://mdn.github.io/dom-examples/history-api/";

    const { context } = await mansion.send("browsingContext.create", {
      type: Bidi.BrowsingContext.CreateType.Tab,
    });

    await mansion.sendAndWaitFor(
      "browsingContext.navigate",
      { context, url },
      "browsingContext.domContentLoaded",
    );

    await Promise.all([
      mansion.waitFor("browsingContext.historyUpdated"),
      mansion.click(context, ".nav li:nth-child(2) a"),
    ]);

    const resp = await mansion.send("script.evaluate", {
      expression: "document.location.pathname",
      target: { context },
      awaitPromise: false,
    });

    await mansion.close();

    if (resp.type == "success" && resp.result.type == "string") {
      expect(resp.result.value, "/dom-examples/history-api/eagle");
    } else {
      // useless, yes
      expect(false).toBeTruthy();
    }
  });
});

describe("Mitigations plugins", () => {
  it("Cloudflare mitigation", { timeout: 20000 }, async () => {
    const mansion = await Browser.connect(9222, plugins);

    const text = await mansion.fetch("https://hiring.cafe/");
    await mansion.close();

    console.log(text);
  });
});
