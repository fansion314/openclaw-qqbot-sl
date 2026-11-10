import { ImageLinks } from "./image-links.js";
let shared: { links: ImageLinks; users: number; ready: Promise<void> } | undefined;
/** Accounts share one loopback listener; the last stopped account releases it. */
export async function acquireImageLinks(
  path: string,
): Promise<{ links: ImageLinks; release(): Promise<void> }> {
  if (!shared) {
    const links = new ImageLinks({ path });
    shared = { links, users: 0, ready: links.start() };
  }
  const owner = shared;
  owner.users++;
  try {
    await owner.ready;
  } catch (error) {
    owner.users--;
    if (!owner.users) {
      shared = undefined;
      await owner.links.close();
    }
    throw error;
  }
  let released = false;
  return {
    links: owner.links,
    async release() {
      if (released) return;
      released = true;
      if (--owner.users === 0) {
        if (shared === owner) shared = undefined;
        await owner.links.close();
      }
    },
  };
}
