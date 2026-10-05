import { request } from "./anilist";
import {
  readMal,
  writeMal,
  type ListEntry,
  type MalRequest,
} from "./myanimelist";

async function readAni(token: string) {
  const { Viewer } = await request<{ Viewer: { id: number; name: string } }>(
    token,
    "query{Viewer{id name}}",
  );
  const { MediaListCollection } = await request<any>(
    token,
    "query($id:Int){MediaListCollection(userId:$id,type:ANIME){lists{entries{mediaId status progress repeat score(format:POINT_100) notes media{idMal title{romaji english} coverImage{large} episodes format}}}}}",
    { id: Viewer.id },
  );
  const entries: Record<string, ListEntry> = {};
  for (const list of MediaListCollection.lists ?? [])
    for (const row of list.entries ?? []) {
      entries[row.mediaId] = {
        mediaId: row.mediaId,
        malId: row.media.idMal ?? undefined,
        title: row.media.title.english || row.media.title.romaji,
        cover: row.media.coverImage.large,
        episodes: row.media.episodes,
        format: row.media.format,
        status: row.status,
        count: row.progress ?? 0,
        repeat: row.repeat ?? 0,
        score: row.score ?? 0,
        notes: row.notes ?? "",
      };
    }
  return { user: Viewer.name, entries };
}
function importFields(source: ListEntry, target?: ListEntry) {
  if (!target)
    return {
      status: source.status,
      count: source.count,
      repeat: source.repeat,
      score: source.score,
      notes: source.notes,
    };
  const fields: Partial<
    Pick<ListEntry, "status" | "count" | "repeat" | "score" | "notes">
  > = {};
  if (source.count > target.count) fields.count = source.count;
  if (source.repeat > target.repeat) fields.repeat = source.repeat;
  if (
    target.status !== "COMPLETED" &&
    source.count >= target.count &&
    source.repeat >= target.repeat &&
    (fields.count !== undefined ||
      fields.repeat !== undefined ||
      (source.status === "COMPLETED" && target.status !== "REPEATING") ||
      (target.status === "PLANNING" && source.status !== "PLANNING"))
  )
    fields.status = source.status;
  if (!target.score && source.score) fields.score = source.score;
  if (!target.notes && source.notes) fields.notes = source.notes;
  return fields;
}
export async function prepareMerge(token: string, mal: MalRequest) {
  const ani = await readAni(token),
    remote = await readMal(mal);
  const toAni = Object.values(remote.entries).filter(
    (row) =>
      Object.keys(importFields(row, ani.entries[row.mediaId])).length > 0,
  );
  const toMal = Object.values(ani.entries).filter(
    (row) =>
      row.malId &&
      (!remote.malIds.includes(row.malId) ||
        (remote.entries[row.mediaId] &&
          Object.keys(importFields(row, remote.entries[row.mediaId])).length >
            0)),
  );
  return {
    ani,
    remote,
    toAni,
    toMal,
    skipped: [
      ...remote.skipped,
      ...Object.values(ani.entries)
        .filter((row) => !row.malId)
        .map((row) => row.title),
    ],
  };
}
export type MergePlan = Awaited<ReturnType<typeof prepareMerge>>;
export function mergeSummary(plan: MergePlan) {
  return {
    anilistUser: plan.ani.user,
    malUser: plan.remote.user,
    toAniList: plan.toAni.map((row) => row.title),
    toMyAnimeList: plan.toMal.map((row) => row.title),
    skipped: plan.skipped,
  };
}
export async function applyMerge(
  plan: MergePlan,
  token: string,
  mal: MalRequest,
  progress?: (percent: number) => void,
) {
  // Read the destination again so an import cannot reduce progress seen after preview.
  const ani = await readAni(token),
    remote = await readMal(mal);
  if (ani.user !== plan.ani.user || remote.user !== plan.remote.user)
    throw Error("The connected account changed. Preview the migration again.");
  let addedAniList = 0,
    addedMyAnimeList = 0,
    updatedAniList = 0,
    updatedMyAnimeList = 0;
  let completed = 0;
  const total = plan.toAni.length + plan.toMal.length;
  const advance = () =>
    progress?.(total ? Math.floor((++completed / total) * 100) : 100);
  progress?.(0);
  try {
    for (const row of plan.toAni) {
      const target = ani.entries[row.mediaId];
      const fields = importFields(row, target);
      if (Object.keys(fields).length) {
        await request(
          token,
          "mutation($id:Int,$status:MediaListStatus,$count:Int,$repeat:Int,$score:Int,$notes:String){SaveMediaListEntry(mediaId:$id,status:$status,progress:$count,repeat:$repeat,scoreRaw:$score,notes:$notes){id}}",
          {
            id: row.mediaId,
            status: fields.status ?? target?.status,
            count: fields.count ?? target?.count,
            repeat: fields.repeat ?? target?.repeat,
            score: fields.score ?? target?.score,
            notes: fields.notes ?? target?.notes,
          },
        );
        if (target) updatedAniList++;
        else addedAniList++;
      }
      advance();
    }
    for (const row of plan.toMal) {
      const target = remote.entries[row.mediaId];
      if (!target && remote.malIds.includes(row.malId!)) {
        advance();
        continue;
      }
      const fields = importFields(row, target);
      if (Object.keys(fields).length) {
        await writeMal(mal, row.mediaId, fields);
        if (target) updatedMyAnimeList++;
        else addedMyAnimeList++;
      }
      advance();
    }
    progress?.(100);
    return {
      addedAniList,
      addedMyAnimeList,
      updatedAniList,
      updatedMyAnimeList,
    };
  } catch (error) {
    throw Error(
      `Import stopped after adding ${addedAniList + addedMyAnimeList} entries and updating ${updatedAniList + updatedMyAnimeList}. Try the import again to continue. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
