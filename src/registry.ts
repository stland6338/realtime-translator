import { DurableObject } from "cloudflare:workers";
import type { Env } from "./translate";

export interface RoomInfo {
  name: string;
  connections: number;
  participants: { name: string; lang: string }[];
  updatedAt: number;
}

/**
 * 稼働中ルームの一覧を持つ単一の Durable Object。
 * 各 Room が接続数の変化を RPC で報告する。接続 0 になったルームは一覧から消える。
 */
export class Registry extends DurableObject<Env> {
  async report(info: RoomInfo): Promise<void> {
    if (info.connections > 0) await this.ctx.storage.put(`room:${info.name}`, info);
    else await this.ctx.storage.delete(`room:${info.name}`);
  }

  async list(): Promise<RoomInfo[]> {
    const map = await this.ctx.storage.list<RoomInfo>({ prefix: "room:" });
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
