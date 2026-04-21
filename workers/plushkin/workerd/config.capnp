using Workerd = import "/workerd/workerd.capnp";

const helloWorldExample :Workerd.Config = (
  services = [ (name = "main", worker = .mainWorker) ],
  sockets = [ ( name = "http", address = "*:8080", http = (), service = "main" ) ]
);


const mainWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "index.js")
  ],
  compatibilityDate = "2025-09-01",
  compatibilityFlags = [
    "nodejs_compat",
    "enable_nodejs_fs_module",
  ],
  bindings = [
    (name = "TG_BOT_TOKEN", fromEnvironment = "TG_BOT_TOKEN"),
    (name = "PLUSHKIN_TRIGGER", fromEnvironment = "PLUSHKIN_TRIGGER")
  ]
);
