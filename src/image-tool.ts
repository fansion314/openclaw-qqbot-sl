/** Only native image URL fields are rewritten; prompts and arbitrary tool arguments are untouched. */
export async function resolveImageToolParams(
  toolName: string,
  params: Record<string, unknown>,
  resolve: (url: string) => string | undefined | Promise<string | undefined>,
): Promise<Record<string, unknown> | undefined> {
  if (toolName !== "image" && toolName !== "view_image") return;
  let changed = false;
  const resolved = new Map<string, string | undefined>();
  const rewrite = async (value: unknown): Promise<unknown> => {
    if (typeof value !== "string") return value;
    if (!resolved.has(value)) resolved.set(value, await resolve(value));
    const original = resolved.get(value);
    if (original) {
      changed = true;
      return original;
    }
    return value;
  };
  const result = { ...params };
  for (const field of ["image", "path"]) {
    if (field in result) result[field] = await rewrite(result[field]);
  }
  for (const field of ["images", "paths"]) {
    const values = result[field];
    if (!Array.isArray(values)) continue;
    const images: unknown[] = [];
    for (const value of values) images.push(await rewrite(value));
    result[field] = images;
  }
  return changed ? result : undefined;
}
