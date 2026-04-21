import { useEffect, useState } from "preact/hooks";
import "./Jobs.css";

interface Item {
  id: number;

  position: string;
  status: "awaiting" | "invited" | "rejected";
  companyName: string;
  companyDesc: string;
  emailLetter?: string;
}

const MESSAGE = "My notes are empty, sir";

export function Jobs() {
  const [items, setItems] = useState<Array<Item>>([]);

  useEffect(() => {
    fetch("/api/data").then((resp) => {
      resp.json().then((obj) => {
        setItems((obj as { jobs: Item[] }).jobs);
      });
    });
  }, []);

  return (
    <div class="jobs">
      {items.length ? (
        items.map((item) => (
          <div class="jobCard">
            <h3>{item.position}</h3>
            <div class="company">
              <span>Position from</span>
              <p>
                <span>{item.companyName}</span> {item.companyDesc}
              </p>
            </div>
            <div class={`status ${item.status}`}>
              {item.status == "invited"
                ? "invited"
                : item.status == "rejected"
                  ? "rejected"
                  : "awaiting a reply..."}
            </div>
            {item.status != "awaiting" ? (
              <p class={"email"}>{item.emailLetter}</p>
            ) : undefined}
          </div>
        ))
      ) : (
        <h3 class="message">{MESSAGE}</h3>
      )}
    </div>
  );
}
