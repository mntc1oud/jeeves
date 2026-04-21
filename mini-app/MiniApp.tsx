import "./MiniApp.css";
import { Jobs } from "./pages/Jobs";

export function MiniApp() {
  return (
    <main style={{ maxWidth: window.innerWidth }}>
      <Jobs />
    </main>
  );
}
