import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  exchangeMal,
  malClient,
  type MalTokens,
  type MalRequest,
} from "../app/electron/myanimelist";

const sessions = new Map<
  string,
  {
    expires: number;
    state?: string;
    verifier?: string;
    tokens?: MalTokens;
    request?: MalRequest;
    pending?: boolean;
  }
>();
let active = 0;
export async function handleMal(req: IncomingMessage, res: ServerResponse) {
  const origin = process.env.MAL_WEB_ORIGIN || "https://nen.crygup.com";
  const redirect = origin + "/mal-callback";
  const clientId = process.env.mal_web_id || "05d7e76a5113c1353dfeeb192e1a05e6";
  const secret = process.env.mal_web_secret || "";
  const path = new URL(req.url ?? "/", origin);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "application/json");
  const json = (value: unknown, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(value));
  };
  if (active >= 20) {
    json({ error: "The server is busy. Try again shortly." }, 503);
    return;
  }
  active++;
  try {
    for (const [id, session] of sessions)
      if (session.expires < Date.now()) sessions.delete(id);
    const id = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("nen-mal="))
      ?.slice(8);
    const session = id ? sessions.get(id) : undefined;
    if (path.pathname === "/mal-callback") {
      if (
        req.method !== "GET" ||
        !session?.state ||
        session.pending ||
        path.searchParams.get("state") !== session.state
      ) {
        json(
          { error: "Invalid or expired sign-in response. Connect again." },
          400,
        );
        return;
      }
      session.pending = true;
      const code = path.searchParams.get("code");
      if (!code || code.length > 5000)
        throw Error("MyAnimeList sign-in was cancelled.");
      session.tokens = await exchangeMal(
        clientId,
        {
          grant_type: "authorization_code",
          code,
          code_verifier: session.verifier!,
          redirect_uri: redirect,
        },
        secret,
      );
      session.request = malClient(
        clientId,
        () => session.tokens!,
        (value) => {
          session.tokens = value;
        },
        secret,
      );
      session.state = undefined;
      session.verifier = undefined;
      session.pending = false;
      session.expires = Date.now() + 30 * 86400000;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "MyAnimeList is connected. Return to Nen. You can close this tab.",
      );
      return;
    }
    if (
      req.method !== "POST" ||
      req.headers.origin !== origin ||
      req.headers["x-nen-request"] !== "1" ||
      !req.headers["content-type"]?.startsWith("application/json")
    ) {
      json({ error: "Invalid request origin." }, 403);
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 20000) throw Error("Request too large.");
    }
    const body = JSON.parse(raw || "{}");
    if (path.pathname === "/nen-mal/start") {
      if (!secret)
        throw Error("MyAnimeList sign-in is not configured on this server.");
      if (sessions.size >= 1000)
        throw Error("Too many sign-in sessions. Try again later.");
      if (id) sessions.delete(id);
      const key = randomBytes(32).toString("hex"),
        nonce = randomBytes(24).toString("hex"),
        verifier = randomBytes(48).toString("base64url");
      sessions.set(key, {
        state: nonce,
        verifier,
        expires: Date.now() + 180000,
      });
      res.setHeader(
        "Set-Cookie",
        `nen-mal=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${origin.startsWith("https:") ? "; Secure" : ""}`,
      );
      json({
        url:
          "https://myanimelist.net/v1/oauth2/authorize?" +
          new URLSearchParams({
            client_id: clientId,
            response_type: "code",
            redirect_uri: redirect,
            state: nonce,
            code_challenge: verifier,
            code_challenge_method: "plain",
          }),
      });
      return;
    }
    if (path.pathname === "/nen-mal/disconnect") {
      if (id) sessions.delete(id);
      res.setHeader(
        "Set-Cookie",
        `nen-mal=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`,
      );
      json({ connected: false });
      return;
    }
    if (path.pathname === "/nen-mal/state") {
      json({ connected: !!session?.request });
      return;
    }
    if (!session?.request) {
      json({ error: "Connect MyAnimeList again." }, 401);
      return;
    }
    if (path.pathname !== "/nen-mal/request" || typeof body.path !== "string")
      throw Error("Invalid operation.");
    const method = body.method ?? "GET",
      url = new URL(body.path, "https://api.myanimelist.net");
    if (
      url.origin !== "https://api.myanimelist.net" ||
      !body.path.startsWith("/")
    )
      throw Error("Invalid API path.");
    if (method === "GET") {
      if (!["/users/@me", "/users/@me/animelist"].includes(url.pathname))
        throw Error("Invalid API path.");
      if (
        [...url.searchParams.keys()].some(
          (key) => !["limit", "offset", "nsfw", "fields"].includes(key),
        )
      )
        throw Error("Invalid list parameters.");
    } else {
      if (
        !/^\/anime\/[1-9]\d{0,7}\/my_list_status$/.test(body.path) ||
        !["PATCH", "DELETE"].includes(method)
      )
        throw Error("Invalid list update.");
      if (method === "PATCH") {
        const value = body.body;
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).some(
            (key) =>
              ![
                "status",
                "is_rewatching",
                "num_watched_episodes",
                "num_times_rewatched",
                "score",
                "comments",
              ].includes(key),
          )
        )
          throw Error("Invalid list fields.");
        if (
          value.status !== undefined &&
          ![
            "watching",
            "completed",
            "on_hold",
            "dropped",
            "plan_to_watch",
          ].includes(value.status)
        )
          throw Error("Invalid status.");
        if (
          value.is_rewatching !== undefined &&
          typeof value.is_rewatching !== "boolean"
        )
          throw Error("Invalid rewatch flag.");
        for (const key of [
          "num_watched_episodes",
          "num_times_rewatched",
          "score",
        ])
          if (
            value[key] !== undefined &&
            (!Number.isSafeInteger(value[key]) ||
              value[key] < 0 ||
              value[key] > (key === "score" ? 10 : 100000))
          )
            throw Error("Invalid numeric field.");
        if (
          value.comments !== undefined &&
          (typeof value.comments !== "string" || value.comments.length > 10000)
        )
          throw Error("Invalid notes.");
      }
    }
    json((await session.request(body.path, method, body.body)) ?? null);
  } catch (error) {
    json(
      {
        error:
          error instanceof Error
            ? error.message
            : "MyAnimeList request failed.",
      },
      400,
    );
  } finally {
    active--;
  }
}
