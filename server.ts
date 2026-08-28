// Custom server: plain Next.js request handling plus the /arena websocket
// hub (src/server/hub.ts) on the same port — Railway exposes exactly one.
// Run with tsx (dev: `npm run dev:live`, prod: `npm start`); per the Next
// custom-server guide this file never passes through the Next compiler.
//
// `httpServer` is handed to Next so its own upgrade listeners (dev HMR)
// coexist with ours: the hub only claims the /arena path and leaves every
// other upgrade alone.

import { createServer } from "http";
import next from "next";
import { attachArenaHub } from "./src/server/hub";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";

const server = createServer();
const app = next({ dev, httpServer: server });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  server.on("request", (req, res) => handle(req, res));
  attachArenaHub(server);
  server.listen(port, () => {
    console.log(
      `> flappybid ready on http://localhost:${port} (arena ws at /arena)`
    );
  });
});
