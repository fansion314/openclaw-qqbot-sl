/** Only native image URL fields are rewritten; prompts and arbitrary tool arguments are untouched. */
export function resolveImageToolParams(
  toolName: string,
  params: Record<string, unknown>,
  resolve: (url: string) => string | undefined,
): Record<string, unknown> | undefined {
  if (toolName !== "image" && toolName !== "view_image") return;
  let changed = false;
  const rewrite = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const original = resolve(value);
    if (original) {
      changed = true;
      return original;
    }
    return value;
  };
  const result = { ...params };
  if ("image" in result) result.image = rewrite(result.image);
  if (Array.isArray(result.images)) result.images = result.images.map(rewrite);
  if ("path" in result) result.path = rewrite(result.path);
  if (Array.isArray(result.paths)) result.paths = result.paths.map(rewrite);
  return changed ? result : undefined;
}
