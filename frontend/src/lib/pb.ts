import PocketBase from "pocketbase";

const PB_URL = process.env.NEXT_PUBLIC_PB_URL ?? "http://127.0.0.1:8090";

let _pb: PocketBase | null = null;

export function getPB(): PocketBase {
  if (!_pb) _pb = new PocketBase(PB_URL);
  return _pb;
}

export const pb = typeof window !== "undefined" ? getPB() : null!;

export { PB_URL };
