import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { exchangeMal } from "./myanimelist";

export async function signInMal(
  clientId: string,
  open: (url: string) => Promise<unknown>,
) {
  const verifier = randomBytes(48).toString("base64url"),
    state = randomBytes(24).toString("hex");
  const redirect = "http://127.0.0.1:43188/callback";
  const code = await new Promise<string>((resolve, reject) => {
    let done = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect);
      if (
        req.headers.host !== "127.0.0.1:43188" ||
        req.method !== "GET" ||
        url.pathname !== "/callback" ||
        url.searchParams.get("state") !== state
      ) {
        res.writeHead(400).end("Invalid sign-in response.");
        return;
      }
      const code = url.searchParams.get("code");
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end(
        code
          ? "Return to Nen to finish connecting MyAnimeList."
          : "MyAnimeList sign-in was cancelled.",
      );
      finish(
        code && code.length <= 5000
          ? undefined
          : Error("MyAnimeList sign-in was cancelled."),
        code ?? undefined,
      );
    });
    const finish = (error?: Error, code?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      error ? reject(error) : resolve(code!);
    };
    const timer = setTimeout(
      () => finish(Error("MyAnimeList sign-in timed out.")),
      180000,
    );
    server.on("error", (error) => finish(error));
    server.listen(43188, "127.0.0.1", () => {
      void open(
        "https://myanimelist.net/v1/oauth2/authorize?" +
          new URLSearchParams({
            client_id: clientId,
            response_type: "code",
            redirect_uri: redirect,
            state,
            code_challenge: verifier,
            code_challenge_method: "plain",
          }),
      ).catch((error) => finish(error));
    });
  });
  return exchangeMal(clientId, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
  });
}
