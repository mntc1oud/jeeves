import * as Bidi from "./bidi_gen";

export interface Plugin {
  name: string;
  plug: (api: Browser, context: string) => Promise<void>;
}

const inject = () => {
  // with this simple trick, we can just say "fuck you"
  // to simple bot detection
  Object.defineProperty(navigator, "webdriver", {
    get: () => false,
  });

  // @ts-expect-error "Window"
  window.Mansion = {
    element(selector: string) {
      // @ts-expect-error "Window"
      const element = document.querySelector(selector);

      if (element) {
        return element.getBoundingClientRect().toJSON();
      }

      return null;
    },

    wait(timeout: number, fn: () => boolean) {
      return new Promise((resolve, reject) => {
        const abort = AbortSignal.timeout(timeout);

        const poll = () => {
          const result = !!fn();

          if (!result) {
            // @ts-expect-error "Window"
            window.requestAnimationFrame(poll);
            return;
          }

          resolve(result);
        };

        // @ts-expect-error "injected"
        const id = window.requestAnimationFrame(poll);
        abort.addEventListener("abort", () => {
          //@ts-expect-error "inject"
          window.cancelAnimationFrame(id);
          reject(abort.reason);
        });
      });
    },
  };
};

export class Browser {
  _id_counter = 0;
  _subscription: string | undefined;

  // (clients) send *orders*, what it will have, and awaits for the data
  // (waiter) onmessage callback processes a message, takes an order and deliver via resolve or reject
  // TODO: how to handle multirequests with this system
  _orders: Map<number | string, PromiseWithResolvers<Bidi.Message>> = new Map();

  ws: WebSocket;
  plugins: Plugin[]; // maybe delegate some processing to them

  static async connect(port: number, plugins: Plugin[] = []) {
    const ws = await new Promise<WebSocket>((resl, rej) => {
      // NOTE(win?): use localhost instead of 127.0.0.1 address.
      // With 127.0.0.1 workerd has a memory leak, when tries to connect.
      const ws = new WebSocket(`ws://localhost:${port}/session`);

      ws.addEventListener("open", () => resl(ws), { once: true });
      ws.addEventListener("error", (ev) => rej(ev), { once: true });
    });

    const automation = new Browser(ws, plugins);

    // setup session
    const status = await automation.send("session.status", {});

    if (status.ready) {
      const session = await automation.send("session.new", {
        capabilities: {},
      });

      console.log(session);

      await automation.subscribe(["script", "browsingContext"]);

      await automation.send("script.addPreloadScript", {
        functionDeclaration: inject.toString(),
      });
    } else {
      throw new Error("The browser is not ready for session");
    }

    return automation;
  }

  constructor(transport: WebSocket, plugins: Plugin[]) {
    this.plugins = plugins;
    this.ws = transport;
    this.ws.addEventListener("message", (msg) => {
      const resp = JSON.parse(msg.data) as Bidi.Message;

      if ("id" in resp && resp.type != "event") {
        const order = this._orders.get(resp.id!);

        if (order) {
          if (resp.type == "success") {
            order.resolve(resp);
          } else {
            order.reject({
              error: resp.error,
              details: resp.message,
              stack: resp.stacktrace,
            });
          }
        }
      } else {
        const order = this._orders.get(resp.method);

        if (order) {
          order.resolve(resp);
        }
      }
    });
  }

  async fetch(url: string) {
    const { context } = await this.send("browsingContext.create", {
      type: Bidi.BrowsingContext.CreateType.Tab,
    });

    await this.sendAndWaitFor(
      "browsingContext.navigate",
      { context, url },
      "browsingContext.domContentLoaded",
    );

    for (const interceptor of this.plugins) {
      await interceptor.plug(this, context);
    }

    const code = () => {
      let content = "";

      // @ts-expect-error "w"
      for (const node of document.childNodes) {
        switch (node) {
          // @ts-expect-error "w"
          case document.documentElement:
            // @ts-expect-error "w"
            content += document.documentElement.outerHTML;
            break;
          default:
            // @ts-expect-error "w"
            content += new XMLSerializer().serializeToString(node);
            break;
        }
      }

      return content;
    };

    const evalResults = await this.send("script.evaluate", {
      expression: `(${code})()`,
      target: { context },
      awaitPromise: false,
    });

    // close tab
    await this.send("browsingContext.close", {
      context,
    });

    if (evalResults.type == "success" && evalResults.result.type == "string") {
      return evalResults.result.value;
    } else {
      throw new Error("Can't evaluate expression");
    }
  }

  async subscribe(events: [string, ...string[]]) {
    const { subscription } = await this.send("session.subscribe", {
      events,
    });
    this._subscription = subscription;
  }

  async click(context: string, selector: string) {
    const resp = await this.send("script.evaluate", {
      expression: `Mansion.element("${selector}")`,
      target: { context },
      awaitPromise: false,
    });

    if (resp.type == "success") {
      if (resp.result.type == "object") {
        const [x, y, width, height] = resp.result.value!.map((entry) => {
          const entryValue = entry[1];
          if (
            entryValue.type == "number" &&
            typeof entryValue.value == "number"
          ) {
            return entryValue.value;
          }
          return 0;
        });

        await this.send("input.performActions", {
          context: context,
          actions: [
            {
              type: "pointer",
              id: "__mansion_mouse",
              actions: [
                {
                  type: "pointerMove",
                  x: x + width / 2,
                  y: y + height / 2,
                },
                {
                  type: "pointerDown",
                  // Left Button (https://github.com/puppeteer/puppeteer/blob/e508468a0348e79158cba8576e58f71877b288be/packages/puppeteer-core/src/bidi/Input.ts#L433)
                  button: 0,
                },
                {
                  type: "pointerUp",
                  button: 0,
                },
              ],
            },
          ],
        });
      }
      // move mouse to the element and click
    } else {
      throw new Error(resp.exceptionDetails.text);
    }
  }

  async waitForValue(
    context: string,
    fn: () => boolean,
    timeout: number = 30000,
  ) {
    await this.send("script.evaluate", {
      expression: `Mansion.wait(${timeout}, ${fn.toString()})`,
      target: { context },
      awaitPromise: true,
    }).catch((err) => {
      // stupid workaround to handle timeout error, that is wrapped in unknown error
      // we're getting an unknown error because we're using a preloaded object
      // which doesn't have any stacktrace in exception after call, and
      // stacktrace is required to build response on the remote side
      // TODO: come up with a different way to inject helpers
      if (/TimeoutError/.test(err.details))
        throw new Error("TimeoutError: The operation timed out");
      else throw new Error(`${err.error}: ${err.details}`);
    });
  }

  //
  // Core methods
  //

  async sendAndWaitFor<
    Command extends keyof BidiCommandMap,
    EventName extends keyof BidiEventMap,
  >(
    command: Command,
    params: BidiCommandMap[Command]["params"],
    event: EventName,
  ): Promise<BidiEventMap[EventName]["params"] | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [eventResults, _] = await Promise.all([
      this.waitFor(event),
      this.send(command, params),
    ]);

    return eventResults;
  }

  async waitFor<EventName extends keyof BidiEventMap>(
    event: EventName,
  ): Promise<BidiEventMap[EventName]["params"] | undefined> {
    this._orders.set(event, Promise.withResolvers());

    try {
      const signal = AbortSignal.timeout(30000);
      signal.addEventListener(
        "abort",
        () => this._orders.get(event)!.reject("got timeout..."),
        { once: true },
      );

      const data = await this._orders.get(event)!.promise;

      if (data.type == "event") {
        return data.params;
      }
    } finally {
      this._orders.delete(event);
    }
  }

  async send<Command extends keyof BidiCommandMap>(
    command: Command,
    params: BidiCommandMap[Command]["params"],
  ): Promise<BidiCommandMap[Command]["result"]> {
    const id = ++this._id_counter;

    this._orders.set(id, Promise.withResolvers());
    this.ws.send(
      JSON.stringify({
        id,
        method: command,
        params,
      }),
    );

    try {
      const msg = await this._orders.get(id)!.promise;

      if ("result" in msg && !("error" in msg)) {
        return msg.result;
      }
    } finally {
      this._orders.delete(id);
    }

    return {};
  }

  async destroy() {}

  async close() {
    await this.send("session.end", {});

    this.ws.close();
  }
}

export interface BidiEventMap {
  // BrowsingContext
  "browsingContext.contextCreated": { params: Bidi.BrowsingContext.Info };
  "browsingContext.contextDestroyed": { params: Bidi.BrowsingContext.Info };
  "browsingContext.domContentLoaded": {
    params: Bidi.BrowsingContext.NavigationInfo;
  };
  "browsingContext.downloadEnd": {
    params: Bidi.BrowsingContext.DownloadEndParams;
  };
  "browsingContext.downloadWillBegin": {
    params: Bidi.BrowsingContext.DownloadWillBeginParams;
  };
  "browsingContext.fragmentNavigated": {
    params: Bidi.BrowsingContext.NavigationInfo;
  };
  "browsingContext.historyUpdated": {
    params: Bidi.BrowsingContext.HistoryUpdatedParameters;
  };
  "browsingContext.load": { params: Bidi.BrowsingContext.NavigationInfo };
  "browsingContext.navigationAborted": {
    params: Bidi.BrowsingContext.NavigationInfo;
  };
  "browsingContext.navigationCommitted": {
    params: Bidi.BrowsingContext.NavigationInfo;
  };
  "browsingContext.navigationFailed": {
    params: Bidi.BrowsingContext.NavigationInfo;
  };
  "browsingContext.navigationStarted": {
    params: Bidi.BrowsingContext.NavigationInfo;
  };
  "browsingContext.userPromptClosed": {
    params: Bidi.BrowsingContext.UserPromptClosedParameters;
  };
  "browsingContext.userPromptOpened": {
    params: Bidi.BrowsingContext.UserPromptOpenedParameters;
  };

  // Input
  "input.fileDialogOpened": { params: Bidi.Input.FileDialogInfo };

  // Log
  "log.entryAdded": { params: Bidi.Log.Entry };

  // Network
  "network.authRequired": { params: Bidi.Network.AuthRequiredParameters };
  "network.beforeRequestSent": {
    params: Bidi.Network.BeforeRequestSentParameters;
  };
  "network.fetchError": { params: Bidi.Network.FetchErrorParameters };
  "network.responseCompleted": {
    params: Bidi.Network.ResponseCompletedParameters;
  };
  "network.responseStarted": { params: Bidi.Network.ResponseStartedParameters };

  // Script
  "script.message": { params: Bidi.Script.MessageParameters };
  "script.realmCreated": { params: Bidi.Script.RealmInfo };
  "script.realmDestroyed": { params: Bidi.Script.RealmDestroyedParameters };
}

export interface BidiCommandMap {
  // Session
  "session.status": {
    params: Bidi.EmptyParams;
    result: Bidi.Session.StatusResult;
  };
  "session.new": {
    params: Bidi.Session.NewParameters;
    result: Bidi.Session.NewResult;
  };
  "session.end": { params: Bidi.EmptyParams; result: Bidi.Session.EndResult };
  "session.subscribe": {
    params: Bidi.Session.SubscribeParameters;
    result: Bidi.Session.SubscribeResult;
  };
  "session.unsubscribe": {
    params: Bidi.Session.UnsubscribeParameters;
    result: Bidi.Session.UnsubscribeResult;
  };

  // Browser
  "browser.close": {
    params: Bidi.EmptyParams;
    result: Bidi.Browser.CloseResult;
  };
  "browser.createUserContext": {
    params: Bidi.Browser.CreateUserContextParameters;
    result: Bidi.Browser.CreateUserContextResult;
  };
  "browser.getClientWindows": {
    params: Bidi.EmptyParams;
    result: Bidi.Browser.GetClientWindowsResult;
  };
  "browser.getUserContexts": {
    params: Bidi.EmptyParams;
    result: Bidi.Browser.GetUserContextsResult;
  };
  "browser.removeUserContext": {
    params: Bidi.Browser.RemoveUserContextParameters;
    result: Bidi.Browser.RemoveUserContextResult;
  };
  "browser.setClientWindowState": {
    params: Bidi.Browser.SetClientWindowStateParameters;
    result: Bidi.Browser.SetClientWindowStateResult;
  };
  "browser.setDownloadBehavior": {
    params: Bidi.Browser.SetDownloadBehaviorParameters;
    result: Bidi.Browser.SetDownloadBehaviorResult;
  };

  // BrowsingContext
  "browsingContext.activate": {
    params: Bidi.BrowsingContext.ActivateParameters;
    result: Bidi.BrowsingContext.ActivateResult;
  };
  "browsingContext.captureScreenshot": {
    params: Bidi.BrowsingContext.CaptureScreenshotParameters;
    result: Bidi.BrowsingContext.CaptureScreenshotResult;
  };
  "browsingContext.close": {
    params: Bidi.BrowsingContext.CloseParameters;
    result: Bidi.BrowsingContext.CloseResult;
  };
  "browsingContext.create": {
    params: Bidi.BrowsingContext.CreateParameters;
    result: Bidi.BrowsingContext.CreateResult;
  };
  "browsingContext.getTree": {
    params: Bidi.BrowsingContext.GetTreeParameters;
    result: Bidi.BrowsingContext.GetTreeResult;
  };
  "browsingContext.handleUserPrompt": {
    params: Bidi.BrowsingContext.HandleUserPromptParameters;
    result: Bidi.BrowsingContext.HandleUserPromptResult;
  };
  "browsingContext.locateNodes": {
    params: Bidi.BrowsingContext.LocateNodesParameters;
    result: Bidi.BrowsingContext.LocateNodesResult;
  };
  "browsingContext.navigate": {
    params: Bidi.BrowsingContext.NavigateParameters;
    result: Bidi.BrowsingContext.NavigateResult;
  };
  "browsingContext.print": {
    params: Bidi.BrowsingContext.PrintParameters;
    result: Bidi.BrowsingContext.PrintResult;
  };
  "browsingContext.reload": {
    params: Bidi.BrowsingContext.ReloadParameters;
    result: Bidi.BrowsingContext.ReloadResult;
  };
  "browsingContext.setViewport": {
    params: Bidi.BrowsingContext.SetViewportParameters;
    result: Bidi.BrowsingContext.SetViewportResult;
  };
  "browsingContext.traverseHistory": {
    params: Bidi.BrowsingContext.TraverseHistoryParameters;
    result: Bidi.BrowsingContext.TraverseHistoryResult;
  };

  // Emulation
  "emulation.setForcedColorsModeThemeOverride": {
    params: Bidi.Emulation.SetForcedColorsModeThemeOverrideParameters;
    result: Bidi.Emulation.SetForcedColorsModeThemeOverrideResult;
  };
  "emulation.setGeolocationOverride": {
    params: Bidi.Emulation.SetGeolocationOverrideParameters;
    result: Bidi.Emulation.SetGeolocationOverrideResult;
  };
  "emulation.setLocaleOverride": {
    params: Bidi.Emulation.SetLocaleOverrideParameters;
    result: Bidi.Emulation.SetLocaleOverrideResult;
  };
  "emulation.setNetworkConditions": {
    params: Bidi.Emulation.SetNetworkConditionsParameters;
    result: Bidi.Emulation.SetNetworkConditionsResult;
  };
  "emulation.setScreenOrientationOverride": {
    params: Bidi.Emulation.SetScreenOrientationOverrideParameters;
    result: Bidi.Emulation.SetScreenOrientationOverrideResult;
  };
  "emulation.setScreenSettingsOverride": {
    params: Bidi.Emulation.SetScreenSettingsOverrideParameters;
    result: Bidi.Emulation.SetScreenSettingsOverrideResult;
  };
  "emulation.setScriptingEnabled": {
    params: Bidi.Emulation.SetScriptingEnabledParameters;
    result: Bidi.Emulation.SetScriptingEnabledResult;
  };
  "emulation.setScrollbarTypeOverride": {
    params: Bidi.Emulation.SetScrollbarTypeOverrideParameters;
    result: Bidi.Emulation.SetScrollbarTypeOverrideResult;
  };
  "emulation.setTimezoneOverride": {
    params: Bidi.Emulation.SetTimezoneOverrideParameters;
    result: Bidi.Emulation.SetTimezoneOverrideResult;
  };
  "emulation.setTouchOverride": {
    params: Bidi.Emulation.SetTouchOverrideParameters;
    result: Bidi.Emulation.SetTouchOverrideResult;
  };
  "emulation.setUserAgentOverride": {
    params: Bidi.Emulation.SetUserAgentOverrideParameters;
    result: Bidi.Emulation.SetUserAgentOverrideResult;
  };

  // Network
  "network.addDataCollector": {
    params: Bidi.Network.AddDataCollectorParameters;
    result: Bidi.Network.AddDataCollectorResult;
  };
  "network.addIntercept": {
    params: Bidi.Network.AddInterceptParameters;
    result: Bidi.Network.AddInterceptResult;
  };
  "network.continueRequest": {
    params: Bidi.Network.ContinueRequestParameters;
    result: Bidi.Network.ContinueRequestResult;
  };
  "network.continueResponse": {
    params: Bidi.Network.ContinueResponseParameters;
    result: Bidi.Network.ContinueResponseResult;
  };
  "network.continueWithAuth": {
    params: Bidi.Network.ContinueWithAuthParameters;
    result: Bidi.Network.ContinueWithAuthResult;
  };
  "network.disownData": {
    params: Bidi.Network.DisownDataParameters;
    result: Bidi.Network.DisownDataResult;
  };
  "network.failRequest": {
    params: Bidi.Network.FailRequestParameters;
    result: Bidi.Network.FailRequestResult;
  };
  "network.getData": {
    params: Bidi.Network.GetDataParameters;
    result: Bidi.Network.GetDataResult;
  };
  "network.provideResponse": {
    params: Bidi.Network.ProvideResponseParameters;
    result: Bidi.Network.ProvideResponseResult;
  };
  "network.removeDataCollector": {
    params: Bidi.Network.RemoveDataCollectorParameters;
    result: Bidi.Network.RemoveDataCollectorResult;
  };
  "network.removeIntercept": {
    params: Bidi.Network.RemoveInterceptParameters;
    result: Bidi.Network.RemoveInterceptResult;
  };
  "network.setCacheBehavior": {
    params: Bidi.Network.SetCacheBehaviorParameters;
    result: Bidi.Network.SetCacheBehaviorResult;
  };
  "network.setExtraHeaders": {
    params: Bidi.Network.SetExtraHeadersParameters;
    result: Bidi.Network.SetExtraHeadersResult;
  };

  // Script
  "script.addPreloadScript": {
    params: Bidi.Script.AddPreloadScriptParameters;
    result: Bidi.Script.AddPreloadScriptResult;
  };
  "script.callFunction": {
    params: Bidi.Script.CallFunctionParameters;
    result: Bidi.Script.CallFunctionResult;
  };
  "script.disown": {
    params: Bidi.Script.DisownParameters;
    result: Bidi.Script.DisownResult;
  };
  "script.evaluate": {
    params: Bidi.Script.EvaluateParameters;
    result: Bidi.Script.EvaluateResult;
  };
  "script.getRealms": {
    params: Bidi.Script.GetRealmsParameters;
    result: Bidi.Script.GetRealmsResult;
  };
  "script.removePreloadScript": {
    params: Bidi.Script.RemovePreloadScriptParameters;
    result: Bidi.Script.RemovePreloadScriptResult;
  };

  // Storage
  "storage.deleteCookies": {
    params: Bidi.Storage.DeleteCookiesParameters;
    result: Bidi.Storage.DeleteCookiesResult;
  };
  "storage.getCookies": {
    params: Bidi.Storage.GetCookiesParameters;
    result: Bidi.Storage.GetCookiesResult;
  };
  "storage.setCookie": {
    params: Bidi.Storage.SetCookieParameters;
    result: Bidi.Storage.SetCookieResult;
  };

  // Input
  "input.performActions": {
    params: Bidi.Input.PerformActionsParameters;
    result: Bidi.Input.PerformActionsResult;
  };
  "input.releaseActions": {
    params: Bidi.Input.ReleaseActionsParameters;
    result: Bidi.Input.ReleaseActionsResult;
  };
  "input.setFiles": {
    params: Bidi.Input.SetFilesParameters;
    result: Bidi.Input.SetFilesResult;
  };

  // WebExtension
  "webExtension.install": {
    params: Bidi.WebExtension.InstallParameters;
    result: Bidi.WebExtension.InstallResult;
  };
  "webExtension.uninstall": {
    params: Bidi.WebExtension.UninstallParameters;
    result: Bidi.WebExtension.UninstallResult;
  };
}
