import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A small site with deterministic, greppable output, so end-to-end assertions
 * can look for exact markers rather than guessing at real-world page noise.
 */
const PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>BrowserTools fixture</title></head>
  <body>
    <h1 id="heading">BrowserTools fixture page</h1>
    <button id="target" data-testid="target">Click me</button>
    <img src="/image.png" />
    <script>
      console.log("MARKER-CONSOLE-LOG");
      console.info("MARKER-CONSOLE-INFO");
      console.warn("MARKER-CONSOLE-WARN");
      console.error("MARKER-CONSOLE-ERROR");

      fetch("/api/ok")
        .then(function (r) { return r.json(); })
        .then(function () { console.log("MARKER-FETCH-OK"); });

      fetch("/api/fail").then(function () { console.log("MARKER-FETCH-FAIL"); });

      fetch("/api/secret").then(function () { console.log("MARKER-FETCH-SECRET"); });

      // Mirrors a real auth provider touching its session endpoint.
      fetch("/v1/client/sessions/sess_3HWEvAAPLW3pElwMd0oolLs5aF7/touch")
        .then(function (r) { return r.json(); })
        .then(function () { console.log("MARKER-FETCH-SESSION"); });

      setTimeout(function () {
        console.log("MARKER-LATE-LOG");
      }, 400);
    </script>
  </body>
</html>`;

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/api/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, marker: "MARKER-RESPONSE-BODY" }));
      return;
    }

    if (url === "/api/fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MARKER-SERVER-ERROR" }));
      return;
    }

    // Used to prove credentials are scrubbed before they reach the store.
    if (url === "/api/secret") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "session=SUPERSECRETCOOKIEVALUE; Path=/",
      });
      res.end(JSON.stringify({ token: "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789" }));
      return;
    }

    // Reproduces the shape of real auth traffic that leaked in manual testing:
    // a long JWT (longer than the 500-char truncation limit) and vendor session
    // ids in both the response body and the URL path.
    if (url.startsWith("/v1/client/sessions/sess_")) {
      const jwt =
        "eyJhbGciOiJSUzI1NiIsImNhdCI6ImNsX0I3ZDRQZDRQZDRQIiwia2lkIjoiaW5zXzJa" +
        "X".repeat(600) +
        ".eyJzdWIiOiJ1c2VyXzJhYmMiLCJzaWQiOiJzZXNzXzNIV0V2QSJ9.SIGNATUREabcdef123456";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          response: {
            object: "client",
            id: "client_3GmhO0nHNv39mTjwcKR6AbTJW0F",
            sessions: [{ object: "session", id: "sess_3HWEvAAPLW3pElwMd0oolLs5aF7", jwt }],
          },
        })
      );
      return;
    }

    // Incompressible pixel noise: the worst case for PNG, used to prove the
    // screenshot budget actually degrades format and scale.
    if (url === "/noise") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body style="margin:0">
        <canvas id="c"></canvas>
        <script>
          const c = document.getElementById("c");
          c.width = window.innerWidth * devicePixelRatio;
          c.height = window.innerHeight * devicePixelRatio;
          c.style.width = window.innerWidth + "px";
          c.style.height = window.innerHeight + "px";
          const ctx = c.getContext("2d");
          const d = ctx.createImageData(c.width, c.height);
          for (let i = 0; i < d.data.length; i += 4) {
            d.data[i] = Math.random() * 255;
            d.data[i + 1] = Math.random() * 255;
            d.data[i + 2] = Math.random() * 255;
            d.data[i + 3] = 255;
          }
          ctx.putImageData(d, 0, 0);
          console.log("MARKER-NOISE-READY");
        </script>
      </body></html>`);
      return;
    }

    if (url === "/map" || url.startsWith("/map?")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html><head><meta charset="utf-8" /><title>Page map</title></head>
        <body>
          <h1>Page map</h1>
          <button id="go" type="button">Run check</button>
          <button id="ghost" type="button" style="visibility:hidden">Ghost</button>
          <div hidden><button type="button">Secret control</button></div>
          <label>Name <input id="name" name="name" /></label>
          <script>
            document.getElementById("go").addEventListener("click", function () {
              console.error("MARKER-MAP-ERROR");
              fetch("/api/fail").catch(function () {});
              history.pushState({}, "", "/map?changed=1");
            });
          </script>
        </body></html>`);
      return;
    }

    if (url === "/form" || url.startsWith("/form?")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html><head><meta charset="utf-8" /><title>Soft form</title></head>
        <body>
          <h1>Soft form</h1>
          <form id="form" action="/form-result" method="get">
            <label>Name <input id="name" name="name" /></label>
            <button id="send" type="submit">Send</button>
          </form>
          <input id="file" type="file" />
          <div id="editor" contenteditable="true"></div>
          <p id="secret">user@example.com</p>
        </body></html>`);
      return;
    }

    if (url.startsWith("/form-result")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><title>Form result</title></head><body><h1>Form result</h1></body></html>");
      return;
    }

    if (url === "/image.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64"
        )
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
