import type { Plugin } from "../browser";

export const mitigateCf: Plugin = {
  name: "MitigateCloudflareChallenge",
  async plug(api, context) {
    await api.waitForValue(
      context,
      () => {
        // @ts-expect-error "wow"
        return document.title != "Just a moment...";
      },
      7000,
    );

    console.log("hello!");
  },
};
