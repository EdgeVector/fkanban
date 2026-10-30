import type { NodeClient } from "./client.ts";

// This capability promises the existing native guarded batch on one owned
// schema. App benchmarks measure competing guarded writes before release.
export async function ownedCardBatchSupported(node: NodeClient): Promise<boolean> {
  const response = await node.rawCall("GET", "/api/version");
  const version = response.json as { capabilities?: Record<string, boolean> };
  return response.status === 200 && version?.capabilities?.atomic_owned_mutations_v1 === true;
}
