/** Short labels are safe both in XML attributes and in the agent's collection. */
export function validateStickerId(value: string): string {
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(value))
    throw new Error("Sticker ID must contain 1–32 letters, numbers, underscores or hyphens");
  return value;
}
