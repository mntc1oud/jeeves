import { verifyRequest } from "../common";
import { Browser } from "./browser";
import { plugins } from "./mitigations";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method == "POST" && url.pathname == "/fetch") {
      const isAuthorized = await verifyRequest(request);

      if (isAuthorized) {
        const browser = await Browser.connect(9222, plugins);

        const { url } = await request.json<{ url: string }>();
        const content = await browser.fetch(url);

        return new Response(content);
      } else {
        return new Response("not authorized", { status: 401 });
      }
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
