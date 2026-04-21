import { render } from "preact";

import "./index.css";
import ValidateApp from "./ValidateApp.tsx";
import { MiniApp } from "./MiniApp.tsx";

if (window.Telegram.WebApp.themeParams.bg_color) {
  document.body.style.backgroundColor = window.Telegram.WebApp.themeParams.bg_color
}

render(
  import.meta.env.PROD ? (
    <ValidateApp>
      <MiniApp />
    </ValidateApp>
  ) : (
    <MiniApp />
  ),
  document.getElementById("root")!,
);
