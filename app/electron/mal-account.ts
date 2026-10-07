import { apply, preview, refreshRemote } from "./anilist";
import { readMal, writeMal, malId, type MalRequest } from "./myanimelist";
import {
  prepareMerge,
  applyMerge,
  mergeSummary,
  type MergePlan,
} from "./list-merge";
import type { State, SyncChange } from "../src/shared";

export function malAccount(
  getState: () => State,
  request: MalRequest,
  aniToken: () => string,
  save: () => void,
  otherBusy: () => boolean,
) {
  let busy = false;
  let review:
    | {
        remote: Awaited<ReturnType<typeof readMal>>;
        changes: SyncChange[];
        local: string;
      }
    | undefined;
  let merge: MergePlan | undefined;
  const local = () =>
    JSON.stringify(
      Object.entries(getState().watch).map(([id, e]) => [
        id,
        e.status,
        e.count,
        e.repeat,
      ]),
    );
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    if (getState().settings.privateSession)
      throw Error("Turn off Private session to sync accounts.");
    const deadline = Date.now() + 120000;
    while (busy || otherBusy()) {
      if (Date.now() > deadline)
        throw Error(
          "Account sync is taking longer than expected. Try again shortly.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (getState().settings.privateSession)
      throw Error("Turn off Private session to sync accounts.");
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
      save();
    }
  }
  async function changes(remote: Awaited<ReturnType<typeof readMal>>) {
    const state = getState(),
      eligible = { ...state.watch };
    for (const [id, entry] of Object.entries(eligible)) {
      const base = state.mal!.baseline[id];
      if (
        !remote.entries[id] &&
        base &&
        entry.status === base.status &&
        entry.count === base.count &&
        entry.repeat === base.repeat
      ) {
        delete eligible[id];
        continue;
      }
      if (entry.format === "MUSIC" || remote.entries[id]) continue;
      try {
        await malId(Number(id));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "This anime has no MyAnimeList match."
        )
          throw error;
        delete eligible[id];
        remote.skipped.push(entry.title);
      }
    }
    return preview(eligible, remote.entries, state.mal!);
  }
  const write = (id: number, fields: object) => writeMal(request, id, fields);
  return {
    get busy() {
      return busy;
    },
    get reviewing() {
      return !!merge;
    },
    reset() {
      review = undefined;
      merge = undefined;
    },
    refresh: () =>
      locked(async () => {
        const state = getState();
        if (!state.mal?.connected) throw Error("Connect MyAnimeList first.");
        const remote = await readMal(request);
        await refreshRemote(state.watch, remote.entries, state.mal);
        state.mal.user = remote.user;
        review = undefined;
        return structuredClone(state);
      }),
    importFrom: (
      source: "anilist" | "mal",
      progress?: (percent: number) => void,
    ) =>
      locked(async () => {
        if (source !== "anilist" && source !== "mal")
          throw Error("Invalid import source.");
        if (!getState().mal?.connected || !getState().anilist.connected)
          throw Error("Connect both accounts first.");
        const plan = await prepareMerge(aniToken(), request);
        if (source === "anilist") plan.toAni = [];
        else plan.toMal = [];
        return applyMerge(plan, aniToken(), request, progress);
      }),
    sync: async () => {
      const state = getState();
      if (
        state.settings.privateSession ||
        !state.mal?.connected ||
        !state.mal.lastSync ||
        busy ||
        otherBusy() ||
        review ||
        merge
      )
        return;
      await locked(async () => {
        try {
          const remote = await readMal(request);
          const rows = (await changes(remote)).changes;
          await apply(
            "",
            state.watch,
            remote.entries,
            state.mal!,
            rows.filter((row) => !row.conflict),
            write,
          );
          state.mal!.error = rows.some((row) => row.conflict)
            ? "Some MyAnimeList changes need review. Use Refresh."
            : remote.skipped.length
              ? `${remote.skipped.length} entries have no AniList match.`
              : undefined;
        } catch (error) {
          state.mal!.error =
            error instanceof Error ? error.message : String(error);
        }
      });
    },
    preview: () =>
      locked(async () => {
        if (!getState().mal?.connected)
          throw Error("Connect MyAnimeList first.");
        const remote = await readMal(request);
        const result = await changes(remote);
        review = { remote, changes: result.changes, local: local() };
        getState().mal!.user = remote.user;
        return {
          ...result,
          warning: remote.skipped.length
            ? `${remote.skipped.length} MyAnimeList entries have no AniList match and will be skipped.`
            : undefined,
        };
      }),
    apply: (choices: SyncChange[]) =>
      locked(async () => {
        if (
          !review ||
          review.local !== local() ||
          !Array.isArray(choices) ||
          choices.length !== review.changes.length ||
          choices.some(
            (row, i) =>
              !row ||
              row.mediaId !== review!.changes[i].mediaId ||
              row.field !== review!.changes[i].field ||
              !["local", "remote", undefined].includes(row.choice),
          )
        )
          throw Error("The list changed. Review the sync again.");
        const state = getState();
        await apply(
          "",
          state.watch,
          review.remote.entries,
          state.mal!,
          review.changes.map((row, i) => ({
            ...row,
            choice: choices[i].choice,
          })),
          write,
        );
        review = undefined;
        return structuredClone(state);
      }),
    mergePreview: () =>
      locked(async () => {
        if (!getState().mal?.connected || !getState().anilist.connected)
          throw Error("Connect both accounts first.");
        merge = await prepareMerge(aniToken(), request);
        return mergeSummary(merge);
      }),
    mergeApply: () =>
      locked(async () => {
        if (!merge) throw Error("Preview the migration first.");
        const plan = merge;
        try {
          return await applyMerge(plan, aniToken(), request);
        } finally {
          merge = undefined;
          review = undefined;
        }
      }),
    cancelMerge() {
      if (!busy) merge = undefined;
    },
  };
}
