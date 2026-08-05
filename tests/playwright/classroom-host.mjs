import { createServer } from "node:http";

const host = "127.0.0.1";
const port = 4_173;
const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Classroom test host</title>
  </head>
  <body>
    <main>
      <h1>Classroom test host</h1>
      <p>The test mounts a participant-specific whiteboard iframe here.</p>
    </main>
  </body>
</html>`;

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(page);
});

server.listen(port, host);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
