import { useEffect, useState } from "preact/hooks";
import type { PropsWithChildren } from "preact/compat";

function ValidateApp(props: PropsWithChildren) {
  const [isVerified, setVerified] = useState(false);

  useEffect(() => {
    if (window.Telegram.WebApp.initData) {
      fetch(`/verify?${window.Telegram.WebApp.initData}`).then((resp) => {
        resp.json().then((payload) => {
          setVerified(payload.ok ?? false);
        });
      });
    }
  }, []);

  return <>{isVerified ? props.children : <p>Ничего нет</p>}</>;
}

export default ValidateApp;
